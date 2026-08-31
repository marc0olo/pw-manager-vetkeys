import { Actor, type ActorSubclass, type HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

/**
 * The two endpoints this app adds on top of the EncryptedMaps mixin.
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
  return IDL.Service({
    set_vault_name: IDL.Func([ByteBuf, IDL.Text], [IDL.Variant({ Ok: IDL.Null, Err: IDL.Text })], []),
    get_vault_names: IDL.Func([], [IDL.Vec(VaultName)], ["query"]),
  });
};

interface NamesService {
  set_vault_name: (
    mapName: { inner: Uint8Array | number[] },
    displayName: string,
  ) => Promise<{ Ok: null } | { Err: string }>;
  get_vault_names: () => Promise<
    { owner: Principal; map_name: { inner: Uint8Array | number[] }; display_name: string }[]
  >;
}

export function namesActor(agent: HttpAgent, canisterId: string): ActorSubclass<NamesService> {
  return Actor.createActor<NamesService>(idl, { agent, canisterId });
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
