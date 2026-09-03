import { reconcile } from "./reconcile";
import { accessLevel, defaultVaultId, vaultId, type VaultSummary } from "./vault";
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
  /**
   * Whether anything a user could see actually moved.
   *
   * For a *manual* check, which needs to say something even when the answer is
   * "nothing". An automatic poll that finds nothing should stay silent; a
   * button press that finds nothing has to report that, or the click looks
   * ignored — the screen is identical either way.
   */
  changed: boolean;
}

/**
 * What a vault looks like to a viewer, as one comparable string.
 *
 * Everything on screen that the poll can change, which is more than the
 * digests:
 *
 * - **both digests** — contents and trash, each moving when their own changes
 * - **the id set** — a vault added, removed, or renamed at the map level
 * - **the display name**, which moves neither digest nor id
 * - **the membership**, rendered as "Shared with N" and listed in the share
 *   dialog. The members themselves, not the count: swapping one person for
 *   another is visible and leaves the count alone.
 * - **your rights**, which decide whether Rename, Delete and Empty appear at
 *   all — so being downgraded from `ReadWrite` to `Read` changes the screen
 *   without touching anything else here.
 *
 * The last two were missing, so a check run right after an owner shared the
 * vault or changed your access reported "nothing changed" while the screen
 * visibly had.
 *
 * Sorted, so the canister's ordering cannot register as a change.
 */
function signature(vaults: VaultSummary[]): string {
  return vaults
    .map((vault) =>
      [
        vaultId(vault),
        vault.fingerprint,
        vault.trashFingerprint,
        vault.displayName ?? "",
        vault.rights === null ? "" : accessLevel(vault.rights),
        vault.sharedWith
          .map(([who, rights]) => `${who.toText()}=${accessLevel(rights)}`)
          .sort()
          .join(","),
      ].join(":"),
    )
    .sort()
    .join("|");
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
      // Facts belong to the items being re-read, and `history` is decrypted
      // versions of an item that may no longer be there.
      ...(outcome.refreshItems ? { openItems: null, itemFacts: null, history: null } : {}),
    },
    notice: outcome.notice,
    movedVault: outcome.selection.vaultId !== wasOn,
    refreshTrash,
    changed: signature(before.vaults ?? []) !== signature(next),
  };
}
