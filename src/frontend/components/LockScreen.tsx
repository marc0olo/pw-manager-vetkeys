import { CheckIcon, ExternalIcon, LockIcon, ShieldIcon } from "./Icons";
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

const VETKEYS_DOCS = "https://docs.internetcomputer.org/concepts/vetkeys/";

/**
 * First visit only — someone re-unlocking their own vault already knows this.
 *
 * Three claims, each one defensible: ciphertext-only storage, key derivation with
 * no master password, and revocable sharing. The idle timeout used to sit here,
 * but it is an operating detail rather than a reason to care, and it already
 * appears on the locked screen where it explains something.
 */
const WHAT_THIS_IS: { lead: string; detail: React.ReactNode }[] = [
  {
    lead: "Encrypted before it leaves your browser.",
    detail: "The canister stores ciphertext and nothing else — no node, no operator and no backup holds a readable copy of your secrets.",
  },
  {
    lead: "No master password to remember, or lose.",
    detail: (
      <>
        Your key is derived on demand for your Internet Identity through{" "}
        <a href={VETKEYS_DOCS} target="_blank" rel="noreferrer noopener">
          vetKeys
        </a>
        , where no node or canister ever sees the raw key.
      </>
    ),
  },
  {
    lead: "Share a vault — and take it back.",
    detail: "A colleague gets the vault key re-encrypted for them alone. Revoke it and the canister stops deriving that key for them: no password to rotate, nothing to chase.",
  },
];

export function LockScreen({ onSignIn, busy, error, lockReason }: Props) {
  const locked = lockReason === null ? null : LOCK_STATE[lockReason];

  return (
    <main className="lock">
      <div className={`lock__card ${locked ? "" : "lock__card--intro"}`}>
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
            <h2 className="lock__headline">Passwords only you can read.</h2>
            <ul className="lock__points">
              {WHAT_THIS_IS.map(({ lead, detail }) => (
                <li key={lead}>
                  <CheckIcon />
                  <span>
                    <strong>{lead}</strong> {detail}
                  </span>
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

        {!locked && (
          <p className="lock__credit">
            <a href={VETKEYS_DOCS} target="_blank" rel="noreferrer noopener">
              How vetKeys derives and shares keys
              <ExternalIcon />
            </a>
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
