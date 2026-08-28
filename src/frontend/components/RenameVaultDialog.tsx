import { useState } from "react";
import { isValidDisplayName, MAX_DISPLAY_NAME_BYTES } from "../lib/names";
import { vaultLabel, type Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  busy: boolean;
  onRename: (displayName: string) => void;
  onClose: () => void;
}

export function RenameVaultDialog({ vault, busy, onRename, onClose }: Props) {
  const [name, setName] = useState(vaultLabel(vault));
  const trimmed = name.trim();
  const unchanged = trimmed === vaultLabel(vault);
  const overLong = trimmed.length > 0 && !isValidDisplayName(trimmed);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || unchanged || overLong) return;
    onRename(trimmed);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Rename ${vaultLabel(vault)}`}>
      <div className="modal__panel">
        <h2>Rename this vault</h2>
        <p className="modal__lede">
          Only the label changes. Nothing is re-encrypted, no one loses access, and everyone you
          share it with sees the new name straight away.
        </p>

        <form className="modal__form" onSubmit={submit}>
          <label className="input">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              spellCheck={false}
              autoFocus
            />
          </label>
          {overLong && (
            <p className="modal__hint" role="alert">
              That is too long — {MAX_DISPLAY_NAME_BYTES} bytes at most.
            </p>
          )}

          {/*
            Said plainly, because a rename otherwise implies a privacy property
            it does not have. The map name is the vetKey derivation input, so it
            can never change — renaming "Divorce lawyer" to "Misc" leaves the
            original in place, readable by anyone who can see the vault.
          */}
          <p className="modal__hint">
            This vault was created as <code>{vault.name}</code>. That original name cannot be
            changed — it is part of how its encryption key is derived — and stays visible to anyone
            you share the vault with.
          </p>

          <div className="modal__actions">
            <button className="btn btn--ghost" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {vault.displayName !== null && (
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => onRename("")}
                disabled={busy}
                title={`Go back to “${vault.name}”`}
              >
                Reset
              </button>
            )}
            <button className="btn btn--primary" type="submit" disabled={busy || unchanged || overLong}>
              {busy ? "Saving…" : "Rename"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
