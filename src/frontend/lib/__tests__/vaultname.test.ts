import { describe, expect, it } from "vitest";
import { isValidVaultName, newVaultName } from "../vault";

/**
 * A vault *is* `(owner, name)`, so a name that differs by a space addresses a
 * different map while looking identical on screen. These rules exist to keep
 * that state from ever being created, which is why they live at the single point
 * every read and write passes through rather than in a form validator.
 */
describe("vault names", () => {
  it.each(["Personal", "My Cool Vault :)", "Réseau / équipe", "work — 2026", "a/b\\c\"d'e", "🔐"])(
    "accepts %j",
    (name) => {
      expect(isValidVaultName(name)).toBe(true);
    },
  );

  it.each([
    ["a leading space", " Work"],
    ["a trailing space", "Work "],
    ["both", "  Work  "],
    ["a trailing newline", "Work\n"],
    ["a trailing tab", "Work\t"],
    ["only whitespace", "   "],
  ])("rejects %s", (_label, name) => {
    expect(isValidVaultName(name)).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(isValidVaultName("")).toBe(false);
  });

  it("measures the cap in bytes, not characters", () => {
    expect(isValidVaultName("x".repeat(32))).toBe(true);
    expect(isValidVaultName("x".repeat(33))).toBe(false);

    // 8 emoji is 8 characters but 32 bytes; 9 exceeds the cap while still
    // reading as a short name.
    expect("🔐".repeat(8).length).toBeLessThan(33); // .length would say it fits
    expect(isValidVaultName("🔐".repeat(8))).toBe(true);
    expect(isValidVaultName("🔐".repeat(9))).toBe(false);
  });

  it("does not silently repair a name", () => {
    // The alternative — trimming — would address a different map than the caller
    // named. Rejecting is what keeps identity and display in agreement.
    expect(isValidVaultName("Work ")).toBe(false);
  });
});

describe("newVaultName", () => {
  // A vault *is* `(owner, mapName)` and its key derives from that pair, so the
  // map name can never change. A readable one would therefore keep the
  // original in plaintext canister state forever, however often the vault is
  // renamed — renaming only adds a display name beside it.
  it("is opaque, so a rename leaves nothing behind", () => {
    expect(newVaultName()).toMatch(/^[0-9a-f]{24}$/);
  });

  it("is random rather than sequential", () => {
    // A counter would leak how many vaults someone has created, need global
    // mutable state, and serialise creation.
    const names = new Set(Array.from({ length: 200 }, () => newVaultName()));
    expect(names.size).toBe(200);
  });

  it("fits the canister's cap on a map name", () => {
    // 12 bytes as hex is 24 characters, inside 32 — and 96 bits of entropy,
    // which is what makes deleting and re-creating "the same" vault
    // effectively impossible. That matters because the key would be identical.
    expect(new TextEncoder().encode(newVaultName()).length).toBeLessThanOrEqual(32);
  });
});
