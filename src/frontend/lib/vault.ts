import { HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import {
  DefaultEncryptedMapsClient,
  EncryptedMaps,
  IndexedDbDerivedKeyMaterialCache,
  type AccessRights,
} from "@icp-sdk/vetkeys/encrypted_maps";
import { compareItems, decodeItem, encodeItem, type VaultItem } from "./items";
import { backendActor } from "./backend";
import { keyCacheName } from "./session";

export type { AccessRights };

/** The one vault every user owns. Vault names are capped at 32 bytes. */
export const OWN_VAULT_NAME = "Personal";

/**
 * What a poll knows about a vault, without decrypting anything.
 *
 * `itemIds` is available because EncryptedMaps encrypts values but not keys, so
 * the poll can see which items exist — and therefore which have been deleted —
 * with no key material involved.
 */
export interface VaultSummary {
  /** Principal that owns the vault — half of the vault's identity. */
  owner: Principal;
  name: string;
  /**
   * The name the owner chose for display, or null if they never renamed it.
   *
   * Separate from `name` because they are different things: `name` is half the
   * vault's identity and the vetKey derivation input, so it can never change,
   * while this is a label. Address the canister with `name`; show the user
   * {@link vaultLabel}.
   */
  displayName: string | null;
  /** False for a vault someone else shared with us. */
  isOwned: boolean;
  /**
   * Our rights on a shared vault; owners implicitly have full rights.
   *
   * Null for every vault shared *with* us: the canister will not disclose a
   * vault's membership to a non-manager, and the library flattens that refusal
   * to an empty list. See issue #9 and dfinity/vetkeys#438.
   */
  rights: AccessRights | null;
  /** Who this vault is shared with (owner excluded). Owned vaults only. */
  sharedWith: [Principal, AccessRights][];
  /** Item ids present on the canister. Plaintext map keys, so no key needed. */
  itemIds: string[];
  /** Digest of the stored ciphertext, to spot a change without decrypting. */
  fingerprint: string;
}

/** A vault whose items have been decrypted. */
export interface Vault extends VaultSummary {
  items: VaultItem[];
}

export const ACCESS_LEVELS = ["Read", "ReadWrite", "ReadWriteManage"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * What to show the user for a vault.
 *
 * Never use `name` in the UI: a renamed vault would still display its original
 * name, which is the whole thing renaming exists to avoid.
 */
export function vaultLabel(vault: VaultSummary): string {
  // `||` rather than `??`: an empty display name means "no name", and rendering
  // a blank vault title would be a bad way to discover one had been stored. The
  // canister removes the row instead of storing "", so this is belt-and-braces.
  return vault.displayName || vault.name;
}

export function accessLevel(rights: AccessRights): AccessLevel {
  return Object.keys(rights)[0] as AccessLevel;
}

export function toAccessRights(level: AccessLevel): AccessRights {
  return { [level]: null } as AccessRights;
}

/**
 * Which vault to show when the user has not chosen one.
 *
 * A single policy, used both for the initial selection and as `reconcile`'s
 * fallback when the selected vault disappears. Those were two different rules —
 * "the first vault" in the component and "your own vault, else the first" here —
 * which is the kind of split that produces a UI disagreeing with itself.
 */
export function defaultVaultId(vaults: VaultSummary[]): string | null {
  const preferred = vaults.find((vault) => vault.isOwned && vault.name === OWN_VAULT_NAME) ?? vaults[0];
  return preferred ? vaultId(preferred) : null;
}

export function canWrite(vault: VaultSummary): boolean {
  return vault.isOwned || (vault.rights !== null && accessLevel(vault.rights) !== "Read");
}

export function canManage(vault: VaultSummary): boolean {
  return vault.isOwned || (vault.rights !== null && accessLevel(vault.rights) === "ReadWriteManage");
}

export function vaultId(vault: Pick<VaultSummary, "owner" | "name">): string {
  return `${vault.owner.toText()}/${vault.name}`;
}

/**
 * The vault canister's ID, injected by `icp deploy` into every canister's
 * settings and delivered to the frontend through the `ic_env` cookie.
 */
function backendCanisterId(): string {
  const id = safeGetCanisterEnv<{ readonly "PUBLIC_CANISTER_ID:backend": string }>()?.[
    "PUBLIC_CANISTER_ID:backend"
  ];
  if (!id) {
    throw new Error(
      "Backend canister ID missing from the ic_env cookie. Deploy with `icp deploy`, " +
        "or start the local network before `npm run dev`.",
    );
  }
  return id;
}

/** Fingerprint of an empty vault — no bytes to digest. */
const EMPTY_FINGERPRINT = "";

/**
 * Digest the stored ciphertext of a vault, so a poll can tell whether its
 * contents changed without holding a key. Keys are sorted first, since the
 * canister does not promise an order.
 */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The single choke point for turning a vault name into the bytes that identify a
 * map. Every read, write, share and revoke goes through it.
 *
 * Rejects surrounding whitespace rather than trimming it. A vault *is*
 * `(owner, name)`, so trimming here would silently address a different map than
 * the caller named — and two vaults called `"Work"` and `"Work "` would be
 * indistinguishable on screen while being separate stores. Validating where
 * names enter the system keeps that state from ever existing.
 */
function nameBytes(name: string): Uint8Array {
  if (name !== name.trim()) {
    throw new Error("A vault name cannot start or end with a space.");
  }
  const bytes = encoder.encode(name);
  if (bytes.length === 0) throw new Error("A vault name cannot be empty.");
  // Bytes, not characters: the Rust implementation types a map name as
  // Blob<32>, so a longer name would be data only a Motoko backend could hold.
  if (bytes.length > 32) throw new Error("A vault name must be at most 32 bytes.");
  return bytes;
}

/** True if a name can address a map. Use before offering it as a vault name. */
export function isValidVaultName(name: string): boolean {
  try {
    nameBytes(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Thin, typed façade over EncryptedMaps.
 *
 * Encryption and decryption happen here in the browser; the canister only ever
 * holds ciphertext.
 *
 * **Derived key material is cached in IndexedDB**, namespaced per principal.
 * Each vault costs one `vetkd_derive_key` call to open, so a user with a handful
 * of shared vaults pays that many derivations on *every* page load — real cycles
 * (~0.026 XDR each on `key_1`), not just latency. The cache removes that for
 * reloads inside the session window.
 *
 * The safety of persisting it rests entirely on the cache having the same
 * lifetime as the session that authorised it. That is enforced in ./session:
 * every load either resumes a session inside the idle window or purges the
 * delegation *and* these stores together, and every lock does the same. The
 * per-principal namespace keeps one identity's keys from ever being served to
 * another on this origin.
 */
export class VaultClient {
  private constructor(
    private readonly encryptedMaps: EncryptedMaps,
    readonly me: Principal,
    /** This app's own endpoints, beside the ones the mixin contributes. */
    private readonly backend: ReturnType<typeof backendActor>,
  ) {}

  static async create(identity: Identity): Promise<VaultClient> {
    const canisterId = backendCanisterId();
    const agent = await HttpAgent.create({
      identity,
      host: window.location.origin,
      rootKey: safeGetCanisterEnv()?.IC_ROOT_KEY,
    });
    const principal = identity.getPrincipal();
    const encryptedMaps = new EncryptedMaps(new DefaultEncryptedMapsClient(agent, canisterId), {
      cache: new IndexedDbDerivedKeyMaterialCache(keyCacheName(principal.toText())),
    });
    return new VaultClient(encryptedMaps, principal, backendActor(agent, canisterId));
  }

  /**
   * Every vault we can read, with all items decrypted.
   *
   * The canister only reports *non-empty* owned vaults, so a brand-new user has
   * nothing to list — the caller always shows their own vault regardless.
   */
  /**
   * Every vault we can see, with **no decryption and no key derivation**.
   *
   * Reads through the raw canister client rather than
   * `EncryptedMaps.getAllAccessibleMaps()`, which would decrypt every value in
   * every vault and so cost one `vetkd_derive_key` per vault on every call. This
   * is one query returning ciphertext, which is what makes polling affordable:
   * a user with 26 accessible vaults pays 0 derivations here instead of 26.
   */
  async listVaults(): Promise<VaultSummary[]> {
    // Both are queries and neither derives a key, so they go together rather
    // than adding a round trip to the poll path.
    //
    // `get_vault_summaries` is this app's endpoint rather than the mixin's
    // `get_all_accessible_encrypted_maps`: same listing, but the values are
    // replaced by one digest per vault. The values are the bulk — 14.6 KiB of
    // a 14.6 KiB response at 50 items — and the poll never needed them, only a
    // way to tell whether they had changed. Opening a vault fetches them.
    const [maps, named] = await Promise.all([
      this.backend.get_vault_summaries(),
      this.backend.get_vault_names(),
    ]);
    // Keyed with `vaultId` rather than a hand-rolled `owner/name`: it is the
    // canonical form, and a second answer to "how is a vault addressed" is
    // exactly what #16 was.
    const displayNames = new Map(
      named.map((row) => [
        vaultId({ owner: row.owner, name: decoder.decode(Uint8Array.from(row.map_name.inner)) }),
        row.display_name,
      ]),
    );

    const summaries = maps.map((map): VaultSummary => {
      const owner = map.owner;
      const isOwned = owner.compareTo(this.me) === "eq";
      const rights = map.access_control.find(([who]) => who.compareTo(this.me) === "eq")?.[1] ?? null;
      const name = decoder.decode(Uint8Array.from(map.map_name.inner));
      return {
        owner,
        name,
        displayName: displayNames.get(vaultId({ owner, name })) ?? null,
        isOwned,
        rights: isOwned ? null : rights,
        sharedWith: map.access_control.filter(([who]) => who.compareTo(owner) !== "eq"),
        itemIds: map.item_keys.map((key) => decoder.decode(Uint8Array.from(key.inner))),
        fingerprint: hex(Uint8Array.from(map.digest.inner)),
      };
    });

    // A ReadWriteManage grantee can get the owner's own map listed twice — once
    // from the ACL and once as owned — because an ACL mutation targeting the
    // owner is accepted, and the canister then concatenates the two sources
    // without de-duplicating. Both halves are dfinity/vetkeys#437 (see #10),
    // which is also why that issue is cited for owner-targeted ACL writes in
    // scripts/check-capabilities.mjs. Two entries with the same id would also
    // collide as React keys.
    const seen = new Set<string>();
    const vaults = summaries.filter((summary) => {
      const id = vaultId(summary);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    if (!vaults.some((vault) => vault.isOwned && vault.name === OWN_VAULT_NAME)) {
      vaults.unshift({
        owner: this.me,
        name: OWN_VAULT_NAME,
        displayName: displayNames.get(vaultId({ owner: this.me, name: OWN_VAULT_NAME })) ?? null,
        isOwned: true,
        rights: null,
        // An empty vault is absent from the listing above but can still be
        // shared, so its access list has to be asked for separately — otherwise
        // sharing looks like it did not take effect until the first item is
        // added. A query, and only reached while the own vault is empty.
        sharedWith: await this.accessListFor(OWN_VAULT_NAME),
        itemIds: [],
        fingerprint: EMPTY_FINGERPRINT,
      });
    }
    return vaults;
  }

  /**
   * Decrypt one vault's items. The only call here that derives a key, and the
   * derivation is cached per vault, so reopening is free.
   */
  async openVault(vault: VaultSummary): Promise<VaultItem[]> {
    const values = await this.encryptedMaps.getValuesForMap(vault.owner, nameBytes(vault.name));
    return values.map(([key, value]) => decodeItem(decoder.decode(key), value)).sort(compareItems);
  }

  /** Who an owned vault is shared with. Empty rather than throwing if unknown. */
  private async accessListFor(name: string): Promise<[Principal, AccessRights][]> {
    try {
      const access = await this.encryptedMaps.getSharedUserAccessForMap(this.me, nameBytes(name));
      return access.filter(([who]) => who.compareTo(this.me) !== "eq");
    } catch {
      // No map yet, or no access list to read. Absence of sharing, not an error
      // worth failing a vault load over.
      return [];
    }
  }

  async saveItem(vault: VaultSummary, item: VaultItem): Promise<void> {
    await this.encryptedMaps.setValue(
      vault.owner,
      nameBytes(vault.name),
      encoder.encode(item.id),
      encodeItem({ ...item, updatedAt: Date.now() }),
    );
  }

  async deleteItem(vault: VaultSummary, itemId: string): Promise<void> {
    await this.encryptedMaps.removeEncryptedValue(vault.owner, nameBytes(vault.name), encoder.encode(itemId));
  }

  /**
   * Rename a vault you own, or clear the name by passing "".
   *
   * One write. The map does not move, so nothing is re-encrypted, no key is
   * re-derived, and collaborators see the new name immediately with no
   * interruption — which is the entire reason for storing a label rather than
   * renaming the map.
   */
  async rename(vault: VaultSummary, displayName: string): Promise<void> {
    const result = await this.backend.set_vault_name(
      { inner: Array.from(nameBytes(vault.name)) },
      displayName,
    );
    if ("Err" in result) throw new Error(result.Err);
  }

  /**
   * Removes every item in the vault.
   *
   * Guarded by `ensureUserCanWrite`, so any `ReadWrite` collaborator can do
   * this — there is no separate delete right. The map itself and its access
   * list survive, so the vault stays listed and shared; only its contents go.
   * That is why the UI calls this "empty", not "delete".
   */
  async wipe(vault: VaultSummary): Promise<void> {
    await this.encryptedMaps.removeMapValues(vault.owner, nameBytes(vault.name));
  }

  async share(vault: VaultSummary, user: Principal, level: AccessLevel): Promise<void> {
    if (user.compareTo(vault.owner) === "eq") throw new Error("The vault owner already has full access.");
    await this.encryptedMaps.setUserRights(vault.owner, nameBytes(vault.name), user, toAccessRights(level));
  }

  async revoke(vault: VaultSummary, user: Principal): Promise<void> {
    await this.encryptedMaps.removeUser(vault.owner, nameBytes(vault.name), user);
  }

  /** Drops the cached vault keys, including the persisted ones. */
  async lock(): Promise<void> {
    await this.encryptedMaps.clearCache();
  }
}
