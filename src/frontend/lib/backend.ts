import { Actor, type ActorSubclass, type HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import type { AccessRights } from "@icp-sdk/vetkeys/encrypted_maps";

/**
 * The endpoints this app adds on top of the EncryptedMaps mixin.
 *
 * Hand-written because `@icp-sdk/vetkeys`'s client only knows the library's own
 * interface. Adding endpoints beside the mixin is safe — the ones it contributes
 * are untouched, so the stock client keeps working — but nothing generates a
 * binding for ours.
 */
const idl: IDL.InterfaceFactory = ({ IDL }) => {
  const ByteBuf = IDL.Record({ inner: IDL.Vec(IDL.Nat8) });
  const VaultName = IDL.Record({
    owner: IDL.Principal,
    map_name: ByteBuf,
    display_name: IDL.Text,
  });
  const AccessRights = IDL.Variant({
    Read: IDL.Null,
    ReadWrite: IDL.Null,
    ReadWriteManage: IDL.Null,
  });
  const VaultSummary = IDL.Record({
    owner: IDL.Principal,
    map_name: ByteBuf,
    access_control: IDL.Vec(IDL.Tuple(IDL.Principal, AccessRights)),
    item_keys: IDL.Vec(ByteBuf),
    digest: ByteBuf,
  });
  return IDL.Service({
    set_vault_name: IDL.Func([ByteBuf, IDL.Text], [IDL.Variant({ Ok: IDL.Null, Err: IDL.Text })], []),
    get_vault_names: IDL.Func([], [IDL.Vec(VaultName)], ["query"]),
    get_vault_summaries: IDL.Func([], [IDL.Vec(VaultSummary)], ["query"]),
  });
};

interface BackendService {
  set_vault_name: (
    mapName: { inner: Uint8Array | number[] },
    displayName: string,
  ) => Promise<{ Ok: null } | { Err: string }>;
  get_vault_names: () => Promise<
    { owner: Principal; map_name: { inner: Uint8Array | number[] }; display_name: string }[]
  >;
  /**
   * The vault listing the poll runs on: everything
   * `get_all_accessible_encrypted_maps` returns *except* the values, which are
   * replaced by one digest per vault. See the canister for why.
   */
  get_vault_summaries: () => Promise<
    {
      owner: Principal;
      map_name: { inner: Uint8Array | number[] };
      access_control: [Principal, AccessRights][];
      item_keys: { inner: Uint8Array | number[] }[];
      digest: { inner: Uint8Array | number[] };
    }[]
  >;
}

export function backendActor(agent: HttpAgent, canisterId: string): ActorSubclass<BackendService> {
  return Actor.createActor<BackendService>(idl, { agent, canisterId });
}

/** Longest display name the canister will store. Kept in step with main.mo. */
export const MAX_DISPLAY_NAME_BYTES = 64;

/**
 * Whether a display name is one the canister will accept.
 *
 * Unlike a *map* name, surrounding whitespace is not an error here — it carries
 * no identity, so the canister trims it rather than refusing. This only has to
 * catch what would actually be rejected, plus the empty case, which the caller
 * should treat as "clear the name" rather than as a rename.
 */
export function isValidDisplayName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && new TextEncoder().encode(trimmed).length <= MAX_DISPLAY_NAME_BYTES;
}
