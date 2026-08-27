import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import {
  SESSION_POLICY,
  IDLE_TIMEOUT_MS,
  clearActivity,
  idleElapsedMs,
  markActive,
  purgeKeyMaterial,
  storedPrincipal,
} from "./session";

/**
 * Internet Identity sign-in.
 *
 * The URL must include `/authorize` — @icp-sdk/auth uses it verbatim.
 *
 * Which II is decided at runtime from the origin the page is actually served
 * from, because a locally deployed II is served by the *same gateway* as this
 * app: if we are at `http://frontend.local.localhost:8100`, II is at
 * `http://id.ai.localhost:8100`. Nothing to configure, one artifact that is
 * correct wherever it is served, and a mainnet origin cannot resolve to a
 * localhost URL — the guarantee comes from the origin itself rather than from
 * build-time metadata that could be stale or absent.
 */
const MAINNET_IDENTITY_PROVIDER = "https://id.ai/authorize";

/** Hostname the II frontend canister answers on, on any local gateway port. */
const LOCAL_II_HOSTNAME = "id.ai.localhost";

function isLocalGateway(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function resolveIdentityProvider(): string {
  // `vite dev` serves on its own port, not the gateway's, so it publishes the
  // gateway origin through the `ic_env` cookie it already fakes. Absent in every
  // deployed build, where our own origin is the gateway.
  const devGateway = safeGetCanisterEnv<{ readonly DEV_GATEWAY_ORIGIN?: string }>()?.DEV_GATEWAY_ORIGIN;
  const gateway: URL | Location = devGateway ? new URL(devGateway) : window.location;

  if (!isLocalGateway(gateway.hostname)) return MAINNET_IDENTITY_PROVIDER;
  return `${gateway.protocol}//${LOCAL_II_HOSTNAME}${gateway.port ? `:${gateway.port}` : ""}/authorize`;
}

export const IDENTITY_PROVIDER = resolveIdentityProvider();

/** True when signing in against a locally deployed II rather than mainnet. */
export const USING_LOCAL_II = IDENTITY_PROVIDER !== MAINNET_IDENTITY_PROVIDER;

if (USING_LOCAL_II) {
  // Visible without reading the source, and a reminder that a local principal
  // is not the same user as a mainnet one.
  console.info(`[vetVault] signing in against local Internet Identity: ${IDENTITY_PROVIDER}`);
}

const SESSION_LIFETIME_NS = BigInt(SESSION_POLICY.delegationHours) * BigInt(3_600_000_000_000);
/** Why the vault is locked, so the lock screen can say so. */
export type LockReason = "manual" | "idle" | "expired" | "elsewhere";

export const authClient = new AuthClient({
  identityProvider: IDENTITY_PROVIDER,
  // The idle policy lives in ./session, which owns one activity definition for
  // both the in-page timeout and the persisted mark. The library's IdleManager
  // is off entirely: it is only created inside signIn()/#hydrate(), so a
  // callback registered here would be dropped, and it is single-shot.
  idleOptions: { disableIdle: true },
});

/**
 * When the delegation stops being valid, in ms since the epoch.
 *
 * The session ends on its own after {@link SESSION_LIFETIME_NS}; without this the
 * expiry would surface as an opaque canister rejection on the user's next action
 * instead of a clean re-lock. Returns null if the identity carries no delegation.
 */
export function sessionExpiresAt(identity: Identity): number | null {
  const delegated = identity as {
    getDelegation?: () => { delegations: { delegation: { expiration: bigint } }[] };
  };
  const delegations = delegated.getDelegation?.().delegations;
  if (!delegations?.length) return null;
  return Math.min(...delegations.map((d) => Number(d.delegation.expiration / BigInt(1_000_000))));
}

/**
 * Decide, on page load, whether the stored session may be resumed.
 *
 * This is where a session left closed for too long dies: the delegation and
 * every cached vault key are purged together before anything can use them, so
 * the two can never diverge no matter how the app was closed.
 *
 * Refusals always carry a reason unless this is a genuinely first visit, so the
 * user is never shown an unexplained sign-in screen.
 */
export async function resumeSession(): Promise<{ identity: Identity | null; lockReason: LockReason | null }> {
  const idleFor = idleElapsedMs();
  const hadMark = idleFor !== null;
  const hadDelegation = authClient.isAuthenticated();

  // A missing mark is never treated as fresh: no recorded activity means no live
  // session to resume.
  if (!hadMark || idleFor > IDLE_TIMEOUT_MS) {
    await signOut();
    if (!hadMark && !hadDelegation) return { identity: null, lockReason: null }; // first visit
    return { identity: null, lockReason: hadMark ? "idle" : "expired" };
  }

  if (!hadDelegation) {
    // Delegation expired or was cleared elsewhere; key material must not survive it.
    await signOut();
    return { identity: null, lockReason: "expired" };
  }

  const identity = await authClient.getIdentity();
  const principal = identity.getPrincipal();
  if (principal.isAnonymous()) {
    await signOut();
    return { identity: null, lockReason: "expired" };
  }

  // The mark and the delegation must describe the same user. markActive
  // swallows storage failures by design, so divergence is reachable — and
  // resuming on a mark that belongs to someone else is exactly the coupling
  // failure this module exists to prevent.
  const recorded = storedPrincipal();
  if (recorded !== null && recorded !== principal.toText()) {
    await signOut();
    return { identity: null, lockReason: "expired" };
  }

  return { identity, lockReason: null };
}

export async function signIn(): Promise<Identity> {
  const identity = await authClient.signIn({
    maxTimeToLive: SESSION_LIFETIME_NS,
    // Deliberately NOT scoped with `targets`. Internet Identity does not issue
    // canister-scoped delegations: it ignores the request and returns an
    // unscoped chain, which @icp-sdk/signer then rejects —
    // "Returned delegation is unscoped but scoped targets were requested" —
    // so sign-in fails outright. Scoped delegations are an ICRC-49/57 signer
    // feature (OISY and similar), not part of II's authorize flow.
    //
    // Little is lost. II derives a principal per *origin*, so this principal
    // exists only for this app and holds nothing on any other canister; and the
    // IC is reverse-gas, so a leaked delegation cannot spend the user's cycles
    // by calling elsewhere. Its blast radius is already this app's own data,
    // which is what the idle timeout and the delegation TTL bound.
    //
    // Revisit only if the app starts calling a canister that holds value under
    // this same principal (a ledger, say) — and note that II still could not
    // scope it, so the mitigation would have to be something else.
  });

  if (identity.getPrincipal().isAnonymous()) {
    throw new Error("Internet Identity returned an anonymous identity; sign-in did not complete.");
  }
  markActive(identity.getPrincipal().toText());
  return identity;
}

/**
 * Full teardown: cached vault keys first, then the delegation, then the activity
 * mark. Every path that ends a session goes through here so key material can
 * never be left behind by one of them.
 */
export async function signOut(): Promise<void> {
  try {
    await purgeKeyMaterial();
  } finally {
    try {
      await authClient.signOut();
    } finally {
      // Always runs: a mark left behind would make a dead session look live.
      clearActivity();
    }
  }
}
