import type { VaultItem } from "../lib/items";

interface Props {
  item: VaultItem;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Confirmation for deleting one item.
 *
 * A styled dialog rather than `window.confirm`, for the same reason the rest of
 * the app has its own: the native one cannot show the item's own title beside
 * the app's styling, it is not translatable or testable, and it blocks the
 * event loop — which in this app also stalls the inactivity timer that would
 * otherwise lock the vault while the prompt sits open.
 *
 * Untyped, unlike {@link EmptyVaultDialog}. One item that goes to the trash and
 * comes back for 90 days does not warrant typing a name; a whole vault at once
 * does.
 */
export function DeleteItemDialog({ item, busy, onConfirm, onClose }: Props) {
  const label = item.title || "this item";

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Delete ${label}`}>
      <div className="modal__panel">
        <h2>Delete “{label}”?</h2>

        <p className="modal__lede">
          It moves to this vault’s trash and can be restored for 90 days. Everyone who can see the
          vault can see its trash.
        </p>

        <footer className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </footer>
      </div>
    </div>
  );
}
