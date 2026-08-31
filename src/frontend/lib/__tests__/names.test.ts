import { describe, expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { isValidDisplayName, MAX_DISPLAY_NAME_BYTES } from "../names";
import { OWN_VAULT_NAME, vaultLabel, type VaultSummary } from "../vault";

const summary = (o: Partial<VaultSummary> = {}): VaultSummary => ({
  owner: Principal.fromText("2ibo7-dia"),
  name: OWN_VAULT_NAME,
  displayName: null,
  isOwned: true,
  rights: null,
  sharedWith: [],
  itemIds: [],
  fingerprint: "f0",
  ...o,
});

/**
 * A display name is a label, not an identity — which is exactly what makes its
 * rules different from a map name's. Compare vaultname.test.ts, where the same
 * inputs must be *rejected* because they would address a different vault.
 */
describe("display names", () => {
  it.each(["Home", "My Cool Vault :)", "Réseau / équipe", "🔐"])("accepts %j", (name) => {
    expect(isValidDisplayName(name)).toBe(true);
  });

  it("accepts surrounding whitespace, because the canister trims it", () => {
    // The opposite of a map name, where " Work" addresses a different vault and
    // silently repairing it would operate on something the caller did not name.
    expect(isValidDisplayName("  Work  ")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["only whitespace", "   "],
  ])("rejects %s, which means clear the name rather than rename", (_label, name) => {
    expect(isValidDisplayName(name)).toBe(false);
  });

  it("measures the cap in bytes, not characters", () => {
    expect(isValidDisplayName("x".repeat(MAX_DISPLAY_NAME_BYTES))).toBe(true);
    expect(isValidDisplayName("x".repeat(MAX_DISPLAY_NAME_BYTES + 1))).toBe(false);

    // 16 emoji is 16 characters but 64 bytes; 17 exceeds the cap while still
    // reading as a short name.
    expect("🔐".repeat(17).length).toBeLessThan(MAX_DISPLAY_NAME_BYTES);
    expect(isValidDisplayName("🔐".repeat(16))).toBe(true);
    expect(isValidDisplayName("🔐".repeat(17))).toBe(false);
  });

  it("measures the cap after trimming, as the canister does", () => {
    expect(isValidDisplayName(`  ${"x".repeat(MAX_DISPLAY_NAME_BYTES)}  `)).toBe(true);
  });
});

describe("what the UI shows", () => {
  it("prefers the chosen name", () => {
    expect(vaultLabel(summary({ displayName: "Home" }))).toBe("Home");
  });

  it("falls back to the map name when the vault was never renamed", () => {
    expect(vaultLabel(summary())).toBe(OWN_VAULT_NAME);
  });

  it("falls back rather than rendering a blank title", () => {
    // The canister removes the row rather than storing "", so this should not
    // arise — but a blank vault title would be a bad way to discover that it
    // had, so the fallback covers it too.
    expect(vaultLabel(summary({ displayName: "" }))).toBe(OWN_VAULT_NAME);
  });
});
