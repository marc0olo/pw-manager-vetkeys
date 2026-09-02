import { vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import type { VaultItem } from "../lib/items";
import type { TrashedItem, VaultSummary } from "../lib/vault";

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
  trashFingerprint: "t0",
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
  /**
   * Whether `discardTrash` refuses. Separate from {@link refuse} on purpose:
   * the canister gates it on ownership, which is not one of the capabilities
   * the UI discovers by attempting.
   */
  refuseDiscard = false;

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

  /** What `listTrash` hands back. Set per test; the count lives on the summary. */
  trash: TrashedItem[] = [];

  listTrash = vi.fn(async () => {
    if (this.refuse === "open") throw new Error("unauthorized");
    return this.trash;
  });
  restoreItem = vi.fn(async (_vault: VaultSummary, _seq: bigint) => this.guard("write"));
  restoreAll = vi.fn(async () => {
    this.guard("write");
    return this.trash.length;
  });
  discardTrash = vi.fn(async () => {
    if (this.refuseDiscard) throw new Error("unauthorized");
    this.guard("write");
    const dropped = this.trash.length;
    this.trash = [];
    return dropped;
  });

  saveItem = vi.fn(async () => this.guard("write"));
  deleteItem = vi.fn(async () => this.guard("write"));
  wipe = vi.fn(async () => this.guard("write"));
  rename = vi.fn(async () => this.guard("write"));
  share = vi.fn(async () => this.guard("manage"));
  revoke = vi.fn(async () => this.guard("manage"));
  lock = vi.fn(async () => {});
}

let nextSeq = 0n;
export const trashed = (o: Partial<TrashedItem> & { item: VaultItem }): TrashedItem => ({
  seq: nextSeq++,
  deletedAt: Date.UTC(2026, 0, 2, 9, 30),
  deletedBy: ALICE,
  ...o,
});

/** A minimal Identity: `App` only ever asks for the principal. */
export const identityFor = (principal: Principal) =>
  ({ getPrincipal: () => principal }) as unknown as import("@icp-sdk/core/agent").Identity;
