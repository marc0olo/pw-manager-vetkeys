import { vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import type { VaultItem } from "../lib/items";
import type { VaultSummary } from "../lib/vault";

export const ALICE = Principal.fromText("2ibo7-dia");
export const BOB = Principal.fromText("aaaaa-aa");

export const item = (o: Partial<VaultItem> & { id: string; title: string }): VaultItem => ({
  username: "",
  password: "",
  url: "",
  notes: "",
  updatedAt: 0,
  ...o,
});

export const vault = (o: Partial<VaultSummary> = {}): VaultSummary => ({
  owner: ALICE,
  name: "Personal",
  displayName: null,
  isOwned: true,
  rights: null,
  sharedWith: [],
  itemIds: [],
  fingerprint: "f0",
  trashed: 0,
  ...o,
});

/**
 * Stands in for the canister.
 *
 * Deliberately dumb: the tests are about how `App` wires its own pieces
 * together, so this only has to answer, and to be able to refuse the way the
 * real one does — `Error("unauthorized")`, exactly as `KeyManager` returns it.
 */
export class FakeClient {
  me: Principal;
  vaults: VaultSummary[];
  items: Map<string, VaultItem[]>;
  /** Set to make the next mutation refuse, as a revoked grantee would see. */
  refuse: "none" | "write" | "manage" | "open" = "none";

  constructor(me: Principal, vaults: VaultSummary[], items: Record<string, VaultItem[]> = {}) {
    this.me = me;
    this.vaults = vaults;
    this.items = new Map(Object.entries(items));
  }

  listVaults = vi.fn(async () => this.vaults);

  openVault = vi.fn(async (summary: VaultSummary) => {
    if (this.refuse === "open") throw new Error("unauthorized");
    return this.items.get(summary.name) ?? [];
  });

  private guard(kind: "write" | "manage") {
    if (this.refuse === kind) throw new Error("unauthorized");
  }

  saveItem = vi.fn(async () => this.guard("write"));
  deleteItem = vi.fn(async () => this.guard("write"));
  wipe = vi.fn(async () => this.guard("write"));
  rename = vi.fn(async () => this.guard("write"));
  share = vi.fn(async () => this.guard("manage"));
  revoke = vi.fn(async () => this.guard("manage"));
  lock = vi.fn(async () => {});
}

/** A minimal Identity: `App` only ever asks for the principal. */
export const identityFor = (principal: Principal) =>
  ({ getPrincipal: () => principal }) as unknown as import("@icp-sdk/core/agent").Identity;
