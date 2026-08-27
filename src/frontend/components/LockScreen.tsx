import { LockIcon, ShieldIcon } from "./Icons";
import { IDENTITY_PROVIDER, USING_LOCAL_II, type LockReason } from "../lib/auth";
import { IDLE_TIMEOUT_LABEL } from "../lib/session";

interface Props {
  onSignIn: () => void;
  busy: boolean;
  error: string | null;
  /** Set when this screen is the result of a lock, not a first visit. */
  lockReason: LockReason | null;
}

const LOCK_MESSAGE: Record<LockReason, string> = {
  manual: "Vault locked. Your keys were discarded.",
  idle: `Locked after ${IDLE_TIMEOUT_LABEL} of inactivity.`,
  expired: "Your session ended. Sign in again to unlock.",
  elsewhere: "Locked in another tab.",
};

export function LockScreen({ onSignIn, busy, error, lockReason }: Props) {
  return (
    <main className="lock">
      <div className="lock__card">
        <div className="lock__brand">
          <span className="lock__mark">
            <ShieldIcon />
          </span>
          <h1>vetVault</h1>
        </div>

        {lockReason && (
          <p className="lock__notice" role="status">
            {LOCK_MESSAGE[lockReason]}
          </p>
        )}

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

        {USING_LOCAL_II && (
          <p className="lock__env" title={IDENTITY_PROVIDER}>
            Signing in against <strong>local Internet Identity</strong>, found from this page's
            origin. This principal is local only — a mainnet deployment is a different user with a
            different vault.
          </p>
        )}
      </div>
    </main>
  );
}
