import { useState } from "react";
import { useDismiss } from "./useDismiss";
import { Principal } from "@icp-sdk/core/principal";
import { TrashIcon } from "./Icons";
import { ACCESS_LEVELS, accessLevel, vaultLabel, type AccessLevel, type Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  busy: boolean;
  onShare: (user: Principal, level: AccessLevel) => void;
  onRevoke: (user: Principal) => void;
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

export function ShareDialog({ vault, busy, onShare, onRevoke, onClose }: Props) {
  useDismiss(onClose, busy);
  const [principalText, setPrincipalText] = useState("");
  const [level, setLevel] = useState<AccessLevel>("Read");
  const [error, setError] = useState<string | null>(null);
  const one = vault.trashed === 1;

  // Parsed as the user types, so the form can say what granting will actually
  // do before they press the button.
  const typed = (() => {
    try {
      return Principal.fromText(principalText.trim());
    } catch {
      return null;
    }
  })();

  const isOwner = typed !== null && typed.compareTo(vault.owner) === "eq";
  /**
   * Their current access, if they already have some.
   *
   * `setUserRights` **replaces** an existing entry rather than adding one — one
   * ACL row, changed in place, and it returns the level it replaced. Verified
   * against a replica. So granting to someone who already has access is a
   * *change*, and a form that reads "Grant access" for both makes promoting
   * someone look identical to inviting a stranger.
   */
  const current = typed === null
    ? null
    : (vault.sharedWith.find(([who]) => who.compareTo(typed) === "eq")?.[1] ?? null);
  const currentLevel = current === null ? null : accessLevel(current);
  const unchanged = currentLevel === level;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (typed === null) {
      setError("That is not a valid principal.");
      return;
    }
    if (isOwner || unchanged) return;
    onShare(typed, level);
    setPrincipalText("");
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
          Granting access hands over the trash as well, and this is the only
          screen where that can be said before it happens. A statement, not a
          control: emptying the trash lives in the trash view, where someone
          looking for it will actually go, and duplicating a destructive action
          across two screens is how the two drift apart.
        */}
        {vault.trashed > 0 && (
          <p className="modal__notice" role="note">
            This vault’s trash holds {vault.trashed} deleted {one ? "item" : "items"}, which anyone
            you grant access to can also see. Empty it from the trash view first if that matters.
          </p>
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
          {isOwner ? (
            <p className="modal__hint">
              That is this vault’s owner. They already have full access, and it cannot be changed.
            </p>
          ) : currentLevel !== null ? (
            <p className="modal__hint">
              {unchanged
                ? `They already have “${LEVEL_LABEL[currentLevel]}”. Pick a different level to change it.`
                : `They currently have “${LEVEL_LABEL[currentLevel]}”. This replaces it — there is one entry per person, not one per grant.`}
            </p>
          ) : null}
          <button
            className="btn btn--primary"
            type="submit"
            disabled={busy || !principalText.trim() || isOwner || unchanged}
          >
            {busy ? "Working…" : currentLevel !== null ? "Change access" : "Grant access"}
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
