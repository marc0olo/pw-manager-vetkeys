import { describe, expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { isUnauthorized, refusalMessage } from "../capabilities";
import { canManage, canWrite, type VaultSummary } from "../vault";

const me = Principal.fromText("2ibo7-dia");
const other = Principal.fromText("aaaaa-aa");

function vault(overrides: Partial<VaultSummary> = {}): VaultSummary {
  return {
    owner: other,
    name: "Team infra",
    displayName: null,
    isOwned: false,
    rights: null,
    sharedWith: [],
    itemIds: [],
    fingerprint: "f0",
    trashed: 0,
    trashFingerprint: "t0",
    ...overrides,
  };
}

describe("an owned vault", () => {
  it("can do everything, with no rights to consult", () => {
    const owned = vault({ owner: me, name: "Personal", isOwned: true });
    expect(canWrite(owned)).toBe(true);
    expect(canManage(owned)).toBe(true);
  });
});

describe("a shared vault", () => {
  it.each([
    ["Read", false, false],
    ["ReadWrite", true, false],
    ["ReadWriteManage", true, true],
  ] as const)("at %s can write=%s, manage=%s", (level, write, manage) => {
    const shared = vault({ rights: { [level]: null } as VaultSummary["rights"] });
    expect(canWrite(shared)).toBe(write);
    expect(canManage(shared)).toBe(manage);
  });

  it("offers nothing beyond reading when no rights were reported", () => {
    expect(canWrite(vault())).toBe(false);
    expect(canManage(vault())).toBe(false);
  });
});

describe("recognising a refusal", () => {
  it("accepts the library's exact wording", () => {
    expect(isUnauthorized(new Error("unauthorized"))).toBe(true);
  });

  it("accepts it wrapped in a reject prefix", () => {
    expect(isUnauthorized(new Error("Reject text: unauthorized"))).toBe(true);
  });

  it("ignores case and surrounding space", () => {
    expect(isUnauthorized(new Error("  Unauthorized  "))).toBe(true);
  });

  it.each([
    "Invalid signature from delegation",
    "Certificate verification failed",
    "fetch failed",
    "unauthorized access is not permitted by this canister",
  ])("treats %j as an ordinary failure", (message) => {
    // The safe direction: an unrecognised error keeps the control offered and
    // reports itself, rather than silently stripping a real capability.
    expect(isUnauthorized(new Error(message))).toBe(false);
  });

  it("survives a non-Error rejection", () => {
    expect(isUnauthorized("unauthorized")).toBe(true);
    expect(isUnauthorized(null)).toBe(false);
  });
});

describe("wording a refusal", () => {
  const refused = new Error("unauthorized");

  it.each([
    ["write", "You have read-only access to this vault."],
    ["manage", "You cannot change who has access to this vault."],
    ["open", "You no longer have access to this vault."],
  ] as const)("%s reads as %j", (attempted, expected) => {
    expect(refusalMessage(refused, attempted)).toBe(expected);
  });

  it("says nothing about access when the failure is not a refusal", () => {
    // A dead connection must not be reported as lost access.
    for (const attempted of ["write", "manage", "open"] as const) {
      expect(refusalMessage(new Error("fetch failed"), attempted)).toBeNull();
    }
  });

  it("distinguishes losing read access from being read-only", () => {
    // Different situations: one means the vault is gone, the other that it is
    // still yours to read. Sharing a string between them would mislead.
    expect(refusalMessage(refused, "open")).not.toBe(refusalMessage(refused, "write"));
  });
});
