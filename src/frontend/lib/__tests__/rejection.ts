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
  };
  return RejectError.fromCode(code);
}
