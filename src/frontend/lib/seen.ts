import { vaultId, type VaultSummary } from "./vault";

/**
 * "Which vaults changed since I last looked."
 *
 * A per-vault mark, recorded when the user views that vault, compared against
 * what the poll brings back. Nothing new crosses the wire: `get_vault_summaries`
 * already carries a content digest and a trash digest per vault, and the poll
 * already reads it every 15 seconds — this is a second reader of data that was
 * being used only to refresh the view.
 *
 * ## Why marks are not part of the session
 *
 * Every other piece of per-vault UI state lives in `VaultSessionState` and is
 * cleared on lock, because it holds plaintext or an open dialog. These are
 * different: they are metadata about vaults, and "changed since I last looked"
 * is meaningless if locking resets it. So they persist in `localStorage`,
 * beside the activity mark.
 *
 * Keyed per principal for the same reason the activity mark is: signing in as
 * someone else must not inherit the previous identity's marks.
 *
 * They do name vaults, on the device. That is the same exposure vault names
 * already have — access control is enforced in the clear — but it is now on
 * disk locally rather than only in the canister, which is worth knowing.
 *
 * ## Why first sight records rather than flags
 *
 * A vault seen for the first time is recorded as seen, not reported as changed.
 * Otherwise every vault is flagged on a new device, in a fresh browser, or
 * after clearing site data — which is the noise this exists to avoid. The
 * signal has to mean "someone touched this since you looked", and a device that
 * has never looked has no basis for that claim.
 *
 * A newly shared vault is also not flagged. It is *visibly* new — it was not in
 * the list before — so a marker would be decoration rather than information.
 */

const PREFIX = "vetvault:seen:";

/** Vault id to the content it was last seen holding. */
export type Marks = Readonly<Record<string, string>>;

/**
 * What a viewer has seen *inside* a vault.
 *
 * Contents and trash, and deliberately nothing else. A rename or a membership
 * change is not "someone added, changed or deleted something" — those are
 * visible in the row itself, and counting them would flag a vault for an event
 * the user can already see.
 */
function contents(vault: VaultSummary): string {
  return `${vault.fingerprint}:${vault.trashFingerprint}`;
}

export function load(principal: string): Marks {
  try {
    const raw = window.localStorage.getItem(PREFIX + principal);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    // Hand-editable storage, and a wrong shape here would throw on every poll.
    // Anything unexpected reads as "nothing seen yet", which flags nothing.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const marks: Record<string, string> = {};
    for (const [id, mark] of Object.entries(parsed)) {
      if (typeof mark === "string") marks[id] = mark;
    }
    return marks;
  } catch {
    return {};
  }
}

export function save(principal: string, marks: Marks): void {
  try {
    window.localStorage.setItem(PREFIX + principal, JSON.stringify(marks));
  } catch {
    // Private browsing, or a full quota. Losing the marks costs a stale
    // "changed" flag, so it is not worth failing anything the user is doing.
  }
}

export function forget(principal: string): void {
  try {
    window.localStorage.removeItem(PREFIX + principal);
  } catch {
    // Nothing to recover from.
  }
}

/**
 * The vaults whose contents moved since they were last looked at.
 *
 * A vault with no mark is not included — see "first sight" above.
 */
export function changed(vaults: VaultSummary[], marks: Marks): readonly string[] {
  return vaults
    .filter((vault) => {
      const mark = marks[vaultId(vault)];
      return mark !== undefined && mark !== contents(vault);
    })
    .map(vaultId);
}

/**
 * Marks after a poll: every vault the user is looking at is up to date, and
 * every vault seen for the first time is recorded rather than flagged.
 *
 * `viewing` is the selected vault, whose mark advances on every poll — you are
 * watching it, so a change arriving while you watch is not something you have
 * yet to see.
 *
 * Also drops marks for vaults that are gone, so a deleted or unshared vault
 * does not accumulate a row forever.
 */
export function afterPoll(vaults: VaultSummary[], marks: Marks, viewing: string | null): Marks {
  const next: Record<string, string> = {};
  for (const vault of vaults) {
    const id = vaultId(vault);
    const seen = marks[id];
    next[id] = seen === undefined || id === viewing ? contents(vault) : seen;
  }
  return next;
}

/** Marks after the user opens a vault: that one is now up to date. */
export function afterViewing(vaults: VaultSummary[], marks: Marks, viewing: string): Marks {
  const vault = vaults.find((candidate) => vaultId(candidate) === viewing);
  if (vault === undefined) return marks;
  return { ...marks, [viewing]: contents(vault) };
}
