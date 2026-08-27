import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_CHECK_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  idleElapsedMs,
  keyCacheName,
  markActive,
  purgeKeyMaterial,
  startSession,
  storedPrincipal,
} from "../session";

const PRINCIPAL = "aaaaa-bbbbb-ccccc-ddddd-cai";
const OTHER = "zzzzz-yyyyy-xxxxx-wwwww-cai";

function activity(type = "pointerdown") {
  // The listeners are registered with `capture: true` on window, so an event
  // dispatched at the window is what they see.
  window.dispatchEvent(new Event(type));
}

function openDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("k");
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name!).sort();
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("idle timeout (open tab)", () => {
  // The regression that motivated owning the timer: with the library's
  // IdleManager, `AuthClient.idleManager` is undefined at construction, so the
  // callback was never registered and nothing ever locked.
  it("fires onIdle after the timeout with no activity", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    // Checked on an interval, so allow one tick of grain either side rather than
    // depending on IDLE_TIMEOUT_MS being an exact multiple of it.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - IDLE_CHECK_INTERVAL_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(IDLE_CHECK_INTERVAL_MS + 1);
    expect(onIdle).toHaveBeenCalledTimes(1);

    session.stop();
  });

  it("re-arms on activity, so an active user is never locked out", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    // Interact every minute for three times the timeout.
    for (let minute = 0; minute < IDLE_TIMEOUT_MS * 3; minute += 60_000) {
      vi.advanceTimersByTime(60_000);
      activity();
    }
    expect(onIdle).not.toHaveBeenCalled();

    // Then stop interacting.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + IDLE_CHECK_INTERVAL_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);

    session.stop();
  });

  it("fires only once, and never after stop()", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + IDLE_CHECK_INTERVAL_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);

    session.stop();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 5);
    activity();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  // IdleManager.exit() cleared its own singleton, so a second sign-in in one
  // page load silently got no timer at all.
  it("re-arms for a fresh session after the previous one locked", () => {
    const first = vi.fn();
    const one = startSession(PRINCIPAL, { onIdle: first, onRemoteLock: vi.fn() });
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + IDLE_CHECK_INTERVAL_MS);
    one.stop();
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const two = startSession(PRINCIPAL, { onIdle: second, onRemoteLock: vi.fn() });
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + IDLE_CHECK_INTERVAL_MS);
    expect(second).toHaveBeenCalledTimes(1);
    two.stop();
  });

  // A setTimeout cannot measure time it did not run for. Timers are paused while
  // a page is frozen or the machine is asleep, and on resume a pending timeout
  // keeps its ORIGINAL remaining delay — so a lid closed for an hour would
  // reopen on a decrypted vault with minutes still to run. The deadline is
  // therefore compared against the wall clock, not awaited.
  it("locks after a suspend that paused timers", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    // Machine sleeps for an hour: wall clock advances, timers do not run.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect(onIdle).not.toHaveBeenCalled(); // nothing has ticked yet

    // The very first tick after resume must lock, not wait out the old delay.
    vi.advanceTimersByTime(IDLE_CHECK_INTERVAL_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);

    session.stop();
  });

  it("locks immediately on return to visibility after a suspend", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    vi.setSystemTime(Date.now() + 60 * 60_000);
    // No timer tick at all — the user simply switches back to the tab.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onIdle).toHaveBeenCalledTimes(1);

    session.stop();
  });

  it("does not lock on return to visibility while still inside the window", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    vi.setSystemTime(Date.now() + 60_000); // one minute, well inside 5
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onIdle).not.toHaveBeenCalled();

    session.stop();
  });

  // The live half used to compute a negative elapsed time and simply wait, so a
  // backwards jump meant the vault never locked at all.
  it("locks when the clock moves backwards under a running session", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    vi.setSystemTime(Date.now() - 60 * 60_000);
    vi.advanceTimersByTime(IDLE_CHECK_INTERVAL_MS);

    expect(onIdle).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("does not lock on clock skew within tolerance", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    vi.setSystemTime(Date.now() - 5_000);
    // Drive the check WITHOUT advancing timers. Advancing by a poll interval
    // would carry elapsed back above zero before the tick fired, so the negative
    // branch would never be exercised and this test would pass for the wrong
    // reason — the tolerance could be deleted and nothing would notice.
    window.dispatchEvent(new Event("pageshow"));

    expect(onIdle).not.toHaveBeenCalled();
    session.stop();
  });

  it("checks the deadline on a bfcache restore (pageshow)", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });

    vi.setSystemTime(Date.now() + 60 * 60_000);
    window.dispatchEvent(new Event("pageshow")); // no timer tick at all
    expect(onIdle).toHaveBeenCalledTimes(1);

    session.stop();
  });

  it("ignores events after stop() when a listener would otherwise re-arm", () => {
    const onIdle = vi.fn();
    const session = startSession(PRINCIPAL, { onIdle, onRemoteLock: vi.fn() });
    session.stop();

    activity();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("the persisted mark (closed tab)", () => {
  it("records the principal and a fresh timestamp on start", () => {
    const session = startSession(PRINCIPAL, { onIdle: vi.fn(), onRemoteLock: vi.fn() });
    expect(storedPrincipal()).toBe(PRINCIPAL);
    expect(idleElapsedMs()).toBe(0);
    session.stop();
  });

  // The bug: pagehide/visibilitychange used to stamp Date.now(), so a browser
  // quit re-marked an absent user as present and the real bound became
  // 2 x idleMinutes rather than idleMinutes.
  it("flushes the last real activity on pagehide, not the time of the event", () => {
    const session = startSession(PRINCIPAL, { onIdle: vi.fn(), onRemoteLock: vi.fn() });

    activity(); // last real interaction is now
    const interactedAt = Date.now();

    // User walks away; the page is hidden and then unloaded much later.
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));

    // The mark must still point at the interaction, not at the unload.
    const elapsed = idleElapsedMs()!;
    expect(elapsed).toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS - 1_000);
    expect(Date.now() - elapsed).toBe(interactedAt);

    session.stop();
  });

  it("keeps the mark at most one throttle interval stale while active", () => {
    const session = startSession(PRINCIPAL, { onIdle: vi.fn(), onRemoteLock: vi.fn() });

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(20_000); // longer than the 15s write throttle
      activity();
    }
    expect(idleElapsedMs()).toBeLessThanOrEqual(15_000);

    session.stop();
  });

  it("treats a missing mark as no session rather than as fresh", () => {
    window.localStorage.clear();
    expect(idleElapsedMs()).toBeNull();
  });

  it("treats a corrupt mark as no session", () => {
    window.localStorage.setItem("vetvault:last-active", "not-a-number");
    expect(idleElapsedMs()).toBeNull();
  });

  it("tolerates small clock skew rather than logging the user out", () => {
    // NTP corrections and resume-from-sleep step the clock a little; that must
    // not end the session.
    markActive(PRINCIPAL);
    vi.setSystemTime(Date.now() - 5_000);
    expect(idleElapsedMs()).toBe(0);
  });

  // The load-time half used to clamp a future mark to 0, i.e. report "just
  // active" for a session that could be hours stale — fail-open in the one
  // function every other decision trusts.
  it("refuses a mark from the future beyond tolerable skew", () => {
    markActive(PRINCIPAL);
    vi.setSystemTime(Date.now() - 20 * 60_000);
    expect(idleElapsedMs()).toBeNull();
  });

  it("refuses a session whose mark was already stale before a backwards jump", () => {
    markActive(PRINCIPAL);
    vi.setSystemTime(Date.now() + 10 * 60_000); // now genuinely stale
    expect(idleElapsedMs()).toBeGreaterThan(IDLE_TIMEOUT_MS);

    vi.setSystemTime(Date.now() - 20 * 60_000); // clock wound back past the mark
    expect(idleElapsedMs()).toBeNull(); // not 0 — staleness is unknowable, so refuse
  });
});

