import { reconcile } from "./reconcile";
import { defaultVaultId, vaultId, type VaultSummary } from "./vault";
import type { VaultSessionState } from "./vault-session";

export interface PollOutcome {
  /** Everything the poll changes, as one patch. */
  patch: Partial<VaultSessionState>;
  /** Something disappeared under the user. Shown as a toast. */
  notice: string | null;
  /** The poll moved the user off the vault they were on. */
  movedVault: boolean;
  /**
   * The open trash dialog is showing a stale list and must be re-read.
   *
   * Separate from the patch because the list is ciphertext the poll does not
   * carry: the summary's fingerprint says whether it changed, and only then
   * does anything fetch it (#14). Without this, a second person deleting an
   * item leaves the first person's open dialog wrong until they close it.
   */
  refreshTrash: boolean;
}

/**
 * What a poll changes, decided in one place.
 *
 * This exists because #16 was a *wiring* bug, not a logic one: `reconcile` was
 * correct, and the component fed it a selection that did not match the vault on
 * screen. Nothing could catch that, because the only untested layer was the one
 * doing the deciding. Keeping the decision here — pure, over the same state the
 * component holds — means the next mistake of that shape fails a test.
 *
 * Returned as a single patch on purpose. Applying the list, then the selection,
 * then the items left renders where a new vault list was paired with the old
 * selection.
 */
export function pollUpdate(
  before: VaultSessionState,
  next: VaultSummary[],
  now: number,
): PollOutcome {
  const outcome = reconcile({
    previous: before.vaults ?? [],
    next,
    selection: { vaultId: before.selectedVaultId, itemId: before.selectedItemId },
    openItems: before.openItems,
  });

  // Compared against the vault that was on *screen*, which is not the same as
  // `selectedVaultId` while a selection is still implicit. Resolving null to
  // the vault the user was already looking at is not a move, and reporting it
  // as one would clear an error banner that still applies.
  const wasOn = before.selectedVaultId ?? defaultVaultId(before.vaults ?? []);
  const itemChanged = outcome.selection.itemId !== before.selectedItemId;

  // Compared on the vault that stays selected, and only while the dialog is
  // open — `trash` is null when it is closed, and re-reading then would fetch
  // ciphertext nobody is looking at.
  const staying = outcome.selection.vaultId;
  const fingerprintOf = (vaults: VaultSummary[]) =>
    vaults.find((vault) => vaultId(vault) === staying)?.trashFingerprint;
  const refreshTrash =
    before.trash !== null && fingerprintOf(next) !== fingerprintOf(before.vaults ?? []);
  return {
    patch: {
      vaults: next,
      syncedAt: now,
      selectedVaultId: outcome.selection.vaultId,
      selectedItemId: outcome.selection.itemId,
      // Whatever was on screen is gone; do not leave an editor open on it.
      ...(itemChanged ? { pane: { mode: "view" as const } } : {}),
      ...(outcome.refreshItems ? { openItems: null } : {}),
    },
    notice: outcome.notice,
    movedVault: outcome.selection.vaultId !== wasOn,
    refreshTrash,
  };
}
