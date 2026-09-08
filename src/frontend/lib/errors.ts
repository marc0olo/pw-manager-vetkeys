import { AgentError, ErrorKindEnum } from "@icp-sdk/core/agent";

/**
 * How a failure reads to the user.
 *
 * `@icp-sdk/core` composes an `AgentError`'s `.message` from the rejection, the
 * request context and the **entire HTTP response including every header**. It is
 * written for whoever is debugging the agent, and pasting it into a banner put
 * hundreds of characters of CBOR plumbing in front of someone whose password
 * vault had just refused to open. Nothing in it is actionable by them, and read
 * at that moment it looks like the data is gone.
 *
 * So this classifies instead — on the SDK's own `kind`, not on its prose, which
 * varies with the cause even for one error code. Four buckets, because that is
 * how many are genuinely distinguishable *and* differently actionable; the
 * error code goes in every one so it can be quoted in a support request, and
 * the full error belongs in the console.
 *
 * **Deliberately makes no claim about stored state.** The derive failure has
 * its own wording in ./health, which can say the passwords are untouched
 * because it knows a key was never fetched. These cannot: a write that fails in
 * transport may still have landed, so "nothing was changed" would sometimes be
 * a lie. The next poll shows what really happened.
 *
 * An error the app raised itself — a name too long, a rejected duplicate — is
 * already written for the user, and passes through untouched.
 */
export function describe(error: unknown): string {
  if (!(error instanceof AgentError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const code = reference(error);
  switch (error.kind) {
    case ErrorKindEnum.Transport:
      // The common one, and the only one the user can act on alone.
      return "Could not reach this deployment. Check your connection and try again.";
    case ErrorKindEnum.Trust:
      // Verification failed, so the reply was discarded rather than trusted.
      // Worth its own wording: it is the one failure that might mean something
      // is wrong with the network between here and the canister, not with the
      // canister.
      return `A reply from this deployment could not be verified, so it was discarded (${code}).`;
    case ErrorKindEnum.Reject:
    case ErrorKindEnum.Limit:
      return `This deployment could not complete the request (${code}). Try again; if it keeps happening, contact whoever operates it.`;
    default:
      // Protocol, Input, External, Unknown. Distinguishable from each other,
      // but not in any way a user could act on differently.
      return `Something went wrong talking to this deployment (${code}). If it keeps happening, contact whoever operates it.`;
  }
}

/**
 * Something the user can quote and an operator can look up.
 *
 * Prefers the replica's `ICxxxx` code, which is documented and searchable, over
 * the SDK's error-code class name — `IC0503` says more to whoever fields the
 * report than `CertifiedRejectErrorCode` does. Falls back to the class name,
 * which every `ErrorCode` subclass assigns as a literal (so it survives
 * minification) though the abstract base does not declare it — hence read
 * rather than cast.
 */
function reference(error: AgentError): string {
  const replicaCode = error.message.match(/\bIC\d{4}\b/)?.[0];
  if (replicaCode) return replicaCode;
  const named = error.code as { name?: unknown };
  return typeof named.name === "string" ? named.name : "no error code";
}
