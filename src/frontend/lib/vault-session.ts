import type { VaultItem } from "./items";
import type { VaultSummary } from "./vault";

export type Pane = { mode: "view" } | { mode: "edit"; item: VaultItem; isNew: boolean };

/**
 * Every piece of component state that holds, or can reveal, the current
 * session's vault data.
 *
 * Grouped into one object so a lock clears it as a unit. Previously these were
 * separate `useState` calls cleared field by field, and a field added later was
 * simply forgotten — `openItems`, holding fully decrypted titles, usernames and
 * passwords, survived a lock and rendered under the *next* principal to sign in.
 * The lock tests did not catch it because they assert that the reset runs, not
 * what it clears.
 *
 * With this shape that cannot recur: adding a field here is a type error until
 * {@link NO_VAULT_SESSION} gives it a cleared value, and the lock applies that
 * constant wholesale rather than naming fields.
 *
 * Two members are easy to overlook as harmless:
 *
 * - `openItems` is decrypted plaintext.
 * - `pane` carries a whole `VaultItem` while editing, i.e. a draft password.
 */
export interface VaultSessionState {
  /** Vault metadata from the last poll. No plaintext, but it names the vaults. */
  vaults: VaultSummary[] | null;
  /** The open vault's decrypted items. Plaintext secrets. */
  openItems: VaultItem[] | null;
  selectedVaultId: string | null;
  selectedItemId: string | null;
  /** When the vault list was last read. Stale after a lock, so it is cleared. */
  syncedAt: number | null;
  /** In edit mode this holds a draft item, including its password. */
  pane: Pane;
  /** A search term can itself reveal what the user was looking for. */
  query: string;
  sharing: boolean;
}

/** The locked state: nothing about any previous session survives it. */
export const NO_VAULT_SESSION: VaultSessionState = {
  vaults: null,
  openItems: null,
  selectedVaultId: null,
  selectedItemId: null,
  syncedAt: null,
  pane: { mode: "view" },
  query: "",
  sharing: false,
};

/**
 * Decides which asynchronous load is allowed to write vault state.
 *
 * Sign-in and every poll read from the canister across an await, and what they
 * bring back must not be written if, while they were waiting, either a newer
 * load started or the session ended. The second case is the dangerous one:
 * clearing state on lock does nothing if a request already in flight writes the
 * previous session's vault list straight back into it a moment later.
 *
 * A counter rather than an `AbortController` because the work cannot actually be
 * cancelled — an agent query is already on the wire. The result still arrives;
 * this decides whether anyone listens to it.
 */
export function createLoadGuard() {
  let current = 0;
  return {
    /**
     * Begin a load. The returned predicate is true only while this load is
     * still the newest and its session is still open — check it after every
     * await, before writing state.
     */
    begin(): () => boolean {
      const mine = ++current;
      return () => mine === current;
    },
    /**
     * Abandon everything in flight. Called by the lock: those results belong to
     * a session that no longer exists.
     */
    invalidate(): void {
      current++;
    },
  };
}
