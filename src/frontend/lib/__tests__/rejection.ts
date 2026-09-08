import {
  ReplicaRejectCode,
  RejectError,
  UncertifiedRejectUpdateErrorCode,
  type RequestId,
} from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";

/**
 * What the agent throws when the canister cannot afford its own
 * `vetkd_derive_key` call — **built from the SDK's own error classes** rather
 * than transcribed.
 *
 * `get_encrypted_vetkey` is an update, so this is the update-reject shape. The
 * message is assembled by `@icp-sdk/core`, which means an SDK upgrade that
 * changes the wording changes this fixture with it. A pasted string would keep
 * passing while no longer resembling anything the app can actually receive,
 * and this is the codebase's only record of that error.
 *
 * Shared, because both the unit tests for the wording and the component tests
 * for the wiring have to fail the same way the canister does.
 */
export function rejection(): Error {
  const code = new UncertifiedRejectUpdateErrorCode(
    Uint8Array.from([0x1f, 0x2e]) as unknown as RequestId,
    ReplicaRejectCode.CanisterReject,
    "could not perform remote call",
    "IC0406",
  );
  code.callContext = {
    canisterId: Principal.fromText("aaaaa-aa"),
    methodName: "get_encrypted_vetkey",
    // The SDK appends the whole HTTP response, every header included, so a
    // real message runs to hundreds of characters of CBOR plumbing. Omitting
    // this is what let an unreadable banner ship: the fixture was short, so
    // nothing tested what a user would actually read.
    httpDetails: {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: [
        ["access-control-allow-origin", "*"],
        ["content-length", "1293"],
        ["content-type", "application/cbor"],
        ["x-ic-canister-id", "4fbx2-kt777-77775-aaabq-cai"],
        ["x-request-id", "01a08139-f0e0-7c70-a4bc-8d2cb7d09ea7"],
      ],
    },
  };
  return RejectError.fromCode(code);
}
