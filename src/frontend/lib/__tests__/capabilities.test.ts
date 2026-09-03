import { describe, expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import {
  isUnauthorized,
  offers,
  refusalMessage,
  verdictFor,
  withDenial,
  type Denials,
} from "../capabilities";
import { vaultId, type VaultSummary } from "../vault";

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

const owned = vault({ owner: me, name: "Personal", isOwned: true });
const shared = vault();
const id = vaultId(shared);
const none: Denials = [];

describe("an owned vault", () => {
  it("can do everything without asking", () => {
    expect(verdictFor(owned, "write", none)).toBe("granted");
    expect(verdictFor(owned, "manage", none)).toBe("granted");
  });

  it("cannot be denied, since the owner's rights are not in the list", () => {
    const denied = withDenial(withDenial(none, vaultId(owned), "write"), vaultId(owned), "manage");
    expect(verdictFor(owned, "write", denied)).toBe("granted");
  });
});

describe("a shared vault whose rights the canister will not disclose", () => {
  // This is every shared vault today. Reading it as "no" is the bug in #9.
  it("is untested, not denied", () => {
    expect(verdictFor(shared, "write", none)).toBe("untested");
    expect(verdictFor(shared, "manage", none)).toBe("untested");
  });

  it("still offers the controls", () => {
    expect(offers(verdictFor(shared, "write", none))).toBe(true);
    expect(offers(verdictFor(shared, "manage", none))).toBe(true);
  });
});

describe("learning from a refusal", () => {
  it("stops offering the capability that was refused", () => {
    const denied = withDenial(none, id, "write");
    expect(verdictFor(shared, "write", denied)).toBe("denied");
    expect(offers(verdictFor(shared, "write", denied))).toBe(false);
  });

  it("infers that a refused write also settles manage", () => {
    // Every level that can manage can also write, so a refused write means Read.
    const denied = withDenial(none, id, "write");
    expect(verdictFor(shared, "manage", denied)).toBe("denied");
  });

  it("does not infer the reverse: ReadWrite can write but not manage", () => {
    const denied = withDenial(none, id, "manage");
    expect(verdictFor(shared, "write", denied)).toBe("untested");
  });

  it("keeps denials to the vault they came from", () => {
    const otherVault = vault({ name: "Second" });
    const denied = withDenial(none, id, "write");
    expect(verdictFor(otherVault, "write", denied)).toBe("untested");
  });

  it("does not grow on a repeated refusal", () => {
    const once = withDenial(none, id, "write");
    expect(withDenial(once, id, "write")).toEqual(once);
  });
});

describe("rights the canister does disclose", () => {
  // Unreachable until dfinity/vetkeys#438 ships, but it is the path that
  // retires attempt-and-adapt, so it is pinned now.
  it.each([
    ["Read", "denied", "denied"],
    ["ReadWrite", "granted", "denied"],
    ["ReadWriteManage", "granted", "granted"],
  ] as const)("%s can write=%s, manage=%s", (level, write, manage) => {
    const known = vault({ rights: { [level]: null } as VaultSummary["rights"] });
    expect(verdictFor(known, "write", none)).toBe(write);
    expect(verdictFor(known, "manage", none)).toBe(manage);
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
