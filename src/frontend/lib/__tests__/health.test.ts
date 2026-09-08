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
    const text = await outageMessage(IC0406, asking("funded"));
    expect(text).toContain("IC0406");
    // The three things a bug report needs, and nothing that needs scrolling.
    // Matched loosely on the reject text because it varies with the cause:
    // an empty balance says "remote call", a freezing threshold reserving the
    // balance says "self call". Both are IC0406.
    expect(text).toMatch(/Reject text: could not perform \w+ call/);
    expect(text).toContain("get_encrypted_vetkey");
  });

  it("says something even when the error is not shaped like a rejection", async () => {
    // The summariser keeps named lines. An error with none — a reshaped SDK, a
    // wrapper, a bare string — must fall back to the whole text rather than to
    // an empty explanation.
    const odd = new Error("the gateway mangled this, but it mentions IC0406");
    expect(await outageMessage(odd, asking("funded"))).toContain("the gateway mangled this");
  });

  it("stays readable, because a banner is not a place to dump a CBOR response", async () => {
    // What shipped first pasted `error.message` verbatim. The SDK appends the
    // entire HTTP response, so the one useful line arrived after every
    // response header — reported from a real run.
    const text = (await outageMessage(IC0406, asking("funded"))) ?? "";
    expect(IC0406.message).toContain("content-type");
    expect(text).not.toContain("content-type");
    expect(text).not.toContain("HTTP details");
    expect(text).not.toContain("Request ID");
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
    expect(text).toContain("did not report why");
    expect(text).toContain("IC0406");
  });
});
