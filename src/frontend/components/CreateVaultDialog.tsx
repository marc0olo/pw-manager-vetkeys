import { useState } from "react";
import { useDismiss } from "./useDismiss";
import { isValidDisplayName, MAX_DISPLAY_NAME_BYTES } from "../lib/backend";
import { labelTaken, type VaultSummary } from "../lib/vault";

interface Props {
  busy: boolean;
  /** Every vault on screen, so a duplicate label can be caught before submitting. */
  vaults: VaultSummary[];
  /** True when this is the user's first vault, which only changes the heading. */
  first: boolean;
  onCreate: (displayName: string) => void;
  onClose: () => void;
}

export function CreateVaultDialog({ busy, vaults, first, onCreate, onClose }: Props) {
  useDismiss(onClose, busy);
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const overLong = trimmed.length > 0 && !isValidDisplayName(trimmed);
  const taken = labelTaken(vaults, trimmed, null);
  const armed = trimmed.length > 0 && !overLong && !taken && !busy;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!armed) return;
    onCreate(trimmed);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="New vault">
      <div className="modal__panel">
        <h2>{first ? "Create your first vault" : "New vault"}</h2>

        <p className="modal__lede">
          A vault is a separate set of secrets with its own key and its own sharing. Nothing in one
          vault can be read with another vault's key.
        </p>

        <form className="modal__form" onSubmit={submit}>
          <label className="input">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Work"
              spellCheck={false}
              autoFocus
            />
          </label>
          {/*
            Worth saying here rather than in a settings page nobody reads: the
            *label* is private-ish and changeable, and the vault's real name is
            random precisely so that renaming does not leave the original
            readable forever. Saying "you can rename it" without saying the
            label is visible would be the dishonest half of the truth.
          */}
          <p className="modal__hint">
            You can rename it later — the name is a label, not the vault's identity. Labels are
            stored unencrypted, because access has to be enforced without a key, so keep secrets
            out of the name itself.
          </p>
          {overLong && (
            <p className="modal__error" role="alert">
              Names are limited to {MAX_DISPLAY_NAME_BYTES} bytes.
            </p>
          )}
          {taken && (
            <p className="modal__error" role="alert">
              You already have a vault called “{trimmed}”. Two vaults with one name would make the
              delete confirmation ambiguous.
            </p>
          )}
          <button className="btn btn--primary" type="submit" disabled={!armed}>
            {busy ? "Creating…" : "Create vault"}
          </button>
        </form>

        {/*
          Always dismissable, including the first one. It was not, on the
          reasoning that there is nothing behind the dialog for a user with no
          vaults — which stopped being true once that screen carried their
          principal. Someone who opened this and then decided they would rather
          be shared with needs a way back to it.
        */}
        <footer className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </footer>

      </div>
    </div>
  );
}
