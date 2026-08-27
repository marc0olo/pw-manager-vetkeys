/**
 * Session lifetime: one activity definition, one timeout, both halves.
 *
 * This module owns the idle policy outright rather than delegating to
 * `@icp-sdk/auth`'s `IdleManager`, for three reasons found the hard way:
 *
 * 1. `AuthClient.idleManager` is only assigned inside `signIn()` and the async
 *    `#hydrate()`, i.e. after the constructor returns — so a callback registered
 *    at construction time is silently dropped and nothing ever locks.
 * 2. `IdleManager` is single-shot: `exit()` clears its own singleton after
 *    firing, and `signIn()` only recreates it when `idleManager` is falsy, which
 *    it no longer is. A second sign-in in one page load would get no timer.
 * 3. It listened on its own set of DOM events while this module listened on
 *    another, so the in-page timeout and the persisted mark could disagree about
 *    what "active" means.
 *
 * The page timer and the persisted mark are now fed by the *same* handler, so
 * the open-tab and closed-tab halves of the timeout cannot diverge.
 */

/**
 * How long an unlocked vault stays unlocked. The only two numbers to change; the
 * lock-screen wording derives from them.
 *
 * `idleMinutes` covers **both** cases: the app auto-locks after this much
 * inactivity while open, and a session left closed for longer is refused on the
 * next load, with the delegation and cached vault keys purged together.
 *
 * `delegationHours` is only a ceiling: the delegation cannot outlive it even
 * with continuous use, so it bounds a stolen delegation regardless of the idle
 * policy.
 */
export const SESSION_POLICY = {
  idleMinutes: 5,
  delegationHours: 8,
} as const;

export const IDLE_TIMEOUT_MS = SESSION_POLICY.idleMinutes * 60_000;
export const IDLE_TIMEOUT_LABEL = `${SESSION_POLICY.idleMinutes} minutes`;

/**
 * How far the clock may move **backwards** before a timestamp is treated as
 * untrustworthy rather than merely skewed.
 *
 * Only the backwards direction needs a guard. A forward jump makes the measured
 * age larger, so it locks sooner or refuses a resume — already the safe
 * direction. A backwards jump makes a stale session look recent, which is the
 * one reading that fails open.
 *
 * The tolerance exists so the guard is not its own bug: NTP corrections and
 * resume-from-sleep step a device's clock by a small amount, and locking someone
 * out over a few hundred milliseconds of skew would be worse than the hole. A
 * larger jump is either deliberate or a clock wrong enough that the honest answer
 * is "this session cannot be vouched for".
 */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

const ACTIVITY_KEY = "vetvault:last-active";
const PRINCIPAL_KEY = "vetvault:principal";

/** Key-material stores are namespaced per principal under this prefix. */
const KEY_CACHE_PREFIX = "vetvault-keys-";

export function keyCacheName(principal: string): string {
  return `${KEY_CACHE_PREFIX}${principal}`;
}

// ---------------------------------------------------------------------------
// The persisted mark
// ---------------------------------------------------------------------------

function writeMark(at: number, principal: string): void {
  try {
    window.localStorage.setItem(ACTIVITY_KEY, String(at));
    window.localStorage.setItem(PRINCIPAL_KEY, principal);
  } catch {
    // Non-fatal: without the mark the next load treats the session as expired,
    // which fails closed.
  }
}

/** Stamp the session as alive as of now. */
export function markActive(principal: string): void {
  writeMark(Date.now(), principal);
}

export function clearActivity(): void {
  try {
    window.localStorage.removeItem(ACTIVITY_KEY);
    window.localStorage.removeItem(PRINCIPAL_KEY);
  } catch {
    /* nothing to do */
  }
}

export function storedPrincipal(): string | null {
  try {
    return window.localStorage.getItem(PRINCIPAL_KEY);
  } catch {
    return null;
  }
}

/**
 * How long since the last recorded activity, or null if nothing is recorded.
 *
 * Null means "no session was left running" — not "fresh". Callers must not treat
 * it as within the timeout.
 */
export function idleElapsedMs(): number | null {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_KEY);
    const at = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(at)) return null;

    const elapsed = Date.now() - at;
    // A mark in the future means the clock moved backwards since it was written,
    // so the age of this session is unknowable. Returning null refuses it;
    // clamping to 0 would report "just active" and resume a session that may be
    // hours stale — fail-open, in the one function everything else trusts.
    if (elapsed < -CLOCK_SKEW_TOLERANCE_MS) return null;
    return Math.max(0, elapsed);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Purging cached key material
// ---------------------------------------------------------------------------

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.deleteDatabase(name);
      // Resolve on every outcome: a purge must never block sign-in.
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // `blocked` means another connection still holds the store open. The delete
      // is queued and completes when that connection closes, so the store does go
      // away — just not before this resolves. Note that @icp-sdk/auth can leak a
      // duplicate connection to its *own* store on concurrent first access
      // (dfinity/icp-js-auth#137, merged but unreleased as of 8.0.3 — see issue #6); that store
      // is not one of ours, so it cannot block these deletes.
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Delete every derived-key-material store this app owns.
 *
 * Enumerates where supported, so a store left by a principal no longer recorded
 * is still removed. `indexedDB.databases()` is **not implemented in Firefox**,
 * where this degrades to deleting the last recorded principal's store only.
 */
