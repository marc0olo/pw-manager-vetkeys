import { useState } from "react";
import { vaultLabel, type Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Typed confirmation for emptying a vault.
 *
 * A plain `confirm()` is not enough even now that it is recoverable: this
 * removes every item in one call, and because `remove_map_values` is guarded by
 * `ensureUserCanWrite`, any `ReadWrite` collaborator can do it to a vault they
 * do not own. Typing the name makes it deliberate rather than a mis-click; the
 * trash is what makes it survivable.
 */
export function EmptyVaultDialog({ vault, busy, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState("");
  const label = vaultLabel(vault);
  const armed = typed === label && !busy;
  // Canister state, not decryption progress: `itemIds` is what the wipe will
  // actually remove, and it is right even mid-decrypt or when a poll has landed
  // items the re-decrypt has not caught up with.
  const count = vault.itemIds.length;
  const others = vault.sharedWith.length;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Empty ${label}`}>
      <div className="modal__panel">
        <h2>Empty “{label}”?</h2>

        <p className="modal__danger">
          This deletes{" "}
          <strong>
            all {count} item{count === 1 ? "" : "s"}
          </strong>{" "}
          in this vault. They move to the trash and can be restored for 90 days,
          after which they are gone for good.
        </p>

        <p className="modal__lede">
          The vault itself stays, and so does everyone{"’"}s access to it
          {others > 0 && ` (${others} other ${others === 1 ? "person" : "people"})`}.
          {!vault.isOwned && " You do not own this vault — its owner will see it emptied."}
        </p>

        <label className="input">
          <span>
            Type <code>{label}</code> to confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            spellCheck={false}
            autoFocus
          />
        </label>

        <footer className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={onConfirm} disabled={!armed}>
            {busy ? "Emptying…" : "Empty vault"}
          </button>
        </footer>
      </div>
    </div>
  );
}
