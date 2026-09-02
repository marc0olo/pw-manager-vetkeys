import { describe, expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { pollUpdate } from "../poll";
import { NO_VAULT_SESSION, type VaultSessionState } from "../vault-session";
import { OWN_VAULT_NAME, vaultId, type VaultSummary } from "../vault";
import type { VaultItem } from "../items";

const me = Principal.fromText("2ibo7-dia");
const other = Principal.fromText("aaaaa-aa");

const summary = (o: Partial<VaultSummary> = {}): VaultSummary => ({
  owner: me,
  name: OWN_VAULT_NAME,
  displayName: null,
  isOwned: true,
  rights: null,
  sharedWith: [],
  itemIds: [],
  fingerprint: "f0",
  trashed: 0,
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
