import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import { backendCanisterId } from "./canister";

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

/**
 * How long an unlocked vault stays unlocked. The only two numbers to change;
 * the lock-screen wording is derived from them.
 *
 * `delegationHours` is also the hard cap on a *closed* tab: the delegation is
 * persisted (IndexedDB, by @icp-sdk/auth), so reopening the app within this
 * window re-derives the vault key and shows the vault without a passkey prompt.
 * `idleMinutes` only applies while a page is open.
 */
export const SESSION_POLICY = {
  delegationHours: 8,
  idleMinutes: 5,
} as const;

const SESSION_LIFETIME_NS = BigInt(SESSION_POLICY.delegationHours) * BigInt(3_600_000_000_000);

/** Auto-lock after this much inactivity. */
export const IDLE_TIMEOUT_MS = SESSION_POLICY.idleMinutes * 60_000;

export const SESSION_LIFETIME_LABEL = `${SESSION_POLICY.delegationHours}-hour`;
export const IDLE_TIMEOUT_LABEL = `${SESSION_POLICY.idleMinutes} minutes`;

/** Why the vault is locked, so the lock screen can say so. */
export type LockReason = "manual" | "idle" | "expired";

export const authClient = new AuthClient({
  identityProvider: IDENTITY_PROVIDER,
  idleOptions: {
    idleTimeout: IDLE_TIMEOUT_MS,
    // The library's default idle callback signs out and reloads the page. We
    // take it over so locking runs the same path as the Lock button — dropping
    // the vault key material deliberately — and so the user is told why.
    disableDefaultIdleCallback: true,
  },
});

// Registered once at module load; `onIdle` only swaps the target, so React
// re-renders and StrictMode double-mounts cannot stack duplicate callbacks
// (IdleManager has no way to unregister one).
let idleCallback: (() => void) | null = null;
authClient.idleManager?.registerCallback(() => idleCallback?.());

/** Called once the user has been idle for {@link IDLE_TIMEOUT_MS}. */
export function onIdle(callback: () => void): void {
  idleCallback = callback;
}

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

export async function restoreSession(): Promise<Identity | null> {
  if (!authClient.isAuthenticated()) return null;
  const identity = await authClient.getIdentity();
  return identity.getPrincipal().isAnonymous() ? null : identity;
}

export async function signIn(): Promise<Identity> {
  const identity = await authClient.signIn({
    maxTimeToLive: SESSION_LIFETIME_NS,
    // Scope the delegation to the vault canister. An unscoped delegation can
    // sign calls to *any* canister on the user's behalf, and this one is
    // persisted to disk — so bound what a leaked copy could do.
    targets: [Principal.fromText(backendCanisterId())],
  });
  if (identity.getPrincipal().isAnonymous()) {
    throw new Error("Internet Identity returned an anonymous identity; sign-in did not complete.");
  }
  return identity;
}

export async function signOut(): Promise<void> {
  await authClient.signOut();
}
