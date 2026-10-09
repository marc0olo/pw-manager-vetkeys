/**
 * What the UI can attempt beyond reading.
 *
 * Emptying a vault is not a third capability: `remove_map_values` is guarded by
 * `ensureUserCanWrite`, so `ReadWrite` can already destroy a vault's contents.
 * Verified against a replica. That is a property of the library worth knowing,
 * not one we can gate around.
 */
export type Capability = "write" | "manage";

/**
 * Whether a failure means "you may not", as opposed to anything else.
 *
 * The library answers every refused operation with exactly `unauthorized`
 * (`KeyManager.mo`), and the SDK unwraps `#Err(text)` into `Error(text)` —
 * verified against a replica for write, manage and wipe at both `Read` and
 * `ReadWrite`. So this matches that word whole, or after a `: ` reject prefix,
 * ignoring case and surrounding space — never as a substring, which would
 * catch any message that merely mentions it.
 *
 * Matching narrowly is the safe direction. An unrecognised failure is reported
 * as what it is; treating a network blip as a refusal would tell the user they
 * lost access they still have.
 */
export function isUnauthorized(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
  return text === "unauthorized" || text.endsWith(": unauthorized");
}

/**
 * What was being attempted when a refusal came back.
 *
 * Wider than {@link Capability}, because not everything the canister can refuse
 * is a level a grantee holds: reading can be refused after a revocation, and
 * some endpoints are the owner's alone. Each reads differently to the user.
 */
export type Attempted = Capability | "open" | "own";

/**
 * How a refusal reads to the user.
 *
 * Returns `null` for anything that is not a refusal, so the caller reports the
 * underlying error rather than mistranslating it — a failed decrypt caused by a
 * dead connection must not claim the user lost access.
 *
 * All three strings live here, next to {@link isUnauthorized}, so the wording
 * is covered by tests. The alternative was a ternary at each call site, which
 * is exactly the kind of user-visible behaviour that ends up in the untested
 * gap between the modules and the component.
 */
export function refusalMessage(error: unknown, attempted: Attempted): string | null {
  if (!isUnauthorized(error)) return null;
  switch (attempted) {
    case "write":
      return "You have read-only access to this vault.";
    case "manage":
      return "You cannot change who has access to this vault.";
    case "open":
      // Read access was revoked while the decrypt was in flight.
      return "You no longer have access to this vault.";
    case "own":
      // Ownership is knowable locally, so this control should not have been
      // offered.
      return "Only the vault's owner can do this.";
  }
}
