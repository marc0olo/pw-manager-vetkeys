/**
 * How a failed key derivation reads to the user.
 *
 * `vetkd_derive_key` is the only call this canister makes to anyone else, and
 * when it cannot afford it the client gets `IC0406 could not perform remote
 * call`. In a password manager that presents as **data loss** — unlocking
 * fails, so the secrets look gone — when nothing is gone and a top-up restores
 * everything. Saying so is the whole of this module.
 */

/** What the canister will tell us about itself, plus the case where it will not. */
export type Health = "funded" | "low-cycles" | "unknown";

/**
 * Whether this failure is the canister's own outbound call failing.
 *
 * Matched on the error code rather than the reject text, which is prose. Narrow
 * by design: an unrecognised failure is reported as itself, and claiming a
 * cycles outage over an ordinary network error would tell the user their
 * deployment is broken when it is not.
 */
export function isOutboundCallFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("IC0406");
}

/**
 * What to show for such a failure, or `null` if it is not one — in which case
 * the caller reports the underlying error, as it would have anyway.
 *
 * **`IC0406` does not mean "out of cycles".** It says the outbound call failed,
 * not why: insufficient cycles, a vetKD key not provisioned on the subnet and
 * queue pressure are indistinguishable from out here. Only the canister can
 * tell, so it is asked; and when it says it is funded, this says the call
 * failed for a reason it did not report rather than inventing one.
 *
 * `ask` is a function so the wording is testable without a canister, and so a
 * refusal — the canister answers this only for callers who can already see a
 * vault — is just another way of not knowing. It is also called defensively:
 * `VaultClient.health` promises not to throw, but that promise lives in its
 * implementation rather than here, and a rejection escaping this would replace
 * the very error it was called to explain with no message at all.
 */
export async function outageMessage(
  error: unknown,
  ask: () => Promise<Health>,
): Promise<string | null> {
  if (!isOutboundCallFailure(error)) return null;
  const health = await ask().catch((): Health => "unknown");
  if (health === "low-cycles") {
    return (
      "This deployment has run out of cycles. Your secrets are intact and still" +
      " encrypted — the canister just cannot derive vault keys until it is" +
      " topped up. Contact whoever operates it."
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `The canister could not complete an outbound call, and did not report why. ${detail}`;
}
