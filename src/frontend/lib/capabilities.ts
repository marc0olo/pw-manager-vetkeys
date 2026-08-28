import { accessLevel, vaultId, type VaultSummary } from "./vault";

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
 * What we know about a capability *before* attempting it.
 *
 * Three states rather than two. For a vault shared with us the canister refuses
 * to disclose our rights — it will not reveal a vault's membership to a
 * non-manager — and the library flattens that refusal to an empty list
 * (dfinity/vetkeys#438). So "we were not told" is the normal case for every
 * shared vault, and reading it as "no" is exactly what made all three access
 * levels behave identically to `Read`.
 */
export type Verdict = "granted" | "denied" | "untested";

/**
 * Capabilities the canister has refused this session, as `vaultId:capability`.
 *
 * Session-scoped deliberately: rights can be granted while the app is open, so
 * a denial learned five minutes ago must not outlive a re-share. Cleared with
 * the rest of the session state on lock.
 */
export type Denials = readonly string[];

export function denialKey(id: string, capability: Capability): string {
  return `${id}:${capability}`;
}

export function verdictFor(vault: VaultSummary, capability: Capability, denials: Denials): Verdict {
  if (vault.isOwned) return "granted";

  const id = vaultId(vault);
  if (denials.includes(denialKey(id, capability))) return "denied";
  // A refused write settles manage too: every level that can manage can also
  // write, so a write refusal means `Read`. Saves a second pointless attempt.
  if (capability === "manage" && denials.includes(denialKey(id, "write"))) return "denied";

  // Once dfinity/vetkeys#438 ships, this is the path every shared vault takes
  // and the attempt-and-adapt machinery above becomes dead weight.
  if (vault.rights === null) return "untested";

  const level = accessLevel(vault.rights);
  const granted = capability === "write" ? level !== "Read" : level === "ReadWriteManage";
  return granted ? "granted" : "denied";
}

/**
 * Whether to offer the control at all.
 *
 * Untested counts as yes. This never weakens enforcement — the canister remains
 * the only authority — it just stops the UI from pre-emptively refusing on the
 * user's behalf using information it does not have.
 */
export function offers(verdict: Verdict): boolean {
  return verdict !== "denied";
}

export function withDenial(denials: Denials, id: string, capability: Capability): Denials {
  const key = denialKey(id, capability);
  return denials.includes(key) ? denials : [...denials, key];
}

/**
 * Whether a failure means "you may not", as opposed to anything else.
 *
 * The library answers every refused operation with exactly `unauthorized`
 * (`KeyManager.mo`), and the SDK unwraps `#Err(text)` into `Error(text)`, so
 * this is an exact match rather than a substring search — verified against a
 * replica for write, manage and wipe at both `Read` and `ReadWrite`.
 *
 * Matching narrowly is the safe direction. An unrecognised failure is reported
 * as an ordinary error and the control stays offered; treating a network blip
 * as a denial would silently strip a capability the user really has.
 */
export function isUnauthorized(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
  return text === "unauthorized" || text.endsWith(": unauthorized");
}

/** What was being attempted when a refusal came back. */
export type Attempted = Capability | "open";

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
  }
}
