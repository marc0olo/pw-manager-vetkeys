import { describe, expect, it, vi } from "vitest";
import { lockVault } from "../lock";
import type { LockReason } from "../auth";
import type { RunningSession } from "../session";

/**
 * The lock sequence: ordering, the cross-tab guard, and that no step is skipped
 * when another fails. Both defects found in review round 2 lived here.
 */

/** Records the order in which steps run, and lets async steps be held open. */
function harness({
  clearVaultKeysRejects = false,
  endSessionRejects = false,
}: { clearVaultKeysRejects?: boolean; endSessionRejects?: boolean } = {}) {
  const order: string[] = [];
  let releaseClear: () => void = () => {};
  const clearStarted = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });

  const session: RunningSession = {
    stop: vi.fn(() => void order.push("stop")),
    broadcastLock: vi.fn(() => void order.push("broadcast")),
    remainingMs: vi.fn(() => 0),
  };

  const steps = {
    resetUi: vi.fn((reason: LockReason) => void order.push(`resetUi:${reason}`)),
    clearVaultKeys: vi.fn(async () => {
      order.push("clearVaultKeys");
      releaseClear();
      await Promise.resolve();
      if (clearVaultKeysRejects) throw new Error("cache unavailable");
    }),
    endSession: vi.fn(async () => {
      order.push("endSession");
      await Promise.resolve();
      if (endSessionRejects) throw new Error("storage unavailable");
    }),
  };

  return { order, session, steps, clearStarted };
}

describe("lockVault", () => {
  it("runs every step, in order", async () => {
    const { order, session, steps } = harness();

    await lockVault("manual", session, steps);

    expect(order).toEqual(["resetUi:manual", "stop", "broadcast", "clearVaultKeys", "endSession"]);
  });

  // The round-2 finding: state was cleared only after the awaits resolved, so a
  // save landing mid-purge could re-create the key store after the delete.
  it("resets the UI before any async step begins", async () => {
    const { order, session, steps, clearStarted } = harness();

    const pending = lockVault("manual", session, steps);
    await clearStarted; // the first async step has started

    expect(order.indexOf("resetUi:manual")).toBeLessThan(order.indexOf("clearVaultKeys"));
    expect(steps.resetUi).toHaveBeenCalledTimes(1);

    await pending;
  });

  it("stops the session before ending it", async () => {
    const { order, session, steps } = harness();
    await lockVault("idle", session, steps);
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("endSession"));
  });

  describe("cross-tab guard", () => {
    it.each<LockReason>(["manual", "idle", "expired"])("broadcasts for %s", async (reason) => {
      const { session, steps } = harness();
      await lockVault(reason, session, steps);
      expect(session.broadcastLock).toHaveBeenCalledTimes(1);
    });

    // Rebroadcasting a lock that came from another tab would ping-pong between
    // them indefinitely.
    it("does not rebroadcast a lock that came from another tab", async () => {
      const { session, steps } = harness();

      await lockVault("elsewhere", session, steps);

      expect(session.broadcastLock).not.toHaveBeenCalled();
      // ...but the local teardown still happens in full.
      expect(session.stop).toHaveBeenCalledTimes(1);
      expect(steps.resetUi).toHaveBeenCalledWith("elsewhere");
      expect(steps.clearVaultKeys).toHaveBeenCalledTimes(1);
      expect(steps.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("failure safety", () => {
    it("still ends the session when clearing the key cache throws", async () => {
      const { order, session, steps } = harness({ clearVaultKeysRejects: true });

      await expect(lockVault("manual", session, steps)).resolves.toBeUndefined();

      expect(steps.endSession).toHaveBeenCalledTimes(1);
      expect(order).toContain("endSession");
    });

    it("does not reject when ending the session throws", async () => {
      const { session, steps } = harness({ endSessionRejects: true });

      // Terminal operation: rethrowing would only produce an unhandled rejection.
      await expect(lockVault("manual", session, steps)).resolves.toBeUndefined();

      expect(steps.resetUi).toHaveBeenCalledTimes(1);
      expect(session.stop).toHaveBeenCalledTimes(1);
    });

    it("locks the UI even when both async steps throw", async () => {
      const { session, steps } = harness({ clearVaultKeysRejects: true, endSessionRejects: true });

      await expect(lockVault("expired", session, steps)).resolves.toBeUndefined();

      expect(steps.resetUi).toHaveBeenCalledWith("expired");
      expect(steps.clearVaultKeys).toHaveBeenCalledTimes(1);
      expect(steps.endSession).toHaveBeenCalledTimes(1);
    });
  });

  // resumeSession refuses before a session exists, so lock() can be reached with
  // nothing to tear down.
  it("works with no running session", async () => {
    const { order, steps } = harness();

    await expect(lockVault("expired", null, steps)).resolves.toBeUndefined();

    expect(order).toEqual(["resetUi:expired", "clearVaultKeys", "endSession"]);
  });
});
