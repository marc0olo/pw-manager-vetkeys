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
const ITEM_PREFIX = "vetvault:seen-items:";

/** Vault id to the content it was last seen holding. */
export type Marks = Readonly<Record<string, string>>;

/**
 * Vault id to each of its items' last-seen write time.
 *
 * Nested rather than flat, because **the absence of a vault's entry is the
 * signal for first sight**. A flat `vaultId/itemId` map could not distinguish
 * "this vault has never been opened" from "this vault has no items", and the
 * first must record while the second has nothing to record.
 *
 * Stored under its own key so the vault marks already on disk keep their shape.
 */
export type ItemMarks = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** What a client needs to render a per-item marker. */
export type ItemChange = "new" | "changed";

/**
 * When an item's write time was recorded by the canister.
 *
 * The shape `get_item_summaries` already returns, and which `App` already holds
 * as `itemFacts` — this reads the entries for every item rather than only the
 * selected one, so item-level marks need no request of their own.
 */
export type ItemFacts = Readonly<Record<string, { updatedAt: number }>>;

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
      if (key === null) continue;
      // Both prefixes. Missing one would leave an identity's item marks —
      // which name its vaults and their item ids — behind indefinitely.
      for (const prefix of [PREFIX, ITEM_PREFIX]) {
        if (key.startsWith(prefix) && key !== prefix + keep) stale.push(key);
      }
    }
    // Collected before removing: deleting while iterating by index skips
    // entries, and half a sweep looks exactly like a whole one.
    //
    // Removed by full key rather than by re-deriving the principal, so the
    // prefix check above is the only guard and a test can tell whether it
    // works. An earlier version re-derived the principal and re-applied the
    // prefix, which made an unrelated key survive for a second reason and left
    // the check unfalsifiable.
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable. Nothing here is load-bearing.
  }
}

function readMap<T>(key: string, ok: (value: unknown) => boolean): Record<string, T> {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, T> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (ok(value)) out[id] = value as T;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadItems(principal: string): ItemMarks {
  return readMap<Readonly<Record<string, number>>>(
    ITEM_PREFIX + principal,
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((at) => typeof at === "number"),
  );
}

export function saveItems(principal: string, marks: ItemMarks): void {
  try {
    window.localStorage.setItem(ITEM_PREFIX + principal, JSON.stringify(marks));
  } catch {
    // See `save`. Losing a mark costs a stale flag, nothing more.
  }
}

/**
 * The items in one vault that were added or edited since it was last opened.
 *
 * **A new item is flagged, unlike a new vault** — and the difference is the
 * point rather than an inconsistency. A newly shared vault is visibly new: it
 * was not in the sidebar before. A new row in a two-hundred-item list is not
 * visible at all, so not flagging it would leave the question this exists to
 * answer unanswered.
 *
 * First sight is still recorded rather than flagged, one level down: a vault
 * with no entry has never been opened, so every item in it is unremarkable.
 */
export function changedItems(
  vaultId: string,
  facts: ItemFacts,
  marks: ItemMarks,
): Readonly<Record<string, ItemChange>> {
  const seen = marks[vaultId];
  if (seen === undefined) return {};
  const out: Record<string, ItemChange> = {};
  for (const [id, fact] of Object.entries(facts)) {
    const mark = seen[id];
    if (mark === undefined) out[id] = "new";
    else if (mark !== fact.updatedAt) out[id] = "changed";
  }
  return out;
}

/**
 * Marks after a vault's items have been read.
 *
 * Records the whole vault on first sight and **changes nothing afterwards** —
 * the dots have to survive while the user scans the list, so they clear per
 * item rather than on arrival. Prunes items that are gone, so a vault whose
 * contents churn does not accumulate rows.
 */
export function afterReadingVault(vaultId: string, facts: ItemFacts, marks: ItemMarks): ItemMarks {
  const seen = marks[vaultId];
  if (seen === undefined) {
    const fresh: Record<string, number> = {};
    for (const [id, fact] of Object.entries(facts)) fresh[id] = fact.updatedAt;
    return { ...marks, [vaultId]: fresh };
  }
  const kept: Record<string, number> = {};
  for (const id of Object.keys(facts)) {
    if (seen[id] !== undefined) kept[id] = seen[id];
  }
  return { ...marks, [vaultId]: kept };
}

/** Marks after the user opens one item: that one is now up to date. */
export function afterViewingItem(
  vaultId: string,
  itemId: string,
  facts: ItemFacts,
  marks: ItemMarks,
): ItemMarks {
  const fact = facts[itemId];
  if (fact === undefined) return marks;
  return { ...marks, [vaultId]: { ...(marks[vaultId] ?? {}), [itemId]: fact.updatedAt } };
}

/** Drop the item marks of vaults that are gone. */
export function pruneItems(vaultIds: readonly string[], marks: ItemMarks): ItemMarks {
  const kept: Record<string, Readonly<Record<string, number>>> = {};
  for (const id of vaultIds) {
    if (marks[id] !== undefined) kept[id] = marks[id];
  }
  return kept;
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
