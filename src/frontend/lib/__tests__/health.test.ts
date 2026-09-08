import { describe, expect, it, vi } from "vitest";
import { isOutboundCallFailure, outageMessage, type Health } from "../health";

/** What the agent actually throws when the canister cannot afford its own call. */
const IC0406 = new Error(
  "Call failed:\n  Canister: 4caro-hl777-77775-aaaba-cai\n  Method: get_encrypted_vetkey (query)\n" +
    '  "Request ID": "1f2e"\n  "Reject code": "4"\n  "Reject message": "could not perform remote call"\n' +
    '  "Error code": "IC0406"',
);

const asking = (health: Health) => vi.fn<() => Promise<Health>>().mockResolvedValue(health);

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
