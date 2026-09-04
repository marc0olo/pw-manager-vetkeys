import { beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import {
  afterPoll,
  afterReadingVault,
  afterViewing,
  afterViewingItem,
  changed,
  changedItems,
  load,
  loadItems,
  pruneItems,
  save,
  saveItems,
  sweep,
} from "../seen";
import { vaultId, type VaultSummary } from "../vault";

/**
 * The rules behind "which vaults changed since I last looked".
 *
 * Every one of these is about *not* crying wolf: the signal is worth having
 * only if it means someone else touched the vault, so the interesting cases are
 * the ones where it must stay quiet.
 */

const me = Principal.fromText("2ibo7-dia");
const other = Principal.fromText("aaaaa-aa");

const summary = (o: Partial<VaultSummary> = {}): VaultSummary => ({
  owner: me,
  name: "Personal",
  displayName: null,
  isOwned: true,
  rights: null,
  sharedWith: [],
  itemIds: [],
  fingerprint: "f0",
  trashed: 0,
  trashFingerprint: "t0",
  ...o,
});

describe("what counts as changed", () => {
  it("says nothing about a vault seen for the first time", () => {
    // Otherwise every vault is flagged on a new device, in a fresh browser, or
    // after clearing site data — which is the noise this exists to avoid.
    const vaults = [summary()];
    expect(changed(vaults, {})).toEqual([]);
  });

  it("records first sight instead of flagging it", () => {
    const vaults = [summary()];
    const marks = afterPoll(vaults, {}, null);
    expect(changed(vaults, marks)).toEqual([]);
  });

  it("flags a vault whose contents moved while you were elsewhere", () => {
    const before = [summary({ fingerprint: "f0" })];
    const marks = afterPoll(before, {}, null);

    const after = [summary({ fingerprint: "f1" })];
    expect(changed(after, marks)).toEqual([vaultId(after[0])]);
  });

  it("flags a change to the trash as well as to the items", () => {
    const marks = afterPoll([summary()], {}, null);
    expect(changed([summary({ trashFingerprint: "t1" })], marks)).toHaveLength(1);
  });

  it("says nothing when only the name changed", () => {
    // A rename is visible in the row itself. Flagging it would report an event
    // the user can already see.
    const marks = afterPoll([summary()], {}, null);
    expect(changed([summary({ displayName: "Work" })], marks)).toEqual([]);
  });

  it("says nothing when only the membership changed", () => {
    const marks = afterPoll([summary()], {}, null);
    const shared = summary({ sharedWith: [[other, { Read: null }]] });
    expect(changed([shared], marks)).toEqual([]);
  });

  it("does not flag the vault you are looking at", () => {
    // You are watching it, so a change arriving while you watch is not
    // something you have yet to see.
    const before = [summary({ fingerprint: "f0" })];
    const id = vaultId(before[0]);
    let marks = afterPoll(before, {}, id);

    marks = afterPoll([summary({ fingerprint: "f1" })], marks, id);
    expect(changed([summary({ fingerprint: "f1" })], marks)).toEqual([]);
  });

  it("clears the flag once you open it", () => {
    const marks = afterPoll([summary({ fingerprint: "f0" })], {}, null);
    const moved = [summary({ fingerprint: "f1" })];
    const id = vaultId(moved[0]);
    expect(changed(moved, marks)).toEqual([id]);

    expect(changed(moved, afterViewing(moved, marks, id))).toEqual([]);
  });

  it("flags again if it moves after you looked", () => {
    let marks = afterPoll([summary({ fingerprint: "f0" })], {}, null);
    const id = vaultId(summary());
    marks = afterViewing([summary({ fingerprint: "f1" })], marks, id);
    expect(changed([summary({ fingerprint: "f2" })], marks)).toEqual([id]);
  });

  it("forgets a vault that is gone, rather than keeping a row forever", () => {
    const two = [summary({ name: "a" }), summary({ name: "b" })];
    const marks = afterPoll(two, {}, null);
    expect(Object.keys(marks)).toHaveLength(2);

    expect(Object.keys(afterPoll([two[0]], marks, null))).toEqual([vaultId(two[0])]);
  });

  it("does not resurrect a mark for a vault that came back", () => {
    // Unshared then shared again is a first sight, not a change: whatever
    // happened while you had no access is not something you failed to look at.
    const vaults = [summary({ fingerprint: "f0" })];
    const marks = afterPoll(vaults, {}, null);
    const gone = afterPoll([], marks, null);
    const back = afterPoll([summary({ fingerprint: "f9" })], gone, null);
    expect(changed([summary({ fingerprint: "f9" })], back)).toEqual([]);
  });
});

describe("where the marks live", () => {
  beforeEach(() => window.localStorage.clear());

  it("survives a lock, unlike everything in the session state", () => {
    // The whole point: "since I last looked" is meaningless if locking resets
    // it. Every field in VaultSessionState is cleared on lock; these are not
    // in it.
    save("me", { "a/b": "f0" });
    expect(load("me")).toEqual({ "a/b": "f0" });
  });

  it("is scoped per principal", () => {
    save("alice", { "a/b": "f0" });
    expect(load("bob")).toEqual({});
  });

  it("treats corrupt storage as nothing seen, which flags nothing", () => {
    window.localStorage.setItem("vetvault:seen:alice", "not json");
    expect(load("alice")).toEqual({});
    window.localStorage.setItem("vetvault:seen:alice", '["an","array"]');
    expect(load("alice")).toEqual({});
    window.localStorage.setItem("vetvault:seen:alice", '{"a/b":42}');
    expect(load("alice")).toEqual({});
  });

  it("keeps only the signed-in principal's marks", () => {
    // Another identity's marks name the *owners* of vaults shared with them, so
    // a shared device should not accumulate them.
    save("alice", { "a/b": "f0" });
    save("bob", { "c/d": "f1" });
    save("carol", { "e/f": "f2" });

    sweep("alice");

    expect(load("alice")).toEqual({ "a/b": "f0" });
    expect(load("bob")).toEqual({});
    expect(load("carol")).toEqual({});
  });

  it("sweeps every stale principal, not just the first", () => {
    // Removing while iterating by index skips entries, which would leave half
    // of them behind and look like it worked.
    for (const who of ["b", "c", "d", "e", "f"]) save(who, { "x/y": "f" });
    save("alice", { "a/b": "f0" });

    sweep("alice");

    for (const who of ["b", "c", "d", "e", "f"]) expect(load(who)).toEqual({});
    expect(load("alice")).toEqual({ "a/b": "f0" });
  });

  it("leaves other storage alone", () => {
    // Now load-bearing: `sweep` removes by full key, so the prefix check is
    // the only thing standing between it and every other key in storage.
    // Removing that check fails this.
    window.localStorage.setItem("vetvault:last-active", "123");
    window.localStorage.setItem("something-else", "x");
    save("alice", { "a/b": "f0" });

    sweep("alice");

    expect(window.localStorage.getItem("vetvault:last-active")).toBe("123");
    expect(window.localStorage.getItem("something-else")).toBe("x");
  });

  it("writes no readable vault name", () => {
    // The claim in the docstring, asserted: a mark is
    // `<owner>/<map id>` -> `<digest>:<digest>`, and the display name — the
    // only human-readable name a vault has — is not part of either.
    const named = summary({ name: "a3f1b2c4d5e6", displayName: "Divorce lawyer" });
    save("alice", afterPoll([named], {}, null));

    const raw = window.localStorage.getItem("vetvault:seen:alice") ?? "";
    expect(raw).not.toContain("Divorce");
    expect(raw).toContain("a3f1b2c4d5e6");
  });

  it("does not fail the caller when storage is unavailable", () => {
    // Private browsing, or a full quota. Losing a mark costs a stale flag,
    // which is not worth failing anything the user is doing.
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => save("alice", { "a/b": "f0" })).not.toThrow();
    setItem.mockRestore();
  });
});

