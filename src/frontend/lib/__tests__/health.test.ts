import { describe, expect, it, vi } from "vitest";
import { isOutboundCallFailure, outageMessage, type Health } from "../health";
import { rejection } from "./rejection";

const IC0406 = rejection();

const asking = (health: Health) => vi.fn<() => Promise<Health>>().mockResolvedValue(health);

describe("the fixture", () => {
  it("is the shape the SDK really produces, so the rest of this file means something", () => {
    // Pinned rather than printed: this is the codebase's only record of what a
    // cycles-exhausted derivation looks like from the client, and an SDK
    // upgrade that reshapes it should fail here rather than quietly leave the
    // suite testing a string nothing throws any more.
    expect(IC0406.message).toContain("The replica returned a rejection error:");
    expect(IC0406.message).toContain("Reject text: could not perform remote call");
    expect(IC0406.message).toContain("Error code: IC0406");
    // An update, not a query — it makes the inter-canister call that fails.
    expect(IC0406.message).toContain("Method name: get_encrypted_vetkey");
  });
});

describe("isOutboundCallFailure", () => {
  it("recognises the canister failing its own call", () => {
    expect(isOutboundCallFailure(IC0406)).toBe(true);
  });

  it("does not claim anything about an ordinary failure", () => {
    expect(isOutboundCallFailure(new Error("unauthorized"))).toBe(false);
    expect(isOutboundCallFailure(new Error("Failed to fetch"))).toBe(false);
    expect(isOutboundCallFailure("IC0503 canister trapped")).toBe(false);
  });
});

describe("outageMessage", () => {
  it("leaves anything else to the caller, without a round trip", async () => {
    const ask = asking("low-cycles");
    expect(await outageMessage(new Error("Failed to fetch"), ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("answers the only question the user is asking, first", async () => {
    // Both causes look identical from the outside — the vault does not open —
    // and the fear is about the passwords. So that is the first sentence,
    // before any cause, in both branches.
    for (const health of ["low-cycles", "funded"] as const) {
      const text = (await outageMessage(IC0406, asking(health))) ?? "";
      expect(text.startsWith("Your passwords are still there, encrypted and unchanged.")).toBe(true);
    }
  });

  it("names the cause and who can fix it when the canister knows", async () => {
    const text = await outageMessage(IC0406, asking("low-cycles"));
    expect(text).toContain("run out of cycles");
    expect(text).toContain("tops it up");
    expect(text).toContain("whoever operates it");
  });

  it("does not guess a cause the canister did not give", async () => {
    const text = await outageMessage(IC0406, asking("funded"));
    expect(text).not.toContain("cycles");
    expect(text).toContain("did not");
  });

  it("treats a refused or unreachable answer as not knowing, not as an outage", async () => {
    // The canister answers only callers who can already see a vault, so "no
    // answer" is an ordinary outcome — and claiming an outage on it would tell
    // users a healthy deployment is broken.
    const text = await outageMessage(IC0406, asking("unknown"));
    expect(text).not.toContain("run out of cycles");
    expect(text).toContain("did not");
  });

  it("suggests retrying only when the cause might pass on its own", async () => {
    // An empty balance will not fix itself, so telling someone to try again
    // would be busywork; an unreported failure might be queue pressure.
    expect(await outageMessage(IC0406, asking("funded"))).toContain("Try again");
    expect(await outageMessage(IC0406, asking("low-cycles"))).not.toContain("Try again");
  });

  it("passes on the error code, and nothing else technical", async () => {
    // Quotable in a support request. The reject text, the method name and the
    // HTTP response are jargon the user cannot act on — and reading them under
    // a heading about a canister is exactly what made this look like data loss.
    const text = (await outageMessage(IC0406, asking("funded"))) ?? "";
    expect(text).toContain("IC0406");
    expect(IC0406.message).toContain("content-type");
    expect(text).not.toContain("content-type");
    expect(text).not.toContain("HTTP details");
    expect(text).not.toContain("get_encrypted_vetkey");
    expect(text).not.toContain("Reject text");
    expect(text.length).toBeLessThan(240);
  });
});

describe("when asking itself fails", () => {
  it("still explains the original error rather than replacing it with nothing", async () => {
    // `VaultClient.health` promises not to throw, but this must not depend on
    // a promise made somewhere else: a rejection escaping here would reach
    // `run`'s catch and leave the user with no banner at all.
    const ask = vi.fn<() => Promise<Health>>().mockRejectedValue(new Error("Failed to fetch"));
    const text = await outageMessage(IC0406, ask);
    expect(text).toContain("still there, encrypted and unchanged");
    expect(text).toContain("IC0406");
  });
});
