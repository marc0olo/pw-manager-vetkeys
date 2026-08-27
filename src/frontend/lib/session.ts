/**
 * Persisted session lifetime.
 *
 * The idle timer inside the page dies with the page, so on its own it says
 * nothing about how long the app was *closed*. This module records when the user
 * was last active and lets the next page load decide whether the session is
 * still alive — which is what makes one configurable timeout govern both cases.
 *
 * Why a deadline checked on load rather than clearing on close: there is no
 * reliable "the app was closed" hook. `pagehide`/`beforeunload` do not run on a
 * crash, a force-quit or an OS kill, so anything that relies on them can leave
 * credentials behind exactly when it matters. Worse, they also fire on an
 * ordinary reload, so clearing there would force a fresh passkey on every
 * refresh and throw away the key-material cache. A stored deadline needs no
 * cooperation from the shutdown path: whatever killed the app, the next load
 * refuses and purges.
 */

const ACTIVITY_KEY = "vetvault:last-active";
const PRINCIPAL_KEY = "vetvault:principal";

/** Key-material stores are namespaced per principal under this prefix. */
const KEY_CACHE_PREFIX = "vetvault-keys-";

export function keyCacheName(principal: string): string {
  return `${KEY_CACHE_PREFIX}${principal}`;
}

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // Storage can throw in private modes; treat as "no session recorded".
    return null;
  }
}

/** Stamp the session as alive. Cheap enough to call from an event handler. */
export function markActive(principal?: string): void {
  try {
    window.localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    if (principal) window.localStorage.setItem(PRINCIPAL_KEY, principal);
  } catch {
    // Non-fatal: without the mark the next load treats the session as expired,
    // which fails closed.
  }
}

export function clearActivity(): void {
  try {
    window.localStorage.removeItem(ACTIVITY_KEY);
    window.localStorage.removeItem(PRINCIPAL_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * How long since the last recorded activity, or null if nothing is recorded.
 *
 * Null means "no session was left running" — not "fresh". Callers must not treat
 * it as within the timeout.
 */
export function idleElapsedMs(): number | null {
  const lastActive = readNumber(ACTIVITY_KEY);
  if (lastActive === null) return null;
  // A clock moved backwards would otherwise read as "just active".
  return Math.max(0, Date.now() - lastActive);
}

function storedPrincipal(): string | null {
  try {
    return window.localStorage.getItem(PRINCIPAL_KEY);
  } catch {
    return null;
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.deleteDatabase(name);
      // Resolve on every outcome: a purge must never block sign-in. `blocked`
      // fires when another tab holds the store open; that tab's own load will
      // have purged it too.
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Delete every derived-key-material store this app owns.
 *
 * Enumerates when the browser supports it so a store left by a principal we no
 * longer know about is still removed; falls back to the last recorded principal.
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

/** Events that count as the user being present. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;

/** No more than one write per this interval, so listeners stay cheap. */
const MARK_THROTTLE_MS = 15_000;

/**
 * Keep the activity mark fresh while the vault is unlocked. Returns a teardown
 * function; call it on lock so a locked app stops looking alive.
 */
export function trackActivity(principal: string): () => void {
  let last = 0;
  const mark = () => {
    const now = Date.now();
    if (now - last < MARK_THROTTLE_MS) return;
    last = now;
    markActive(principal);
  };

  // Write immediately so a session is recorded from the moment it opens.
  markActive(principal);

  const onHide = () => markActive(principal);
  for (const event of ACTIVITY_EVENTS) window.addEventListener(event, mark, { passive: true });
  // Best-effort freshening as the page goes away, so a close is timed from when
  // the user actually left rather than from the last throttled write. The
  // deadline stands on its own if this never runs.
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onHide);

  return () => {
    for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, mark);
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onHide);
  };
}
