import { describe, expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { pollUpdate } from "../poll";
import { NO_VAULT_SESSION, type VaultSessionState } from "../vault-session";
import { vaultId, type VaultSummary } from "../vault";
import type { VaultItem } from "../items";

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

const own = summary({ itemIds: ["a"], fingerprint: "own-1" });
const shared = summary({
  owner: other,
  name: "Team infra",
  isOwned: false,
  rights: { Read: null },
  itemIds: ["x"],
  fingerprint: "shared-1",
});

const item = (id: string, title: string): VaultItem => ({
  id,
  title,
  username: "",
  password: "",
  url: "",
  notes: "",
  updatedAt: 0,
});

const session = (o: Partial<VaultSessionState> = {}): VaultSessionState => ({
  ...NO_VAULT_SESSION,
  vaults: [own],
  openItems: [item("a", "GitHub")],
  selectedVaultId: vaultId(own),
  selectedItemId: "a",
  ...o,
});

const NOW = 1_756_000_000_000;

/**
 * #16 was a wiring bug: `reconcile` was right and the component asked it the
 * wrong question. These cover the asking.
 */
describe("a selection the user never made", () => {
  it("is made explicit, so every later consumer agrees which vault is open", () => {
    const before = session({ selectedVaultId: null, selectedItemId: null });
    expect(pollUpdate(before, [own], NOW).patch.selectedVaultId).toBe(vaultId(own));
  });

  it("still notices the first item being added — the reported bug", () => {
    const empty = summary({ itemIds: [], fingerprint: "own-0" });
    const before = session({
      vaults: [empty],
      openItems: [],
      selectedVaultId: null,
      selectedItemId: null,
    });
    const withOne = summary({ itemIds: ["a"], fingerprint: "own-1" });
    // openItems cleared is what triggers the re-decrypt. Without it the list
    // keeps its stale [] and renders `Nothing matches “”.`
    expect(pollUpdate(before, [withOne], NOW).patch.openItems).toBeNull();
  });
});

describe("the patch", () => {
  it("carries the list and the selection together", () => {
    // Applied in stages, a render could pair the new list with the old
    // selection. One patch makes that unrepresentable.
    const before = session({ selectedVaultId: null, selectedItemId: null });
    const { patch } = pollUpdate(before, [own], NOW);
    expect(patch.vaults).toEqual([own]);
    expect(patch.selectedVaultId).toBe(vaultId(own));
  });

  it("records when the list was read", () => {
    expect(pollUpdate(session(), [own], NOW).patch.syncedAt).toBe(NOW);
  });

  it("leaves the decrypted items alone when nothing changed", () => {
    expect(pollUpdate(session(), [own], NOW).patch).not.toHaveProperty("openItems");
  });

  it("leaves an open editor alone when nothing changed", () => {
    const before = session({ pane: { mode: "edit", item: item("a", "GitHub"), isNew: false } });
    expect(pollUpdate(before, [own], NOW).patch).not.toHaveProperty("pane");
  });

  it("closes the editor when the item it holds was deleted", () => {
    const before = session({ pane: { mode: "edit", item: item("a", "GitHub"), isNew: false } });
    const emptied = summary({ itemIds: [], fingerprint: "own-2" });
    const { patch, notice } = pollUpdate(before, [emptied], NOW);
    expect(patch.pane).toEqual({ mode: "view" });
    expect(patch.selectedItemId).toBeNull();
    expect(notice).toBe("“GitHub” was deleted.");
  });
});

describe("being moved off a vault", () => {
  it("is reported, so a banner naming the old vault can be cleared", () => {
    const before = session({ vaults: [own, shared], selectedVaultId: vaultId(shared), selectedItemId: "x" });
    const { movedVault, notice } = pollUpdate(before, [own], NOW);
    expect(movedVault).toBe(true);
    expect(notice).toBe("“Team infra” is no longer shared with you.");
  });

  it("is not reported when the user stays put", () => {
    expect(pollUpdate(session(), [own], NOW).movedVault).toBe(false);
  });

  it("is not reported merely because the selection was implicit", () => {
    // Resolving null to the vault already on screen is not a move, and must not
    // clear an error banner that still applies to it.
    const before = session({ selectedVaultId: null, selectedItemId: null });
    expect(pollUpdate(before, [own], NOW).movedVault).toBe(false);
  });
});

describe("what counts as a change for a manual check", () => {
  // `changed` decides whether a by-hand check says "Already up to date". It has
  // to cover everything on screen the poll can move, not just the digests —
  // otherwise a check right after an owner shares the vault or changes your
  // access reports nothing while the screen visibly changed.
  const state = (vaults: VaultSummary[]): VaultSessionState => ({
    ...NO_VAULT_SESSION,
    vaults,
  });
  const bob = Principal.fromText("aaaaa-aa");

  it("reports nothing when nothing moved", () => {
    const before = [summary()];
    expect(pollUpdate(state(before), [summary()], 0).changed).toBe(false);
  });

  it("notices a new member, which moves no digest", () => {
    const outcome = pollUpdate(
      state([summary({ sharedWith: [] })]),
      [summary({ sharedWith: [[bob, { ReadWrite: null }]] })],
      0,
    );
    expect(outcome.changed).toBe(true);
  });

  it("notices one member swapped for another, which leaves the count alone", () => {
    const other = Principal.fromText("2ibo7-dia");
    const outcome = pollUpdate(
      state([summary({ sharedWith: [[bob, { ReadWrite: null }]] })]),
      [summary({ sharedWith: [[other, { ReadWrite: null }]] })],
      0,
    );
    expect(outcome.changed).toBe(true);
  });

  it("notices being downgraded, which decides what controls exist", () => {
    const outcome = pollUpdate(
      state([summary({ isOwned: false, rights: { ReadWrite: null } })]),
      [summary({ isOwned: false, rights: { Read: null } })],
      0,
    );
    expect(outcome.changed).toBe(true);
  });

  it("notices a rename, which moves neither digest nor id", () => {
    const outcome = pollUpdate(state([summary({ displayName: null })]), [summary({ displayName: "Work" })], 0);
    expect(outcome.changed).toBe(true);
  });

  it("ignores the order the canister happened to list them in", () => {
    const a = summary({ name: "a" });
    const b = summary({ name: "b" });
    expect(pollUpdate(state([a, b]), [b, a], 0).changed).toBe(false);
  });
});
