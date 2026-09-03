import { vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import type { VaultItem } from "../lib/items";
import type { ItemVersion, TrashedItem, VaultSummary } from "../lib/vault";

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
  restoreVersion = vi.fn(async (_vault: VaultSummary, _seq: bigint) => this.guard("write"));

  /** Versions per item id, for the history section. */
  itemVersions: Record<string, ItemVersion[]> = {};

  itemSummaries = vi.fn(async () =>
    Object.fromEntries(
      Object.entries(this.itemVersions).map(([id, rows]) => [
        id,
        { versions: rows.length, updatedAt: rows[0]?.at ?? Date.UTC(2026, 0, 3, 11, 15) },
      ]),
    ),
  );
  versions = vi.fn(async (_vault: VaultSummary, itemId: string) => this.itemVersions[itemId] ?? []);
  dropHistory = vi.fn(async (_vault: VaultSummary, itemId: string) => {
    if (this.refuseDrop) throw new Error("unauthorized");
    const dropped = (this.itemVersions[itemId] ?? []).length;
    this.itemVersions[itemId] = [];
    return dropped;
  });
  /** Owner-only on the canister, so it refuses independently of write access. */
  refuseDrop = false;
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

  /** Names passed to `createVault`, so a test can assert the map name is opaque. */
  created: { name: string; displayName: string }[] = [];

  createVault = vi.fn(async (displayName: string) => {
    // Mirrors the real one: an opaque map name, then the display name.
    const name = Array.from({ length: 24 }, (_, i) => "0123456789abcdef"[(i * 7) % 16]).join("");
    this.created.push({ name, displayName });
    this.vaults = [...this.vaults, vault({ owner: this.me, name, displayName, itemIds: [] })];
    return name;
  });

  deleteVault = vi.fn(async (summary: VaultSummary) => {
    this.vaults = this.vaults.filter((v) => v.name !== summary.name || v.owner.compareTo(summary.owner) !== "eq");
    this.items.delete(summary.name);
  });

  saveItem = vi.fn(async () => this.guard("write"));
  deleteItem = vi.fn(async () => this.guard("write"));
  wipe = vi.fn(async () => this.guard("write"));
  rename = vi.fn(async () => this.guard("write"));
  share = vi.fn(async () => this.guard("manage"));
  revoke = vi.fn(async () => this.guard("manage"));
  lock = vi.fn(async () => {});
}

export const version = (o: Partial<ItemVersion> & { item: VaultItem }): ItemVersion => ({
  seq: nextSeq++,
  at: Date.UTC(2026, 0, 3, 11, 15),
  by: ALICE,
  kind: "Edited",
  ...o,
});

let nextSeq = 0n;
export const trashed = (o: Partial<TrashedItem> & { item: VaultItem }): TrashedItem => ({
  seq: nextSeq++,
  deletedAt: Date.UTC(2026, 0, 2, 9, 30),
  deletedBy: ALICE,
  ...o,
});

/**
 * A clipboard, which jsdom does not provide.
 *
 * Returned so a test can assert what was written — copying a *version's*
 * password must go through the same path as the live one, or the auto-clear in
 * lib/clipboard.ts silently stops applying to it.
 */
export function fakeClipboard() {
  const board = { text: "" };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        board.text = text;
      }),
      readText: vi.fn(async () => board.text),
    },
  });
  return board;
}

/** A minimal Identity: `App` only ever asks for the principal. */
export const identityFor = (principal: Principal) =>
  ({ getPrincipal: () => principal }) as unknown as import("@icp-sdk/core/agent").Identity;