describe("cross-tab locking", () => {
  it("notifies another session when one broadcasts a lock", async () => {
    const onRemoteLock = vi.fn();
    const listener = startSession(PRINCIPAL, { onIdle: vi.fn(), onRemoteLock });
    const locker = startSession(PRINCIPAL, { onIdle: vi.fn(), onRemoteLock: vi.fn() });

    locker.broadcastLock();

    // BroadcastChannel delivery is a macrotask; fake timers do not drive it.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onRemoteLock).toHaveBeenCalled();

    listener.stop();
    locker.stop();
  });

  it("does not notify a session that has stopped", async () => {
    const onRemoteLock = vi.fn();
    const stopped = startSession(PRINCIPAL, { onIdle: vi.fn(), onRemoteLock });
    stopped.stop();

    const locker = startSession(PRINCIPAL, { onIdle: vi.fn(), onRemoteLock: vi.fn() });
    locker.broadcastLock();

    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onRemoteLock).not.toHaveBeenCalled();
    locker.stop();
  });
});

describe("purgeKeyMaterial", () => {
  it("deletes every namespaced key store, including unrecorded principals", async () => {
    vi.useRealTimers();
    await openDatabase(keyCacheName(PRINCIPAL));
    await openDatabase(keyCacheName(OTHER));
    await openDatabase("something-else"); // must survive
    markActive(PRINCIPAL);

    expect(await databaseNames()).toContain(keyCacheName(OTHER));

    await purgeKeyMaterial();

    const remaining = await databaseNames();
    expect(remaining).not.toContain(keyCacheName(PRINCIPAL));
    expect(remaining).not.toContain(keyCacheName(OTHER));
    expect(remaining).toContain("something-else");
  });

  it("falls back to the recorded principal when enumeration is unavailable", async () => {
    vi.useRealTimers();
    await openDatabase(keyCacheName(PRINCIPAL));
    markActive(PRINCIPAL);

    // Firefox has no indexedDB.databases().
    const databases = indexedDB.databases;
    (indexedDB as { databases?: unknown }).databases = undefined;
    try {
      await purgeKeyMaterial();
    } finally {
      (indexedDB as { databases?: unknown }).databases = databases;
    }

    expect(await databaseNames()).not.toContain(keyCacheName(PRINCIPAL));
  });

  it("resolves rather than throwing when there is nothing to delete", async () => {
    vi.useRealTimers();
    window.localStorage.clear();
    await expect(purgeKeyMaterial()).resolves.toBeUndefined();
  });
});
