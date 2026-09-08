import { describe as group, expect, it } from "vitest";
import {
  CertificateVerificationErrorCode,
  HttpFetchErrorCode,
  ProtocolError,
  TransportError,
  TrustError,
} from "@icp-sdk/core/agent";
import { describe } from "../errors";
import { rejection } from "./rejection";

group("describe", () => {
  it("leaves the app's own errors exactly as written", () => {
    // These are already addressed to the user, and precisely — reclassifying
    // them would replace a sentence that says what to fix with a vague one.
    expect(describe(new Error("A vault name must be at most 32 bytes."))).toBe(
      "A vault name must be at most 32 bytes.",
    );
    expect(describe("something a string threw")).toBe("something a string threw");
  });

  it("never puts an agent error's own message in front of a user", () => {
    // The defect this exists for. `.message` is written for whoever debugs the
    // agent: it carries the request context and the entire HTTP response,
    // every header included.
    const raw = rejection();
    const text = describe(raw);
    expect(raw.message).toContain("content-type");
    expect(text).not.toContain("content-type");
    expect(text).not.toContain("HTTP details");
    expect(text.length).toBeLessThan(200);
  });

  it("says a network failure is a network failure, and what to do about it", () => {
    // The only one the user can act on without anyone else.
    const text = describe(TransportError.fromCode(new HttpFetchErrorCode(new Error("Failed to fetch"))));
    expect(text).toContain("Could not reach this deployment");
    expect(text).toContain("connection");
  });

  it("keeps a failed verification distinct from an unreachable host", () => {
    // Not the same event and not the same suspicion: a reply arrived and was
    // discarded, which points at what is between here and the canister.
    const text = describe(TrustError.fromCode(new CertificateVerificationErrorCode("signature")));
    expect(text).toContain("could not be verified");
    expect(text).toContain("discarded");
    expect(text).not.toContain("Could not reach");
  });

  it("quotes the replica's code, not the SDK's class name, when there is one", () => {
    // `IC0406` is documented and searchable; `UncertifiedRejectUpdateErrorCode`
    // is an implementation detail of the client.
    const text = describe(rejection());
    expect(text).toContain("IC0406");
    expect(text).not.toContain("ErrorCode");
  });

  it("falls back to the SDK's class name when no replica code is present", () => {
    // Something has to be quotable, or a support request has nothing in it.
    const text = describe(ProtocolError.fromCode(new CertificateVerificationErrorCode("no code here")));
    expect(text).toContain("CertificateVerificationErrorCode");
  });

  it("makes no claim about stored state, because a failed write may still have landed", () => {
    // Only the derive failure can promise that, and it does so in ./health,
    // where it knows a key was never fetched. Saying it here would sometimes
    // be a lie.
    for (const error of [
      TransportError.fromCode(new HttpFetchErrorCode(new Error("Failed to fetch"))),
      TrustError.fromCode(new CertificateVerificationErrorCode("signature")),
      rejection(),
    ]) {
      const text = describe(error);
      expect(text).not.toMatch(/nothing (was|has been) (changed|lost)/i);
      expect(text).not.toContain("unchanged");
    }
  });
});
