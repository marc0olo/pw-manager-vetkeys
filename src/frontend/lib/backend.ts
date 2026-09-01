import { Actor, type ActorSubclass, type HttpAgent } from "@icp-sdk/core/agent";
import { idlFactory } from "../../bindings/declarations/backend.did.js";
import type { _SERVICE } from "../../bindings/declarations/backend.did";

/**
 * The endpoints this app adds on top of the EncryptedMaps mixin.
 *
 * The interface is **generated** from the canister's own Candid by
 * `npm run bindings`. It used to be hand-written here and again in two scripts,
 * with nothing keeping the three in step — and Candid decodes a drifted record
 * into something plausible rather than throwing, so a mismatch would have shown
 * up as wrong data rather than an error. `npm run check-bindings` fails if the
 * committed output no longer matches the canister.
 *
 * Deliberately the raw `idlFactory` rather than bindgen's generated
 * `createActor` wrapper. The wrapper re-expresses candid variants in its own
 * idiom — `AccessRights.Read` instead of `{ Read: null }` — which does not
 * match the shape `@icp-sdk/vetkeys` uses for the very same values, and this
 * app passes them straight back to `setUserRights`. One representation is worth
 * more than the wrapper's conveniences, and it keeps this identical to what the
 * scripts import.
 *
 * The actor is given our existing agent, so it carries the same identity as the
 * EncryptedMaps client beside it.
 */
export function backendActor(agent: HttpAgent, canisterId: string): ActorSubclass<_SERVICE> {
  return Actor.createActor<_SERVICE>(idlFactory, { agent, canisterId });
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
