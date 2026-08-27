import { useEffect, useState } from "react";
import { CopyIcon, EyeIcon, EyeOffIcon, ExternalIcon, TrashIcon } from "./Icons";
import { displayHost, type VaultItem } from "../lib/items";
import { passwordStrength } from "../lib/password";

interface Props {
  item: VaultItem;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (field: "username" | "password" | "url", value: string) => void;
}

/** Auto-hide a revealed password so it does not sit on screen indefinitely. */
const REVEAL_TIMEOUT_MS = 30_000;

export function ItemDetail({ item, canWrite, onEdit, onDelete, onCopy }: Props) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => setRevealed(false), [item.id]);

  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(false), REVEAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [revealed, item.id]);

  const host = displayHost(item.url);
  const strength = passwordStrength(item.password);
  const href = item.url.trim() && (item.url.includes("://") ? item.url : `https://${item.url}`);

  return (
    <section className="detail">
      <header className="detail__head">
        <span className="detail__avatar" aria-hidden>
          {(item.title || host || "?").charAt(0).toUpperCase()}
        </span>
        <div>
          <h2>{item.title || host || "Untitled"}</h2>
          {item.updatedAt > 0 && (
            <p className="detail__stamp">Updated {new Date(item.updatedAt).toLocaleString()}</p>
          )}
        </div>
      </header>

      <dl className="fields">
        <Field label="Username" value={item.username}>
          {item.username && (
            <IconButton label="Copy username" onClick={() => onCopy("username", item.username)}>
              <CopyIcon />
            </IconButton>
          )}
        </Field>

        <div className="field">
          <dt>Password</dt>
          <dd>
            <span className={`field__value ${revealed ? "field__value--mono" : "field__value--dots"}`}>
              {item.password ? (revealed ? item.password : "•".repeat(Math.min(item.password.length, 24))) : "—"}
            </span>
            {item.password && (
              <>
                <IconButton
                  label={revealed ? "Hide password" : "Reveal password"}
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? <EyeOffIcon /> : <EyeIcon />}
                </IconButton>
                <IconButton label="Copy password" onClick={() => onCopy("password", item.password)}>
                  <CopyIcon />
                </IconButton>
              </>
            )}
          </dd>
          {item.password && (
            <p className={`strength strength--${strength.label}`}>
              <span className="strength__bar" />
              <span className="strength__label">{strength.label}</span> · ~{strength.bits} bits
            </p>
          )}
        </div>

        <Field label="Website" value={host || item.url}>
          {href && (
            <>
              <IconButton label="Copy website" onClick={() => onCopy("url", item.url)}>
                <CopyIcon />
              </IconButton>
              <a className="iconBtn" href={href} target="_blank" rel="noreferrer noopener" title="Open website">
                <ExternalIcon />
              </a>
            </>
          )}
        </Field>

        {item.notes && (
          <div className="field">
            <dt>Notes</dt>
            <dd>
              <p className="field__notes">{item.notes}</p>
            </dd>
          </div>
        )}
      </dl>

      {canWrite && (
        <footer className="detail__actions">
          <button className="btn btn--primary" onClick={onEdit}>
            Edit
          </button>
          <button className="btn btn--danger" onClick={onDelete}>
            <TrashIcon />
            Delete
          </button>
        </footer>
      )}
    </section>
  );
}

function Field({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>
        <span className="field__value">{value || "—"}</span>
        {children}
      </dd>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className="iconBtn" onClick={onClick} title={label} aria-label={label}>
      {children}
    </button>
  );
}
