import { useEffect, useState } from "react";
import { LockIcon } from "./Icons";

interface Props {
  /** Reads the live remaining time from the running session. */
  remainingMs: () => number;
}

function format(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Below this, the countdown is highlighted rather than merely informative. */
const WARN_BELOW_MS = 60_000;

/**
 * How long until the vault auto-locks.
 *
 * Its own component so the one-second tick re-renders this line alone rather than
 * the whole app. The value is read from the session on every tick instead of being
 * counted down locally, so it stays correct across a suspend — the deadline is
 * wall-clock based, and a local counter would drift away from it.
 */
export function IdleCountdown({ remainingMs }: Props) {
  const [left, setLeft] = useState(() => remainingMs());

  useEffect(() => {
    setLeft(remainingMs());
    const ticker = setInterval(() => setLeft(remainingMs()), 1_000);
    return () => clearInterval(ticker);
  }, [remainingMs]);

  const warning = left <= WARN_BELOW_MS;

  return (
    <p
      className={`countdown ${warning ? "countdown--warn" : ""}`}
      title="The vault locks automatically after a period of inactivity. Any interaction resets it."
      aria-live={warning ? "polite" : "off"}
    >
      <LockIcon />
      {left > 0 ? (
        <>
          Locks in <strong>{format(left)}</strong>
        </>
      ) : (
        <>Locking…</>
      )}
    </p>
  );
}
