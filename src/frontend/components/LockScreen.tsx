import { CheckIcon, LockIcon, ShieldIcon } from "./Icons";
import { IDENTITY_PROVIDER, USING_LOCAL_II, type LockReason } from "../lib/auth";
import { IDLE_TIMEOUT_LABEL } from "../lib/session";

interface Props {
  onSignIn: () => void;
  busy: boolean;
  error: string | null;
  /** Set when this screen is the result of a lock, not a first visit. */
  lockReason: LockReason | null;
}

/**
 * Every lock clears the derived keys *and* the delegation, so the reassurance is
 * the same whether the user pressed Lock or walked away: nothing is left on this
 * device that can open the vault.
 */
const SAFE_TO_LEAVE =
  "Safe to walk away. The decryption keys are gone from this browser, so nobody can open your vault without signing in again.";

const LOCK_STATE: Record<LockReason, { title: string; detail: string }> = {
  manual: { title: "Vault locked", detail: SAFE_TO_LEAVE },
  idle: { title: `Locked after ${IDLE_TIMEOUT_LABEL} of inactivity`, detail: SAFE_TO_LEAVE },
  expired: {
    title: "Your sign-in expired",
    detail: "Sign in again to unlock. Nothing was left on this device in the meantime.",
  },
  elsewhere: {
    title: "Locked in another tab",
    detail: "Tabs lock together, so this one locked too. Sign in again to unlock it.",
  },
};

/** First visit only. Someone re-unlocking their own vault already knows this. */
const WHAT_THIS_IS = [
  "No master password — your key is derived for your Internet Identity.",
  "Secrets are encrypted here in the browser; the canister only ever holds ciphertext.",
  `Locks itself after ${IDLE_TIMEOUT_LABEL} of inactivity.`,
];

export function LockScreen({ onSignIn, busy, error, lockReason }: Props) {
  const locked = lockReason === null ? null : LOCK_STATE[lockReason];

  return (
    <main className="lock">
      <div className="lock__card">
        <div className="lock__brand">
          <span className={`lock__mark ${locked ? "lock__mark--locked" : ""}`}>
            {locked ? <LockIcon /> : <ShieldIcon />}
          </span>
          <h1>vetVault</h1>
        </div>

        {locked ? (
          <div className="lock__status" role="status">
            <h2>{locked.title}</h2>
            <p>{locked.detail}</p>
          </div>
        ) : (
          <>
            <p className="lock__tagline">End-to-end encrypted passwords on the Internet Computer.</p>
            <ul className="lock__points">
              {WHAT_THIS_IS.map((point) => (
                <li key={point}>
                  <CheckIcon />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <button className="btn btn--primary btn--lg btn--full" onClick={onSignIn} disabled={busy}>
          <LockIcon />
          {busy ? "Unlocking…" : locked ? "Unlock" : "Unlock with Internet Identity"}
        </button>

        {error && (
          <p className="lock__error" role="alert">
            {error}
          </p>
        )}

        {USING_LOCAL_II && (
          <p
            className="lock__env"
            title={`${IDENTITY_PROVIDER} — found from this page's origin. This principal is local only; a mainnet deployment is a different user with a different vault.`}
          >
            local Internet Identity · development build
          </p>
        )}
      </div>
    </main>
  );
}
