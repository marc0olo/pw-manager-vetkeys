import { useState } from "react";
import { EyeIcon, EyeOffIcon, RefreshIcon } from "./Icons";
import type { VaultItem } from "../lib/items";
import { DEFAULT_GENERATOR, generatePassword, passwordStrength, type GeneratorOptions } from "../lib/password";

interface Props {
  item: VaultItem;
  isNew: boolean;
  saving: boolean;
  onSave: (item: VaultItem) => void;
  onCancel: () => void;
}

export function ItemEditor({ item, isNew, saving, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState(item);
  const [revealed, setRevealed] = useState(isNew);
  const [generator, setGenerator] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [showGenerator, setShowGenerator] = useState(false);

  const set = <K extends keyof VaultItem>(key: K, value: VaultItem[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const strength = passwordStrength(draft.password);
  const canSave = draft.title.trim().length > 0 || draft.username.trim().length > 0;

  const regenerate = (options: GeneratorOptions) => {
    setGenerator(options);
    set("password", generatePassword(options));
    setRevealed(true);
  };

  return (
    <form
      className="detail editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave(draft);
      }}
    >
      <header className="detail__head">
        <h2>{isNew ? "New item" : "Edit item"}</h2>
      </header>

      <label className="input">
        <span>Title</span>
        <input
          value={draft.title}
          onChange={(event) => set("title", event.target.value)}
          placeholder="GitHub"
          autoFocus
        />
      </label>

      <label className="input">
        <span>Username</span>
        <input
          value={draft.username}
          onChange={(event) => set("username", event.target.value)}
          placeholder="you@example.com"
          autoComplete="off"
        />
      </label>

      <label className="input">
        <span>Password</span>
        <div className="input__row">
          <input
            type={revealed ? "text" : "password"}
            value={draft.password}
            onChange={(event) => set("password", event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
          <button
            type="button"
            className="iconBtn"
            onClick={() => setRevealed((value) => !value)}
            title={revealed ? "Hide password" : "Reveal password"}
            aria-label={revealed ? "Hide password" : "Reveal password"}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          <button
            type="button"
            className="iconBtn"
            onClick={() => regenerate(generator)}
            title="Generate a new password"
            aria-label="Generate a new password"
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="input__aside">
          {draft.password && (
            <span className={`strength strength--${strength.label}`}>
              <span className="strength__bar" />
              <span className="strength__label">{strength.label}</span> · ~{strength.bits} bits
            </span>
          )}
          <button type="button" className="linkBtn" onClick={() => setShowGenerator((value) => !value)}>
            {showGenerator ? "Hide generator options" : "Generator options"}
          </button>
        </div>
      </label>

      {showGenerator && (
        <fieldset className="generator">
          <label className="generator__len">
            Length
            <input
              type="range"
              min={8}
              max={64}
              value={generator.length}
              onChange={(event) => regenerate({ ...generator, length: Number(event.target.value) })}
            />
            <output>{generator.length}</output>
          </label>
          <label>
            <input
              type="checkbox"
              checked={generator.digits}
              onChange={(event) => regenerate({ ...generator, digits: event.target.checked })}
            />
            Digits
          </label>
          <label>
            <input
              type="checkbox"
              checked={generator.symbols}
              onChange={(event) => regenerate({ ...generator, symbols: event.target.checked })}
            />
            Symbols
          </label>
        </fieldset>
      )}

      <label className="input">
        <span>Website</span>
        <input
          value={draft.url}
          onChange={(event) => set("url", event.target.value)}
          placeholder="github.com"
          autoComplete="off"
        />
      </label>

      <label className="input">
        <span>Notes</span>
        <textarea rows={4} value={draft.notes} onChange={(event) => set("notes", event.target.value)} />
      </label>

      <footer className="detail__actions">
        <button className="btn btn--primary" type="submit" disabled={!canSave || saving}>
          {saving ? "Encrypting…" : "Save"}
        </button>
        <button className="btn btn--ghost" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {!canSave && <span className="hint">Give the item a title or a username.</span>}
      </footer>
    </form>
  );
}
