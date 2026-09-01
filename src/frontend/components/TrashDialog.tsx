import { TrashIcon } from "./Icons";
import { vaultLabel, type TrashedItem, type Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  items: TrashedItem[];
  busy: boolean;
  onRestore: (itemId: string) => void;
  onRestoreAll: () => void;
  onClose: () => void;
}

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** 90 days from deletion, matching `RETENTION_NS` in lib/Trash.mo. */
const recoverableUntil = (at: number) => when(at + 90 * 24 * 60 * 60 * 1000);

export function TrashDialog({ vault, items, busy, onRestore, onRestoreAll, onClose }: Props) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Deleted items in ${vaultLabel(vault)}`}>
      <div className="modal__panel">
        <h2>Deleted from “{vaultLabel(vault)}”</h2>
        <p className="modal__lede">
          Deleted items can be restored for 90 days, then they are gone for good. Restoring one
          returns it exactly as it was — nothing is re-encrypted.
        </p>

        {items.length === 0 ? (
          <p className="modal__empty">Nothing has been deleted from this vault.</p>
        ) : (
          <>
            {/*
              No titles here on purpose: the canister returns keys and metadata
              only, never the encrypted values, so a wiped vault's contents do
              not cross the wire a second time. The title lives inside the value.
            */}
            <ul className="shareList">
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <div>Deleted {when(item.deletedAt)}</div>
                    <code title={`Recoverable until ${recoverableUntil(item.deletedAt)}`}>
                      by {item.deletedBy.toText().slice(0, 12)}…
                    </code>
                  </div>
                  <button className="btn btn--ghost btn--sm" onClick={() => onRestore(item.id)} disabled={busy}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>

            {items.length > 1 && (
              <button className="btn btn--ghost btn--full" onClick={onRestoreAll} disabled={busy}>
                {busy ? "Restoring…" : `Restore all ${items.length}`}
              </button>
            )}
          </>
        )}

        <footer className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The control that opens it, shown only when there is something to restore. */
export function TrashButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <button className="btn btn--ghost btn--sm" onClick={onOpen} title="Items deleted in the last 90 days">
      <TrashIcon />
      {count} deleted
    </button>
  );
}
