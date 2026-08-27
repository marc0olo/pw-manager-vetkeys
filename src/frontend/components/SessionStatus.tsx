import { useEffect, useState } from "react";
import { LockIcon } from "./Icons";

interface Props {
  /** Reads the live time left before the idle lock, from the running session. */
  remainingMs: () => number;
  /** When the delegation stops being valid, in ms since the epoch. */
  expiresAt: number | null;
}

/** Below this, the idle countdown is highlighted rather than merely informative. */
const WARN_BELOW_MS = 60_000;

function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/** Coarse for anything over an hour — a ticking second on 7h 52m is just noise. */
function coarse(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The two deadlines, both of which end in a fresh sign-in.
 *
 * They are separate because they measure different things: the idle lock slides
 * with activity, while the sign-in expiry is fixed from when the delegation was
 * issued and cannot be renewed without another Internet Identity interaction.
 * Whichever comes first is the one that fires.
 *
 * One second-interval drives both, and this is its own component so the tick
 * re-renders these two lines rather than the whole app. Both values are re-read
 * on every tick rather than counted down locally, so they stay correct across a
 * suspend — the deadlines are wall-clock based, and local counters would drift.
 */
export function SessionStatus({ remainingMs, expiresAt }: Props) {
  const read = () => ({
    idle: remainingMs(),
    session: expiresAt === null ? null : Math.max(0, expiresAt - Date.now()),
  });
  const [left, setLeft] = useState(read);

  useEffect(() => {
    setLeft(read());
    const ticker = setInterval(() => setLeft(read()), 1_000);
    return () => clearInterval(ticker);
    // `read` closes over both inputs; re-arm when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingMs, expiresAt]);

  // Whichever deadline is nearer is the one that will actually fire, so it is the
  // one that gets highlighted. Warning on the idle line alone would prominently
  // show "Locks in 4:00" while a sign-in expiring in 39s was the real deadline.
  const sessionIsSooner = left.session !== null && left.session < left.idle;
  const soonest = Math.min(left.idle, left.session ?? Number.POSITIVE_INFINITY);
  const warning = soonest <= WARN_BELOW_MS;

  return (
    <div className="sessionStatus">
      <p
        className={`countdown ${warning && !sessionIsSooner ? "countdown--warn" : ""}`}
        title="The vault locks after this much inactivity. Any interaction resets it, and unlocking needs Internet Identity again."
        aria-live={warning && !sessionIsSooner ? "polite" : "off"}
      >
        <LockIcon />
        {left.idle > 0 ? (
          <>
            Locks in <strong>{clock(left.idle)}</strong>
          </>
        ) : (
          <>Locking…</>
        )}
      </p>

      {left.session !== null && (
        <p
          className={`sessionStatus__expiry ${warning && sessionIsSooner ? "sessionStatus__expiry--warn" : ""}`}
          title="Your sign-in expires at a fixed time and cannot be extended without signing in again — it applies even while you are active."
          aria-live={warning && sessionIsSooner ? "polite" : "off"}
        >
          Sign-in expires in{" "}
          <strong>{left.session > 3_600_000 ? coarse(left.session) : clock(left.session)}</strong>
        </p>
      )}
    </div>
  );
}
