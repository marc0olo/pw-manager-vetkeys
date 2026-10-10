import { AuthClient } from "@icp-sdk/auth/client";
import { AgentError, ErrorKindEnum, type Identity } from "@icp-sdk/core/agent";
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

/**
 * The Internet Identity canister, which mints this app's delegations.
 *
 * The same id on a local network: icp-cli's `ii: true` installs II at its
 * mainnet id, so only the authorize URL differs between the two.
 */
const II_CANISTER_ID = "rdmx6-jaaaa-aaaaa-aaadq-cai";

const SIGN_IN_LIFETIME_NS = BigInt(SESSION_POLICY.signInHours) * BigInt(3_600_000_000_000);
/** Why the vault is locked, so the lock screen can say so. */
export type LockReason = "manual" | "idle" | "expired" | "elsewhere" | "unreachable";

export const authClient = new AuthClient({
  identityProvider: { authorizeUrl: IDENTITY_PROVIDER, canisterId: II_CANISTER_ID },
  // The client mints its own short-lived delegations by calling the II
  // canister, so its agent has to reach the network this app runs on — the
  // same host and root key the backend agent uses (`VaultClient.create`).
  agentOptions: { host: window.location.origin, rootKey: safeGetCanisterEnv()?.IC_ROOT_KEY },
});

/**
 * When the sign-in ends, in ms since the epoch, or null if nobody is signed in.
 *
 * The sign-in's own end, set by {@link SIGN_IN_LIFETIME_NS} — not the
 * expiration of the delegation the identity holds, which is short-lived and
 * replaced by the client as it ages. Without this the end would surface as an
 * opaque canister rejection on the user's next action instead of a clean
 * re-lock.
 */
export function sessionExpiresAt(): number | null {
  const status = authClient.getStatus();
  return status.state === "signed-in" ? status.expiresAtMs : null;
}

/** Whether a failure is the network's, rather than anything about the sign-in. */
function isUnreachable(error: unknown): boolean {
  return error instanceof AgentError && error.kind === ErrorKindEnum.Transport;
}

/**
 * End the stored sign-in on a refusal path, whatever the canister says.
 *
 * `signOut` wipes what this device holds before it reports a failed revoke at
 * the II canister, so a failure here leaves nothing usable behind — and must
 * not abort the load-time decision, which would lose the lock reason and show
 * an unexplained sign-in screen. Offline is the ordinary way to get here.
 */
async function refuseStoredSession(): Promise<void> {
  await signOut().catch(() => undefined);
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
  // Read from the sign-in record, synchronously. An ended sign-in reads as
  // `expired` rather than `signed-in`, so it counts as gone.
  const signedIn = authClient.getStatus().state === "signed-in";

  // A missing mark is never treated as fresh: no recorded activity means no live
  // session to resume.
  if (!hadMark || idleFor > IDLE_TIMEOUT_MS) {
    await refuseStoredSession();
    if (!hadMark && !signedIn) return { identity: null, lockReason: null }; // first visit
    return { identity: null, lockReason: hadMark ? "idle" : "expired" };
  }

  if (!signedIn) {
    // Sign-in expired or was cleared elsewhere; key material must not survive it.
    await refuseStoredSession();
    return { identity: null, lockReason: "expired" };
  }

  // Can fail although the record says signed in: a credential store that cannot
  // be read, the session already ended at the canister, or a delegation that has
  // to be minted and cannot be. A stored delegation with life left is adopted
  // without a call, so that last case is a reload after it ran out — offline, or
  // with II unreachable. A sign-in that cannot act is not a sign-in either way,
  // but "expired" would misstate that one, so it gets its own reason.
  let failure: unknown = null;
  const identity = await authClient.getIdentity().catch((error: unknown) => {
    failure = error;
    return null;
  });
  if (identity === null || identity.getPrincipal().isAnonymous()) {
    await refuseStoredSession();
    return { identity: null, lockReason: isUnreachable(failure) ? "unreachable" : "expired" };
  }
  const principal = identity.getPrincipal();

  // The mark and the sign-in must describe the same user. markActive
  // swallows storage failures by design, so divergence is reachable — and
  // resuming on a mark that belongs to someone else is exactly the coupling
  // failure this module exists to prevent.
  const recorded = storedPrincipal();
  if (recorded !== null && recorded !== principal.toText()) {
    await refuseStoredSession();
    return { identity: null, lockReason: "expired" };
  }

  return { identity, lockReason: null };
}

export async function signIn(): Promise<Identity> {
  const identity = await authClient.signIn({
    maxTimeToLive: SIGN_IN_LIFETIME_NS,
    // Not scoped to this app's canisters, and it cannot be: Internet Identity
    // issues unscoped delegations, and `@icp-sdk/auth` no longer takes
    // `targets` at all. (It once did, and II's unscoped answer made the signer
    // reject it — "Returned delegation is unscoped but scoped targets were
    // requested" — so sign-in failed outright.) Scoped delegations are an
    // ICRC-49/57 signer feature (OISY and similar), not part of II's flow.
    //
    // Little is lost. II derives a principal per *origin*, so this principal
    // exists only for this app and holds nothing on any other canister; and the
    // IC is reverse-gas, so a leaked delegation cannot spend the user's cycles
    // by calling elsewhere. Its blast radius is already this app's own data,
    // which is what the idle timeout and the sign-in lifetime bound.
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
 * Full teardown: cached vault keys first, then the sign-in, then the activity
 * mark. Every path that ends a session goes through here so key material can
 * never be left behind by one of them.
 *
 * Ending the sign-in also ends it at the II canister, so no delegation can be
 * minted from it again. That call can fail after this device is already wiped,
 * and the failure is rethrown — callers that must not stop on it catch it.
 */
export async function signOut(options: { held?: string } = {}): Promise<void> {
  try {
    await purgeKeyMaterial(options);
  } finally {
    try {
      await authClient.signOut();
    } finally {
      // Always runs: a mark left behind would make a dead session look live.
      clearActivity();
    }
  }
}
