/**
 * What this run cost, how many more the balance affords, and whatever the
 * canister's own watchdog currently has to say.
 *
 * Running these checks is what drains the canister: each derives vault keys, a
 * derive reserves ~26 B cycles, and mutation testing re-runs them per mutant.
 * The failure at the end of that drain is `IC0406 could not perform remote
 * call`, which says nothing about cycles — both times it happened here it was
 * read as a bug in the app.
 *
 * The run cost is measured rather than assumed, so it needs no threshold
 * constant kept in sync with the canister and recalibrates as the scripts
 * change. Judging *danger* is left to the canister, which has the one
 * threshold: a figure of "N runs left" cannot be that judgement, because for a
 * cheap script N runs is a smaller balance than the one derivation already
 * fails at.
 */
import { execSync } from "node:child_process";

const T = 1_000_000_000_000;

/**
 * Below this, the difference between two readings is idle burn rather than the
 * run: the canister spends ~1 B a day doing nothing, so dividing the balance by
 * a few seconds of that gives a headroom figure with no meaning.
 */
const MEASURABLE = 100_000_000;

function cli(command) {
  try {
    return execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // Not a controller, or no replica. A diagnostic must never be the reason a
    // check fails.
    return null;
  }
}

/**
 * The watchdog's current verdict, or null if it has none.
 *
 * The canister prints on the *transition*, so the newest line is the standing
 * state and everything before it is history — which is why this reads the whole
 * log rather than only what appeared during this run. Restricting it to this
 * run's window would go quiet exactly when the warning still applies: the
 * canister said it once, several runs ago, and will not repeat itself until a
 * top-up and a fresh crossing.
 */
function verdict() {
  const out = cli("icp canister logs backend");
  if (out === null) return null;
  let records;
  try {
    records = JSON.parse(out).log_records ?? [];
  } catch {
    return null;
  }
  const said = records
    .map((r) => r.content)
    .filter((c) => typeof c === "string" && /^(WARN|INFO) cycles/.test(c));
  const latest = said.at(-1);
  return latest?.startsWith("WARN") ? latest : null;
}

function balance() {
  // Read through the CLI rather than an endpoint: the balance is the operator's
  // business, and exposing it would tell everyone how well funded a deployment
  // is.
  const out = cli("icp canister status backend");
  const found = out?.match(/^\s*Cycles:\s*([\d_]+)\s*$/m);
  return found ? Number(found[1].replaceAll("_", "")) : null;
}

const show = (cycles) => (cycles >= T ? `${(cycles / T).toFixed(2)} T` : `${(cycles / 1e9).toFixed(1)} B`);

/**
 * Call at the start of a replica check; call the returned `done()` at the end,
 * before exiting.
 */
export function reportCycles() {
  const opening = balance();
  if (opening !== null) console.log(`backend balance: ${show(opening)}\n`);
  return {
    done() {
      const closing = balance();
      if (opening !== null && closing !== null) {
        const spent = opening - closing;
        console.log(
          spent < MEASURABLE
            ? `\nbackend balance: ${show(closing)} (this run derived nothing measurable)`
            : `\nthis run cost ${show(spent)}; ${show(closing)} left,` +
                ` about ${Math.floor(closing / spent)} more run(s)`,
        );
      }
      // The canister warns about its own balance on every write, into a log
      // only its controllers can read. Surfacing it is what puts it in front of
      // someone — and one arriving while the balance is plainly healthy means
      // the threshold in main.mo is set too high.
      const warning = verdict();
      if (warning) {
        console.log(`\n${warning}\n  icp canister top-up backend --amount 10000000000000`);
      }
    },
  };
}
