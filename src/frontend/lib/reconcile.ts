import type { VaultItem } from "./items";
import { defaultVaultId, vaultId, vaultLabel, type VaultSummary } from "./vault";

export interface Selection {
  vaultId: string | null;
  itemId: string | null;
}

export interface Reconciled {
  selection: Selection;
  /** Something disappeared under the user. Shown as a toast. */
  notice: string | null;
  /** The selected vault's stored ciphertext changed, so re-decrypt it. */
  refreshItems: boolean;
}

/**
 * Work out what the UI should do after a poll.
 *
 * Kept a pure diff of two polls against the current selection, because the
 * interesting cases — an item deleted under you, a vault revoked while you are
 * reading it — are otherwise only reachable by two people acting at once, which
 * is precisely the situation nobody tests by hand.
 *
 * All of it works off `itemIds` and `fingerprint`, which a poll knows without
 * decrypting anything: EncryptedMaps encrypts values, not keys.
 */
export function reconcile({
  previous,
  next,
  selection,
  openItems,
}: {
  previous: VaultSummary[];
  next: VaultSummary[];
  selection: Selection;
  openItems: VaultItem[] | null;
}): Reconciled {
  // An unchosen selection still shows a vault — the default — so it has to be
  // reconciled like any other. Bailing out here meant that until the user
  // clicked a vault, every poll-driven update was silently dropped: a new item
  // never appeared, and a revoked vault stayed on screen until reload.
  //
  // Resolved against `previous`, because that is the list the user is currently
  // looking at. Returning the resolved id is what makes the selection explicit
  // from then on.
  const selected = selection.vaultId ?? defaultVaultId(previous);
  if (selected === null) return { selection, notice: null, refreshItems: false };
  const resolved: Selection = { vaultId: selected, itemId: selection.itemId };

  const before = previous.find((vault) => vaultId(vault) === selected) ?? null;
  const after = next.find((vault) => vaultId(vault) === selected) ?? null;

  // The selected vault is gone. A shared vault only leaves the listing when
  // access is revoked — emptying it keeps it, since it is listed from the access
  // control list — so the message can say what happened rather than hedge.
  if (after === null) {
    // The label, never the map name. A renamed vault must not be announced by
    // the name the user replaced — they may never have seen it, and reciting it
    // unprompted is exactly what the rename dialog warns cannot be undone.
    const name = before ? vaultLabel(before) : "That vault";
    return {
      selection: { vaultId: defaultVaultId(next), itemId: null },
      notice:
        before === null || before.isOwned
          ? `“${name}” is no longer available.`
          : `“${name}” is no longer shared with you.`,
      refreshItems: true,
    };
  }

  const contentsChanged = before !== null && before.fingerprint !== after.fingerprint;

  // The selected item is gone from the canister.
  if (selection.itemId !== null && !after.itemIds.includes(selection.itemId)) {
    const title = openItems?.find((item) => item.id === selection.itemId)?.title;
    return {
      selection: { vaultId: selected, itemId: null },
      notice: title ? `“${title}” was deleted.` : "That item was deleted.",
      refreshItems: true,
    };
  }

  return { selection: resolved, notice: null, refreshItems: contentsChanged };
}