export async function purgeKeyMaterial(): Promise<void> {
  const names = new Set<string>();

  try {
    const databases = await window.indexedDB.databases?.();
    for (const { name } of databases ?? []) {
      if (name?.startsWith(KEY_CACHE_PREFIX)) names.add(name);
    }
  } catch {
    /* enumeration unsupported — fall through to the recorded principal */
  }

  const principal = storedPrincipal();
  if (principal) names.add(keyCacheName(principal));

  await Promise.all([...names].map(deleteDatabase));
}

// ---------------------------------------------------------------------------
// Running session: idle timer, activity mark, cross-tab locking
// ---------------------------------------------------------------------------

/** What counts as the user being present. One list, used for both halves. */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "scroll",
  "touchstart",
] as const;

/** At most one localStorage write per this interval. */
const MARK_THROTTLE_MS = 15_000;

/**
 * How often the idle deadline is re-checked against the wall clock.
 *
 * The check is a comparison against `Date.now()`, not a `setTimeout` that is
 * expected to fire on time: timers do not run while a page is frozen or the
 * machine is asleep, and on resume a pending timeout keeps its *original*
 * remaining delay. A lid closed for an hour would otherwise reopen on a
 * decrypted vault with minutes still to run — the same "a timer cannot measure
 * time it did not run for" failure this module fixes for the closed case.
 *
 * Worst-case overshoot is one interval, and browsers throttle timers in
 * background tabs, so the visibility handler also checks on return to make the
 * lock immediate whenever the user is actually looking.
 */
export const IDLE_CHECK_INTERVAL_MS = 15_000;

const LOCK_CHANNEL = "vetvault:session";

/** Told to other tabs so locking anywhere locks everywhere. */
export type SessionSignal = "locked";

export interface RunningSession {
  /** Tear down listeners and the timer. Call on lock. */
  stop: () => void;
  /** Tell other tabs of this origin to lock too. */
  broadcastLock: () => void;
}

/**
 * Start tracking a live session.
 *
 * `onIdle` fires once, after {@link IDLE_TIMEOUT_MS} without activity.
 * `onRemoteLock` fires when another tab locks. Both are one-shot per session:
 * the caller locks, which calls `stop()`, and the next sign-in starts a fresh
 * session — so unlike the library's singleton this re-arms correctly.
 */
export function startSession(
  principal: string,
  { onIdle, onRemoteLock }: { onIdle: () => void; onRemoteLock: () => void },
): RunningSession {
  let lastActivity = Date.now();
  let lastWrite = 0;
  let stopped = false;
  let fired = false;

  writeMark(lastActivity, principal);

  /** Lock if the wall clock says the deadline has passed. Fires at most once. */
  const checkDeadline = () => {
    if (stopped || fired) return;
    const elapsed = Date.now() - lastActivity;
    // Past the deadline, or the clock moved backwards under us so the deadline
    // can no longer be measured. Both lock; waiting out an unmeasurable deadline
    // is the fail-open answer.
    if (elapsed < IDLE_TIMEOUT_MS && elapsed >= -CLOCK_SKEW_TOLERANCE_MS) return;
    fired = true;
    onIdle();
  };

  const ticker = setInterval(checkDeadline, IDLE_CHECK_INTERVAL_MS);

  const onActivity = () => {
    if (stopped || fired) return;
    const now = Date.now();
    lastActivity = now;
    // Throttle only the write. The mark is therefore at most MARK_THROTTLE_MS
    // stale, and `flush` below makes it exact when the page goes away.
    if (now - lastWrite >= MARK_THROTTLE_MS) {
      lastWrite = now;
      writeMark(now, principal);
    }
  };

  /**
   * Persist the *real* last activity as the page goes away.
   *
   * Deliberately not `Date.now()`: the page being hidden or unloaded is not
   * evidence the user is present, and stamping it there would extend the closed
   * half of the window by up to a full timeout on top of the open half.
   */
  const flush = () => {
    if (!stopped) writeMark(lastActivity, principal);
  };

  const onVisibilityChange = () => {
    if (stopped) return;
    if (document.visibilityState === "visible") {
      // Back in view, possibly after a freeze or a suspend that paused timers.
      checkDeadline();
    } else {
      flush();
    }
  };

  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(LOCK_CHANNEL);
    channel.onmessage = (event: MessageEvent<SessionSignal>) => {
      if (!stopped && event.data === "locked") onRemoteLock();
    };
  } catch {
    // No BroadcastChannel: other tabs lock on their own schedule instead.
  }

  for (const event of ACTIVITY_EVENTS) {
    window.addEventListener(event, onActivity, { passive: true, capture: true });
  }
  window.addEventListener("pagehide", flush);
  // Symmetric counterpart: a bfcache restore does not always fire
  // visibilitychange, and the poll would otherwise take up to one interval.
  window.addEventListener("pageshow", checkDeadline);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    stop: () => {
      stopped = true;
      clearInterval(ticker);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity, { capture: true });
      }
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("pageshow", checkDeadline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      channel?.close();
    },
    broadcastLock: () => {
      try {
        // A fresh channel: ours may already be closed by `stop()`.
        const notifier = new BroadcastChannel(LOCK_CHANNEL);
        notifier.postMessage("locked" satisfies SessionSignal);
        notifier.close();
      } catch {
        /* nothing to do */
      }
    },
  };
}
