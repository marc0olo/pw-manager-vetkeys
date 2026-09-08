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

  it("leads with what is not true: the secrets are intact", async () => {
    const text = await outageMessage(IC0406, asking("low-cycles"));
    expect(text).toContain("run out of cycles");
    expect(text).toContain("intact");
    // The whole point. A password manager saying "could not" about unlocking
    // reads as loss, so the message must not stop at the failure.
    expect(text).toContain("topped up");
  });

  it("does not guess a cause the canister did not give", async () => {
    const text = await outageMessage(IC0406, asking("funded"));
    expect(text).not.toContain("cycles");
    expect(text).toContain("did not report why");
  });

  it("treats a refused or unreachable answer as not knowing, not as an outage", async () => {
    // The canister answers only callers who can already see a vault, so "no
    // answer" is an ordinary outcome — and claiming an outage on it would tell
    // users a healthy deployment is broken.
    const text = await outageMessage(IC0406, asking("unknown"));
    expect(text).not.toContain("run out of cycles");
    expect(text).toContain("did not report why");
  });

  it("carries the underlying error, so an unexplained failure stays diagnosable", async () => {
    expect(await outageMessage(IC0406, asking("funded"))).toContain("IC0406");
  });
});

describe("when asking itself fails", () => {
  it("still explains the original error rather than replacing it with nothing", async () => {
    // `VaultClient.health` promises not to throw, but this must not depend on
    // a promise made somewhere else: a rejection escaping here would reach
    // `run`'s catch and leave the user with no banner at all.
    const ask = vi.fn<() => Promise<Health>>().mockRejectedValue(new Error("Failed to fetch"));
    const text = await outageMessage(IC0406, ask);
    expect(text).toContain("did not report why");
    expect(text).toContain("IC0406");
  });
});
