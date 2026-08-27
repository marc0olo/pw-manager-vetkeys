import { describe, expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { reconcile } from "../reconcile";
import { OWN_VAULT_NAME, vaultId, type VaultSummary } from "../vault";
import type { VaultItem } from "../items";

/**
 * What the UI does when the canister changes underneath the user. These cases
 * need two actors — someone revoking access or deleting an item while you are
 * looking at it — so they are exactly the ones nobody reproduces by hand.
 */

const me = Principal.fromText("2ibo7-dia");
const other = Principal.fromText("aaaaa-aa");

function summary(overrides: Partial<VaultSummary> = {}): VaultSummary {
  return {
    owner: me,
    name: OWN_VAULT_NAME,
    isOwned: true,
    rights: null,
    sharedWith: [],
    itemIds: [],
    fingerprint: "f0",
    ...overrides,
  };
}

const own = summary({ itemIds: ["a", "b"], fingerprint: "own-1" });
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

describe("nothing selected", () => {
  it("is left alone", () => {
    const result = reconcile({
      previous: [own],
      next: [own],
      selection: { vaultId: null, itemId: null },
      openItems: null,
    });
    expect(result).toEqual({ selection: { vaultId: null, itemId: null }, notice: null, refreshItems: false });
  });
});

describe("a steady state", () => {
  it("changes nothing when the fingerprint is unchanged", () => {
    const result = reconcile({
      previous: [own, shared],
      next: [own, shared],
      selection: { vaultId: vaultId(own), itemId: "a" },
      openItems: [item("a", "GitHub")],
    });
    expect(result.selection).toEqual({ vaultId: vaultId(own), itemId: "a" });
    expect(result.notice).toBeNull();
    expect(result.refreshItems).toBe(false);
  });
});

describe("the open vault's contents changed", () => {
  it("asks for a re-decrypt without disturbing the selection", () => {
    const edited = { ...own, fingerprint: "own-2" };
    const result = reconcile({
      previous: [own],
      next: [edited],
      selection: { vaultId: vaultId(own), itemId: "a" },
      openItems: [item("a", "GitHub")],
    });
    expect(result.selection).toEqual({ vaultId: vaultId(own), itemId: "a" });
    expect(result.refreshItems).toBe(true);
    expect(result.notice).toBeNull(); // an edit elsewhere is not worth a toast
  });

  it("does not ask for a re-decrypt on a vault we are not looking at", () => {
    const editedOther = { ...shared, fingerprint: "shared-2" };
    const result = reconcile({
      previous: [own, shared],
      next: [own, editedOther],
      selection: { vaultId: vaultId(own), itemId: "a" },
      openItems: [item("a", "GitHub")],
    });
    expect(result.refreshItems).toBe(false);
  });
});

describe("the selected item was deleted", () => {
  it("returns to the vault view and names the item", () => {
    const withoutA = { ...own, itemIds: ["b"], fingerprint: "own-2" };
    const result = reconcile({
      previous: [own],
      next: [withoutA],
      selection: { vaultId: vaultId(own), itemId: "a" },
      openItems: [item("a", "GitHub"), item("b", "AWS")],
    });
    expect(result.selection).toEqual({ vaultId: vaultId(own), itemId: null });
    expect(result.notice).toBe("“GitHub” was deleted.");
    expect(result.refreshItems).toBe(true);
  });

  it("still reports the deletion when the title is unknown", () => {
    const withoutA = { ...own, itemIds: ["b"] };
    const result = reconcile({
      previous: [own],
      next: [withoutA],
      selection: { vaultId: vaultId(own), itemId: "a" },
      openItems: null, // not decrypted yet
    });
    expect(result.notice).toBe("That item was deleted.");
    expect(result.selection.itemId).toBeNull();
  });
});

describe("access to the selected vault was revoked", () => {
  // A shared vault only leaves the listing on revocation: emptying it keeps it,
  // because it is listed from the access control list. So the wording can be
  // specific rather than hedged.
  it("moves to the own vault and says access was lost", () => {
    const result = reconcile({
      previous: [own, shared],
      next: [own],
      selection: { vaultId: vaultId(shared), itemId: "x" },
      openItems: [item("x", "Grafana")],
    });
    expect(result.selection).toEqual({ vaultId: vaultId(own), itemId: null });
    expect(result.notice).toBe("“Team infra” is no longer shared with you.");
    expect(result.refreshItems).toBe(true);
  });

  it("falls back to the first vault when there is no own vault", () => {
    const otherShared = summary({ owner: other, name: "Second", isOwned: false });
    const result = reconcile({
      previous: [shared, otherShared],
      next: [otherShared],
      selection: { vaultId: vaultId(shared), itemId: null },
      openItems: null,
    });
    expect(result.selection.vaultId).toBe(vaultId(otherShared));
  });

  it("selects nothing when every vault is gone", () => {
    const result = reconcile({
      previous: [shared],
      next: [],
      selection: { vaultId: vaultId(shared), itemId: "x" },
      openItems: null,
    });
    expect(result.selection).toEqual({ vaultId: null, itemId: null });
    expect(result.notice).toBe("“Team infra” is no longer shared with you.");
  });

  it("uses neutral wording for a vanished owned vault", () => {
    const result = reconcile({
      previous: [own, shared],
      next: [shared],
      selection: { vaultId: vaultId(own), itemId: null },
      openItems: null,
    });
    expect(result.notice).toBe(`“${OWN_VAULT_NAME}” is no longer available.`);
  });
});

describe("a newly shared vault", () => {
  it("appears without disturbing the selection", () => {
    const result = reconcile({
      previous: [own],
      next: [own, shared],
      selection: { vaultId: vaultId(own), itemId: "a" },
      openItems: [item("a", "GitHub")],
    });
    expect(result.selection).toEqual({ vaultId: vaultId(own), itemId: "a" });
    expect(result.notice).toBeNull();
    expect(result.refreshItems).toBe(false);
  });
});
