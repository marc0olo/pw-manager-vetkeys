import { useState } from "react";
import { useDismiss } from "./useDismiss";
import { vaultLabel, type Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Typed confirmation for deleting a vault.
 *
 * Typed rather than a plain confirm, like {@link EmptyVaultDialog}, and for a
 * stronger reason: emptying a vault is recoverable for 90 days, and this is not
 * — the contents, their history and the sharing all go in one call.
 */
export function DeleteVaultDialog({ vault, busy, onConfirm, onClose }: Props) {
  useDismiss(onClose, busy);
  const [typed, setTyped] = useState("");
  const label = vaultLabel(vault);
  const armed = typed === label && !busy;
  const items = vault.itemIds.length;
  const others = vault.sharedWith.length;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Delete ${label}`}>
      <div className="modal__panel">
        <h2>Delete “{label}”?</h2>

        <p className="modal__danger">
          This removes{" "}
          <strong>
            {items} item{items === 1 ? "" : "s"}
          </strong>
          , every earlier version of them, and everything in this vault’s trash.{" "}
          <strong>None of it can be recovered.</strong>
        </p>

        {others > 0 && (
          <p className="modal__lede">
            {others} other {others === 1 ? "person" : "people"} will lose access.
          </p>
        )}

        {/*
          The honest caveat. A vault's key derives from (owner, name), so
          deleting removes data from the canister without revoking the key —
          anyone holding old ciphertext can still read it. Vaults get random
          names so reuse is effectively impossible, but that is a reason the
          caveat rarely bites, not a reason to omit it.
        */}
        <p className="modal__lede">
          The data is deleted, but the vault’s key is derived rather than stored, so this is not the
          same as destroying the key. Anyone who already kept a copy of the encrypted contents could
          still read them.
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
            {busy ? "Deleting…" : "Delete vault"}
          </button>
        </footer>
      </div>
    </div>
  );
}
