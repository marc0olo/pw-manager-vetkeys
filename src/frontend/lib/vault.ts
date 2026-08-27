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
import { keyCacheName } from "./session";

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
    return new VaultClient(encryptedMaps, principal);
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
        // An empty vault is absent from the listing above but can still be
        // shared, so its access list has to be asked for separately — otherwise
        // sharing looks like it did not take effect until the first item is
        // added. A query, and only reached while the own vault is empty.
        sharedWith: await this.accessListFor(OWN_VAULT_NAME),
        items: [],
      });
    }
    return vaults;
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

  /** Drops the cached vault keys, including the persisted ones. */
  async lock(): Promise<void> {
    await this.encryptedMaps.clearCache();
  }
}
