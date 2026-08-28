import { describe, expect, it } from "vitest";
import { isValidVaultName } from "../vault";

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
