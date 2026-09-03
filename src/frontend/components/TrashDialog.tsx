import { useState } from "react";
import { useDismiss } from "./useDismiss";
import { TrashIcon } from "./Icons";
import { vaultLabel, type TrashedItem, type Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  items: TrashedItem[];
  busy: boolean;
  /**
   * Whether to offer recovery. Read access sees what was deleted; write access
   * is what puts it back, so a read-only member gets the list without the
   * buttons rather than buttons that would be refused.
   */
  canRestore: boolean;
  /**
   * Whether to offer emptying it. The owner's alone — a writer can put versions
   * back but not make them unrecoverable, so this is not the same permission as
   * restoring and must not be gated on it.
   */
  canEmpty: boolean;
  onRestore: (seq: bigint) => void;
  onRestoreAll: () => void;
  onDiscardAll: () => void;
  onClose: () => void;
}

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** 90 days from deletion, matching `RETENTION_NS` in lib/History.mo. */
const recoverableUntil = (at: number) => when(at + 90 * 24 * 60 * 60 * 1000);

export function TrashDialog({
  vault,
  items,
  busy,
  canRestore,
  canEmpty,
  onRestore,
  onRestoreAll,
  onDiscardAll,
  onClose,
}: Props) {
  useDismiss(onClose, busy);
  // Two-step in place rather than a second dialog on top of this one. The
  // confirmation belongs beside the list it is about, and stacking modals
  // would hide the very thing being confirmed.
  const [confirming, setConfirming] = useState(false);
  const one = items.length === 1;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Deleted items in ${vaultLabel(vault)}`}>
      <div className="modal__panel">
        <h2>Deleted from “{vaultLabel(vault)}”</h2>
        <p className="modal__lede">
          {canRestore
            ? "Restorable for 90 days, then unreachable for good. Restoring one returns it exactly as it was — nothing is re-encrypted, so it decrypts under the key it always had."
            : "Kept for 90 days, then unreachable for good. You have read-only access to this vault, so you can see what was deleted but not put it back."}
        </p>

        {items.length === 0 ? (
          <p className="modal__empty">Nothing has been deleted from this vault.</p>
        ) : (
          <>
            {/*
              Real titles, decrypted in the browser. Without them a row reads
              "deleted at 14:22" and three deletions in one minute are
              indistinguishable — recovery would mean restoring everything and
              deleting again.
            */}
            <ul className="shareList">
              {items.map(({ seq, item, deletedAt, deletedBy }) => (
                // Keyed on the event, not the item: one secret deleted, restored
                // and deleted again appears twice.
                <li key={String(seq)}>
                  <div>
                    <div>{item.title || "Untitled"}</div>
                    <code title={`Recoverable until ${recoverableUntil(deletedAt)}`}>
                      {item.username ? `${item.username} · ` : ""}deleted {when(deletedAt)} by{" "}
                      {deletedBy.toText().slice(0, 8)}…
                    </code>
                  </div>
                  {canRestore && (
                    <button className="btn btn--ghost btn--sm" onClick={() => onRestore(seq)} disabled={busy}>
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {canRestore && items.length > 1 && (
              <button className="btn btn--ghost btn--full" onClick={onRestoreAll} disabled={busy}>
                {busy ? "Restoring…" : `Restore all ${items.length}`}
              </button>
            )}
          </>
        )}

        <footer className="modal__actions">
          {canEmpty && items.length > 0 && !confirming && (
            <button className="btn btn--danger btn--sm" onClick={() => setConfirming(true)} disabled={busy}>
              Empty trash
            </button>
          )}
          {confirming && (
            <>
              <span className="modal__confirm">
                Delete {items.length} {one ? "item" : "items"} for good?
              </span>
              <button
                className="btn btn--danger btn--sm"
                onClick={() => {
                  setConfirming(false);
                  onDiscardAll();
                }}
                disabled={busy}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)} disabled={busy}>
                Keep {one ? "it" : "them"}
              </button>
            </>
          )}
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The control that opens it, shown only when something has been deleted. */
export function TrashButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <button className="btn btn--ghost btn--sm" onClick={onOpen} title="Items deleted in the last 90 days">
      <TrashIcon />
      {count} deleted
    </button>
  );
}
