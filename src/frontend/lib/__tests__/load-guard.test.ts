import { describe, expect, it } from "vitest";
import { createLoadGuard } from "../vault-session";

/**
 * The rule that keeps a lock from being undone by a request that was already on
 * the wire when it happened.
 */
describe("createLoadGuard", () => {
  it("lets the only load in flight write", () => {
    const guard = createLoadGuard();
    expect(guard.begin()()).toBe(true);
  });

  it("drops a load that a newer one overtook", () => {
    const guard = createLoadGuard();
    const first = guard.begin();
    const second = guard.begin();
    // A slow poll must not overwrite the result of one that started later.
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("drops a load that was in flight when the vault locked", () => {
    const guard = createLoadGuard();
    const inFlight = guard.begin();
    expect(inFlight()).toBe(true);

    guard.invalidate(); // the lock

    // Without this the poll's result would land in the state the lock cleared,
    // restoring the previous session's vault names, owners and share lists.
    expect(inFlight()).toBe(false);
  });

  it("lets the next session load normally after a lock", () => {
    const guard = createLoadGuard();
    guard.begin();
    guard.invalidate();
    expect(guard.begin()()).toBe(true);
  });

  it("keeps refusing a stale load however often it asks", () => {
    const guard = createLoadGuard();
    const stale = guard.begin();
    guard.invalidate();
    expect(stale()).toBe(false);
    expect(stale()).toBe(false);
  });

  it("keeps two guards independent", () => {
    const a = createLoadGuard();
    const b = createLoadGuard();
    const load = a.begin();
    b.invalidate();
    expect(load()).toBe(true);
  });
});
