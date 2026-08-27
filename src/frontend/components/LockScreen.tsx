import { LockIcon, ShieldIcon } from "./Icons";

interface Props {
  onSignIn: () => void;
  busy: boolean;
  error: string | null;
}

export function LockScreen({ onSignIn, busy, error }: Props) {
  return (
    <main className="lock">
      <div className="lock__card">
        <div className="lock__brand">
          <span className="lock__mark">
            <ShieldIcon />
          </span>
          <h1>vetVault</h1>
        </div>

        <p className="lock__lede">
          Your passwords are encrypted in this browser and stored on the Internet Computer. The
          canister never sees a plaintext secret, and no master password is involved — the key is
          derived for your identity through vetKeys.
        </p>

        <button className="btn btn--primary btn--lg" onClick={onSignIn} disabled={busy}>
          <LockIcon />
          {busy ? "Unlocking…" : "Unlock with Internet Identity"}
        </button>

        {error && (
          <p className="lock__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
