import type { LockReason } from "./auth";
import type { RunningSession } from "./session";

/**
 * The steps of a lock, injected so the sequence can be tested without a UI.
 *
 * Nothing here is React-specific: what matters is the order, and that every step
 * runs even if an earlier one fails.
 */
export interface LockSteps {
  /** Take the UI out of the unlocked state. Synchronous by contract. */
  resetUi: (reason: LockReason) => void;
  /** Clear the derived-key cache — `VaultClient.lock()`. */
  clearVaultKeys: () => Promise<void>;
  /** Purge key stores, drop the delegation, clear the activity mark. */
  endSession: () => Promise<void>;
}

/**
 * The single way out of an unlocked vault.
 *
 * Order is the invariant:
 *
 * 1. **Reset the UI first.** Everything after this awaits, and a save landing
 *    mid-teardown would re-create the key store after it was deleted — with the
 *    recorded principal already gone, Firefox (no `indexedDB.databases()`) could
 *    not find the orphan later.
 * 2. Stop the session's listeners and idle poll, so a locked tab stops looking
 *    alive to the next page load.
 * 3. Tell other tabs — unless this lock *came* from another tab, which would
 *    bounce the message back and forth.
 * 4. Drop the cached vault keys, then 5. end the session.
 *
 * Steps 4 and 5 are independent: a failure in either must not skip the other, and
 * neither must skip the UI reset. Failures are swallowed rather than rethrown —
 * this is the terminal operation, the UI is already locked, and there is nothing
 * a caller could do except produce an unhandled rejection.
 */
export async function lockVault(
  reason: LockReason,
  session: RunningSession | null,
  { resetUi, clearVaultKeys, endSession }: LockSteps,
): Promise<void> {
  resetUi(reason);

  session?.stop();
  if (reason !== "elsewhere") session?.broadcastLock();

  try {
    await clearVaultKeys();
  } catch {
    // endSession() deletes the whole store anyway.
  }
  try {
    await endSession();
  } catch {
    // Already locked; nothing further to do.
  }
}
