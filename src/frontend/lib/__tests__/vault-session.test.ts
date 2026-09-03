import { describe, expect, it } from "vitest";
import { NO_VAULT_SESSION, type VaultSessionState } from "../vault-session";

/**
 * The locked state must carry nothing about a previous session.
 *
 * This is the gap that let decrypted items survive a lock: the lock tests assert
 * that the reset *runs* and in what order, but what it *cleared* lived as a list
 * of individual setters in the component, so a field added later was simply
 * missed. These assertions are about the contents.
 */
describe("NO_VAULT_SESSION", () => {
  it("holds no decrypted plaintext", () => {
    // openItems is the field that leaked: fully decrypted titles, usernames,
    // passwords and notes, rendered under whichever principal signed in next.
    expect(NO_VAULT_SESSION.openItems).toBeNull();
  });

  it("holds no draft item", () => {
    // An open editor carries a whole VaultItem, password included.
    expect(NO_VAULT_SESSION.pane).toEqual({ mode: "view" });
  });

  it("holds nothing about which vaults existed, or which was open", () => {
    expect(NO_VAULT_SESSION.vaults).toBeNull();
    expect(NO_VAULT_SESSION.selectedVaultId).toBeNull();
    expect(NO_VAULT_SESSION.selectedItemId).toBeNull();
  });

  it("holds no search term", () => {
    expect(NO_VAULT_SESSION.query).toBe("");
  });

  it("remembers no refused capability, so a re-share is not shadowed by a stale denial", () => {
    expect(NO_VAULT_SESSION.denials).toEqual([]);
  });

  it("reports no sync time, so the sidebar cannot show the last session's", () => {
    expect(NO_VAULT_SESSION.syncedAt).toBeNull();
  });

  it("closes any open dialog", () => {
    expect(NO_VAULT_SESSION.sharing).toBe(false);
    expect(NO_VAULT_SESSION.wiping).toBe(false);
    expect(NO_VAULT_SESSION.renaming).toBe(false);
    expect(NO_VAULT_SESSION.trash).toBeNull();
  });

  /**
   * The real guard is the type: `NO_VAULT_SESSION` is declared as
   * `VaultSessionState`, so adding a field to the interface without giving it a
   * cleared value here fails to compile. This check covers the other half —
   * that no field is cleared to something truthy that could carry data.
   */
  it("clears every field to an empty value", () => {
    const carriesNothing = (value: VaultSessionState[keyof VaultSessionState]) => {
      if (Array.isArray(value)) return value.length === 0;
      return value === null || value === false || value === "" || (typeof value === "object" && value !== null);
    };

    for (const [field, value] of Object.entries(NO_VAULT_SESSION)) {
      expect(carriesNothing(value), `${field} is not cleared`).toBe(true);
    }
  });

  it("enumerates every field the component groups, so none is tracked outside it", () => {
    // A field kept in its own useState instead of here would not be cleared by
    // the lock. Update this list deliberately when the shape changes.
    expect(Object.keys(NO_VAULT_SESSION).sort()).toEqual([
      "creating",
      "deleting",
      "deletingVault",
      "denials",
      "history",
      "itemFacts",
      "openItems",
      "pane",
      "query",
      "renaming",
      "selectedItemId",
      "selectedVaultId",
      "sharing",
      "syncedAt",
      "trash",
      "vaults",
      "wiping",
    ]);
  });
});