describe("which items in a vault changed", () => {
  // The reason this exists: "Work changed" in a two-hundred-item vault is a
  // signal nobody can act on. It reads `updatedAt` from the facts the vault
  // open already fetched, so it costs no request.
  const V = "2ibo7-dia/a3f1";
  const facts = (o: Record<string, number>) =>
    Object.fromEntries(Object.entries(o).map(([id, at]) => [id, { updatedAt: at }]));

  it("says nothing the first time a vault is opened", () => {
    // One level down from the vault rule, and for the same reason: a vault
    // never opened has no basis to claim anything in it moved.
    expect(changedItems(V, facts({ a: 1, b: 2 }), {})).toEqual({});
  });

  it("records that first sight rather than flagging it", () => {
    const marks = afterReadingVault(V, facts({ a: 1, b: 2 }), {});
    expect(changedItems(V, facts({ a: 1, b: 2 }), marks)).toEqual({});
  });

  it("flags an edited item", () => {
    const marks = afterReadingVault(V, facts({ a: 1, b: 2 }), {});
    expect(changedItems(V, facts({ a: 9, b: 2 }), marks)).toEqual({ a: "changed" });
  });

  it("flags an added item, unlike an added vault", () => {
    // A vault appearing in the sidebar is visibly new; a row in a long list is
    // not. So the rule differs by one level, deliberately.
    const marks = afterReadingVault(V, facts({ a: 1 }), {});
    expect(changedItems(V, facts({ a: 1, b: 2 }), marks)).toEqual({ b: "new" });
  });

  it("keeps flagging while the list is being read", () => {
    // Clearing on arrival would flash the dots once and lose them, which is
    // the opposite of useful in a long list.
    let marks = afterReadingVault(V, facts({ a: 1 }), {});
    marks = afterReadingVault(V, facts({ a: 9 }), marks);
    expect(changedItems(V, facts({ a: 9 }), marks)).toEqual({ a: "changed" });
  });

  it("clears one item when that item is opened", () => {
    let marks = afterReadingVault(V, facts({ a: 1, b: 1 }), {});
    const moved = facts({ a: 9, b: 9 });
    expect(Object.keys(changedItems(V, moved, marks))).toHaveLength(2);

    marks = afterViewingItem(V, "a", moved, marks);
    expect(changedItems(V, moved, marks)).toEqual({ b: "changed" });
  });

  it("forgets an item that is gone, rather than keeping a row forever", () => {
    let marks = afterReadingVault(V, facts({ a: 1, b: 1 }), {});
    marks = afterReadingVault(V, facts({ a: 1 }), marks);
    expect(Object.keys(marks[V])).toEqual(["a"]);
  });

  it("does not resurrect a mark for an item that came back", () => {
    // Deleted then restored is a first sight for that item: whatever it held
    // while it was gone is not something you failed to look at.
    let marks = afterReadingVault(V, facts({ a: 1 }), {});
    marks = afterReadingVault(V, facts({}), marks);
    marks = afterReadingVault(V, facts({ a: 5 }), marks);
    expect(changedItems(V, facts({ a: 5 }), marks)).toEqual({ a: "new" });
  });

  it("forgets a vault that is gone", () => {
    const marks = afterReadingVault(V, facts({ a: 1 }), {});
    expect(pruneItems([], marks)).toEqual({});
    expect(pruneItems([V], marks)).toEqual(marks);
  });

  it("is stored under its own key, so the vault marks keep their shape", () => {
    window.localStorage.clear();
    save("alice", { [V]: "d:d" });
    saveItems("alice", afterReadingVault(V, facts({ a: 1 }), {}));

    expect(load("alice")).toEqual({ [V]: "d:d" });
    expect(loadItems("alice")[V]).toEqual({ a: 1 });
  });

  it("is swept with the vault marks when another identity signs in", () => {
    window.localStorage.clear();
    saveItems("alice", { [V]: { a: 1 } });
    saveItems("bob", { [V]: { a: 1 } });

    sweep("alice");

    expect(loadItems("alice")[V]).toEqual({ a: 1 });
    expect(loadItems("bob")).toEqual({});
  });

  it("treats corrupt item storage as nothing seen", () => {
    window.localStorage.setItem("vetvault:seen-items:alice", '{"v":{"a":"not a number"}}');
    expect(loadItems("alice")).toEqual({});
  });
});
