import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";

/**
 * Internet Identity sign-in.
 *
 * The URL must include `/authorize` — @icp-sdk/auth uses it verbatim. Mainnet II
 * works from the local network too: the local replica trusts mainnet subnet
 * signatures, so there is no environment branching here.
 */
const IDENTITY_PROVIDER = "https://id.ai/authorize";

/** Eight hours. A password manager should not hold a month-long delegation. */
const SESSION_LIFETIME_NS = BigInt(8) * BigInt(3_600_000_000_000);

export const authClient = new AuthClient({ identityProvider: IDENTITY_PROVIDER });

export async function restoreSession(): Promise<Identity | null> {
  if (!authClient.isAuthenticated()) return null;
  const identity = await authClient.getIdentity();
  return identity.getPrincipal().isAnonymous() ? null : identity;
}

export async function signIn(): Promise<Identity> {
  const identity = await authClient.signIn({ maxTimeToLive: SESSION_LIFETIME_NS });
  if (identity.getPrincipal().isAnonymous()) {
    throw new Error("Internet Identity returned an anonymous identity; sign-in did not complete.");
  }
  return identity;
}

export async function signOut(): Promise<void> {
  await authClient.signOut();
}
