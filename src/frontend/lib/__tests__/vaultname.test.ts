import { describe, expect, it } from "vitest";
import { isValidVaultName, labelTaken, newVaultName, type VaultSummary } from "../vault";
import { Principal } from "@icp-sdk/core/principal";

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

describe("labelTaken", () => {
  const ALICE = Principal.fromText("2ibo7-dia");
  const BOB = Principal.fromText("aaaaa-aa");
  const v = (o: Partial<VaultSummary>): VaultSummary => ({
    owner: ALICE,
    name: "abc123",
    displayName: null,
    isOwned: true,
    rights: null,
    sharedWith: [],
    itemIds: [],
    fingerprint: "f",
    trashed: 0,
    trashFingerprint: "t",
    ...o,
  });

  it("catches a duplicate display name", () => {
    expect(labelTaken([v({ name: "a", displayName: "Work" })], "Work", null)).toBe(true);
  });

  it("ignores the vault being renamed, so a no-op rename is not a collision", () => {
    const mine = v({ name: "a", displayName: "Work" });
    expect(labelTaken([mine], "Work", "2ibo7-dia/a")).toBe(false);
  });

  it("compares what a vault renders as, not only its display name", () => {
    // An unnamed vault shows its map name, so a display name equal to it
    // collides on screen just as surely.
    expect(labelTaken([v({ name: "abc123", displayName: null })], "abc123", null)).toBe(true);
  });

  it("trims, because the canister does", () => {
    expect(labelTaken([v({ name: "a", displayName: "Work" })], "  Work  ", null)).toBe(true);
  });

  it("is per owner — a vault shared with you cannot collide confusingly", () => {
    // The sidebar splits owned from shared and names the sharer, so Bob's
    // "Work" and yours are already distinguishable.
    expect(labelTaken([v({ owner: BOB, isOwned: false, displayName: "Work" })], "Work", null)).toBe(false);
  });

  it("is case-sensitive on purpose", () => {
    // Refusing a name for a difference the user cannot see is its own problem,
    // and normalisation has no clean answer.
    expect(labelTaken([v({ displayName: "Work" })], "work", null)).toBe(false);
  });

  it("says nothing about an empty name, which clears rather than sets", () => {
    expect(labelTaken([v({ displayName: "Work" })], "   ", null)).toBe(false);
  });
});
