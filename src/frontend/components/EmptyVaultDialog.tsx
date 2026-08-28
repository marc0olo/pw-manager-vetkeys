import { useState } from "react";
import type { Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Typed confirmation for emptying a vault.
 *
 * A plain `confirm()` is not enough here. This removes every item in one call,
 * there is no trash to recover from yet (#8), and because `remove_map_values`
 * is guarded by `ensureUserCanWrite`, any `ReadWrite` collaborator can do it to
 * a vault they do not own. Typing the name is the cheapest way to make it
 * deliberate rather than a mis-click.
 */
export function EmptyVaultDialog({ vault, busy, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState("");
  const armed = typed === vault.name && !busy;
  const count = vault.items.length;
  const others = vault.sharedWith.length;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Empty ${vault.name}`}>
      <div className="modal__panel">
        <h2>Empty “{vault.name}”?</h2>

        <p className="modal__danger">
          This deletes{" "}
          <strong>
            all {count} item{count === 1 ? "" : "s"}
          </strong>{" "}
          in this vault. There is no undo and no trash — the secrets are gone.
        </p>

        <p className="modal__lede">
          The vault itself stays, and so does everyone{"’"}s access to it
          {others > 0 && ` (${others} other ${others === 1 ? "person" : "people"})`}.
          {!vault.isOwned && " You do not own this vault — its owner will see it emptied."}
        </p>

        <label className="input">
          <span>
            Type <code>{vault.name}</code> to confirm
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
