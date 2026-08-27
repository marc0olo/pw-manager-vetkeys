import { HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import {
  DefaultEncryptedMapsClient,
  EncryptedMaps,
  type AccessRights,
} from "@icp-sdk/vetkeys/encrypted_maps";
import { backendCanisterId } from "./canister";
import { compareItems, decodeItem, encodeItem, type VaultItem } from "./items";

export type { AccessRights };

/** The one vault every user owns. Vault names are capped at 32 bytes. */
export const OWN_VAULT_NAME = "Personal";

export interface Vault {
  /** Principal that owns the vault — half of the vault's identity. */
  owner: Principal;
  name: string;
  /** False for a vault someone else shared with us. */
  isOwned: boolean;
  /** Our rights on a shared vault; owners implicitly have full rights. */
  rights: AccessRights | null;
  /** Who this vault is shared with (owner excluded). */
  sharedWith: [Principal, AccessRights][];
  items: VaultItem[];
}

export const ACCESS_LEVELS = ["Read", "ReadWrite", "ReadWriteManage"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export function accessLevel(rights: AccessRights): AccessLevel {
  return Object.keys(rights)[0] as AccessLevel;
}

export function toAccessRights(level: AccessLevel): AccessRights {
  return { [level]: null } as AccessRights;
}

export function canWrite(vault: Vault): boolean {
  return vault.isOwned || (vault.rights !== null && accessLevel(vault.rights) !== "Read");
}

export function canManage(vault: Vault): boolean {
  return vault.isOwned || (vault.rights !== null && accessLevel(vault.rights) === "ReadWriteManage");
}

export function vaultId(vault: Pick<Vault, "owner" | "name">): string {
  return `${vault.owner.toText()}/${vault.name}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nameBytes(name: string): Uint8Array {
  const bytes = encoder.encode(name);
  if (bytes.length === 0) throw new Error("A vault name cannot be empty.");
  if (bytes.length > 32) throw new Error("A vault name must be at most 32 bytes.");
  return bytes;
}

/**
 * Thin, typed façade over EncryptedMaps.
 *
 * Encryption and decryption happen here in the browser; the canister only ever
 * holds ciphertext.
 *
 * **Derived key material is memory-only** — the library default
 * (`InMemoryDerivedKeyMaterialCache`), since no `cache` is passed below. Note
 * what this does and does not buy:
 *
 * - It does NOT lock the vault on reload. The *delegation* is persisted by
 *   @icp-sdk/auth (IndexedDB), so a reload re-derives the key and reopens the
 *   vault with no user interaction. The cost of dropping the cache is one vetKD
 *   derivation per map per page load, not a lock.
 * - It DOES make "key material never outlives the session" hold automatically:
 *   memory dies with the page, so the two can never diverge.
 *
 * That second property is the reason to keep it. Switching to
 * `IndexedDbDerivedKeyMaterialCache` would trade one vetKD derivation per load
 * for a persisted decryption capability that has **no intrinsic expiry** —
 * unlike the delegation, which dies on its own — and it cannot be made safe by
 * clearing on unload, because unload handlers are not guaranteed to run. It
 * would need the invariant re-established explicitly on *load*: namespace the
 * store per principal, and before trusting the cache verify that a valid
 * non-expired delegation exists for that same principal, purging otherwise.
 */
export class VaultClient {
  private constructor(
    private readonly encryptedMaps: EncryptedMaps,
    readonly me: Principal,
  ) {}

  static async create(identity: Identity): Promise<VaultClient> {
    const canisterId = backendCanisterId();
    const agent = await HttpAgent.create({
      identity,
      host: window.location.origin,
      rootKey: safeGetCanisterEnv()?.IC_ROOT_KEY,
    });
    const encryptedMaps = new EncryptedMaps(new DefaultEncryptedMapsClient(agent, canisterId));
    return new VaultClient(encryptedMaps, identity.getPrincipal());
  }

  /**
   * Every vault we can read, with all items decrypted.
   *
   * The canister only reports *non-empty* owned vaults, so a brand-new user has
   * nothing to list — the caller always shows their own vault regardless.
   */
  async loadVaults(): Promise<Vault[]> {
    const maps = await this.encryptedMaps.getAllAccessibleMaps();

    const vaults = maps.map((map): Vault => {
      const isOwned = map.mapOwner.compareTo(this.me) === "eq";
      const rights = map.accessControl.find(([who]) => who.compareTo(this.me) === "eq")?.[1] ?? null;
      return {
        owner: map.mapOwner,
        name: decoder.decode(map.mapName),
        isOwned,
        rights: isOwned ? null : rights,
        sharedWith: map.accessControl.filter(([who]) => who.compareTo(map.mapOwner) !== "eq"),
        items: map.keyvals
          .map(([key, value]) => decodeItem(decoder.decode(key), value))
          .sort(compareItems),
      };
    });

    if (!vaults.some((vault) => vault.isOwned && vault.name === OWN_VAULT_NAME)) {
      vaults.unshift({
        owner: this.me,
        name: OWN_VAULT_NAME,
        isOwned: true,
        rights: null,
        sharedWith: [],
        items: [],
      });
    }
    return vaults;
  }

  async saveItem(vault: Vault, item: VaultItem): Promise<void> {
    await this.encryptedMaps.setValue(
      vault.owner,
      nameBytes(vault.name),
      encoder.encode(item.id),
      encodeItem({ ...item, updatedAt: Date.now() }),
    );
  }

  async deleteItem(vault: Vault, itemId: string): Promise<void> {
    await this.encryptedMaps.removeEncryptedValue(vault.owner, nameBytes(vault.name), encoder.encode(itemId));
  }

  async share(vault: Vault, user: Principal, level: AccessLevel): Promise<void> {
    if (user.compareTo(vault.owner) === "eq") throw new Error("The vault owner already has full access.");
    await this.encryptedMaps.setUserRights(vault.owner, nameBytes(vault.name), user, toAccessRights(level));
  }

  async revoke(vault: Vault, user: Principal): Promise<void> {
    await this.encryptedMaps.removeUser(vault.owner, nameBytes(vault.name), user);
  }

  /** Drops in-memory key material. Call on sign-out. */
  async lock(): Promise<void> {
    await this.encryptedMaps.clearCache();
  }
}
