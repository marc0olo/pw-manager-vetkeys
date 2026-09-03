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
 * ## What this actually writes
 *
 * Worth being exact, because "vault names on disk" would be wrong in both
 * directions. A mark is `<owner principal>/<map id>` → `<digest>:<digest>`. The
 * **display name is not written** — that is the only human-readable name a
 * vault has, so nothing on disk says `Divorce lawyer`. Map ids are random for
 * vaults this app creates; one created by a different client could carry a
 * readable map name, and that would be written.
 *
 * What *is* new is the keys: they carry the **owner principals of vaults shared
 * with you**, and how many vaults each of them shares. Before this, this app's
 * `localStorage` held only your own principal and an activity timestamp — so
 * this is the first time it records other people's identifiers.
 *
 * {@link sweep} drops the marks of every principal except the one signed in,
 * for the same reason `purgeKeyMaterial` deletes stores "left by a principal no
 * longer recorded": a shared device should not accumulate other identities'
 * data. Deliberately at sign-in and not on lock — sweeping on lock would take
 * the current principal's marks with it, which is the whole thing this design
 * keeps.
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
 * Drop the marks of every principal except this one.
 *
 * Bounds what a shared device keeps. Without it each identity leaves a set
 * behind indefinitely, and those sets name the *owners* of vaults shared with
 * that identity — see the note above.
 *
 * Called at sign-in rather than at lock: locking must leave the current
 * principal's marks alone, or "changed since I last looked" resets every time
 * the vault locks.
 */
export function sweep(keep: string): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null && key.startsWith(PREFIX) && key !== PREFIX + keep) {
        stale.push(key.slice(PREFIX.length));
      }
    }
    // Collected before removing: deleting while iterating by index skips
    // entries, and half a sweep looks exactly like a whole one.
    //
    // The prefix is checked here *and* re-applied by `forget`, so a key
    // belonging to something else survives either way. Belt and braces rather
    // than one guard doing the work — worth saying, because a test cannot tell
    // which of the two saved it.
    for (const principal of stale) forget(principal);
  } catch {
    // Storage unavailable. Nothing here is load-bearing.
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
