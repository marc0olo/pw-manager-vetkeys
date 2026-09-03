import { beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { afterPoll, afterViewing, changed, forget, load, save } from "../seen";
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

  it("forgets on request", () => {
    save("alice", { "a/b": "f0" });
    forget("alice");
    expect(load("alice")).toEqual({});
  });

  it("treats corrupt storage as nothing seen, which flags nothing", () => {
    window.localStorage.setItem("vetvault:seen:alice", "not json");
    expect(load("alice")).toEqual({});
    window.localStorage.setItem("vetvault:seen:alice", '["an","array"]');
    expect(load("alice")).toEqual({});
    window.localStorage.setItem("vetvault:seen:alice", '{"a/b":42}');
    expect(load("alice")).toEqual({});
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
