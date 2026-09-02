import { useState } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { TrashIcon } from "./Icons";
import { ACCESS_LEVELS, accessLevel, vaultLabel, type AccessLevel, type Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  busy: boolean;
  onShare: (user: Principal, level: AccessLevel) => void;
  onRevoke: (user: Principal) => void;
  onDiscardTrash: () => void;
  onClose: () => void;
}

const LEVEL_LABEL: Record<AccessLevel, string> = {
  Read: "Read only",
  ReadWrite: "Can edit",
  ReadWriteManage: "Can edit and re-share",
};

/**
 * What each level actually permits, which the short labels cannot carry.
 *
 * `ReadWrite` is the one that matters: `remove_map_values` is guarded by
 * `ensureUserCanWrite`, so there is no separate delete right and "Can edit
 * items" materially understated a level that can destroy the vault's contents.
 * Verified against a replica.
 */
const LEVEL_DETAIL: Record<AccessLevel, string> = {
  Read: "Can open this vault and copy its secrets. Cannot change anything.",
  ReadWrite: "Can add, edit and delete items — including deleting every item at once.",
  ReadWriteManage: "All of the above, plus granting and revoking access for other people.",
};

export function ShareDialog({ vault, busy, onShare, onRevoke, onDiscardTrash, onClose }: Props) {
  const [principalText, setPrincipalText] = useState("");
  const [level, setLevel] = useState<AccessLevel>("Read");
  const [error, setError] = useState<string | null>(null);
  // Two-step, because this dialog was opened to share rather than to destroy
  // anything, and emptying the trash cannot be undone.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const one = vault.trashed === 1;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      onShare(Principal.fromText(principalText.trim()), level);
      setPrincipalText("");
    } catch {
      setError("That is not a valid principal.");
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Share ${vaultLabel(vault)}`}>
      <div className="modal__panel">
        <h2>Share “{vaultLabel(vault)}”</h2>
        <p className="modal__lede">
          The vault key is re-encrypted for the principal you name, so they can decrypt these items
          without you ever handing over a secret.
        </p>

        {/*
          Granting access hands over the trash as well, so the one place that
          can be said before it happens is here. Stated as what the grantee
          will see rather than as a warning about the feature: the reader is
          about to make the decision, not to learn a policy.
        */}
        {vault.trashed > 0 && (
          <div className="modal__notice" role="note">
            {confirmingDiscard ? (
              <>
                <p>
                  Permanently delete {vault.trashed} {one ? "item" : "items"} from the trash?{" "}
                  {one ? "It" : "They"} cannot be recovered afterwards, by anyone.
                </p>
                <div className="modal__noticeActions">
                  <button
                    className="btn btn--danger btn--sm"
                    onClick={() => {
                      setConfirmingDiscard(false);
                      onDiscardTrash();
                    }}
                    disabled={busy}
                  >
                    {busy ? "Working…" : "Delete permanently"}
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => setConfirmingDiscard(false)}
                    disabled={busy}
                  >
                    Keep {one ? "it" : "them"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  This vault’s trash holds {vault.trashed} deleted {one ? "item" : "items"}. Anyone
                  you grant access to can see {one ? "it" : "them"}, and recover {one ? "it" : "them"}{" "}
                  with edit access.
                </p>
                <button
                  className="btn btn--danger btn--sm"
                  onClick={() => setConfirmingDiscard(true)}
                  disabled={busy}
                >
                  Empty trash first
                </button>
              </>
            )}
          </div>
        )}

        <form className="modal__form" onSubmit={submit}>
          <label className="input">
            <span>Principal</span>
            <input
              value={principalText}
              onChange={(event) => setPrincipalText(event.target.value)}
              placeholder="ryjl3-tyaaa-aaaaa-aaaba-cai"
              spellCheck={false}
            />
          </label>
          <label className="input">
            <span>Access</span>
            <select value={level} onChange={(event) => setLevel(event.target.value as AccessLevel)}>
              {ACCESS_LEVELS.map((option) => (
                <option key={option} value={option}>
                  {LEVEL_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
          <p className="modal__hint">{LEVEL_DETAIL[level]}</p>
          <button className="btn btn--primary" type="submit" disabled={busy || !principalText.trim()}>
            {busy ? "Working…" : "Grant access"}
          </button>
        </form>

        {error && (
          <p className="modal__error" role="alert">
            {error}
          </p>
        )}

        <h3 className="modal__subhead">People with access</h3>
        {vault.sharedWith.length === 0 ? (
          <p className="modal__empty">Only you.</p>
        ) : (
          <ul className="shareList">
            {vault.sharedWith.map(([user, rights]) => (
              <li key={user.toText()}>
                <code>{user.toText()}</code>
                <span title={LEVEL_DETAIL[accessLevel(rights)]}>{LEVEL_LABEL[accessLevel(rights)]}</span>
                <button
                  className="iconBtn"
                  onClick={() => onRevoke(user)}
                  disabled={busy}
                  title="Revoke access"
                  aria-label="Revoke access"
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
