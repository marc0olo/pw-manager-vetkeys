import Cycles "mo:core/Cycles";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Types "../types";

/// What this canister can tell about its own ability to derive vault keys.
///
/// A module rather than part of an endpoint group: the watchdog is called from
/// every update endpoint the application owns, so it belongs to no single
/// group. That a mixin may hold no state is what fixes the shape — state
/// arrives as a parameter, and the thresholds are static, so they live in a
/// module instead of as `transient let` in an actor.
module {
  /// The balance under which the watchdog warns the operator.
  ///
  /// Two measurements set it, rather than a ratio. Derivation fails somewhere
  /// near 480 B: on a local replica the last success was at 482.0 B and the
  /// next attempt failed at 471.9 B, so a derive needs a few hundred billion
  /// cycles of *room*, not the 10 B `test_key_1` reserves. And the replica checks —
  /// which are what drains this canister — cost a few hundred billion per
  /// round. Headroom is therefore counted **to the cliff rather than to zero**;
  /// the two are most of a round apart.
  ///
  /// 3 T leaves several rounds of it. The quotient is deliberately not written
  /// down: both inputs move, `scripts/lib/cycles.mjs` already measures the
  /// round cost on every run, and mainnet's vetKD price is not the local
  /// replica's — the fee follows the subnet the *key* lives on, so `key_1` on
  /// the fiduciary subnet reserves 26.15 B against `test_key_1`'s 10 B,
  /// wherever this canister is deployed. Warning early costs one log line.
  public let WARN_OPERATOR_BELOW = 3_000_000_000_000;

  /// The balance under which cycles may be named to a **user** as the cause.
  ///
  /// Far below {@link WARN_OPERATOR_BELOW}, because the two answer different
  /// questions and want opposite answers. The warning asks "is there still
  /// time to act?" and should fire early. This one becomes a sentence somebody
  /// reads — *this deployment has run out of cycles* — which is only true near
  /// the cliff. Said at three trillion it would be a guess dressed as a
  /// diagnosis, and `get_service_health` exists to avoid exactly that.
  ///
  /// About twice the measured cliff: margin for a boundary that moves with the
  /// subnet's vetKD price, not a claim to know where it is.
  public let BLAME_CYCLES_BELOW = 1_000_000_000_000;

  /// Say so, in the canister's own log, while everything still works.
  ///
  /// This exists because the failure it anticipates is unreadable: a canister
  /// too low to afford its own `vetkd_derive_key` call rejects with `IC0406
  /// could not perform remote call`, the client cannot tell that cause from a
  /// key missing on the subnet or from queue pressure, and in a password
  /// manager the result reads as **data loss** — unlocking fails, so the
  /// secrets look gone. Nothing is gone.
  ///
  /// `Log visibility: Controllers` is the default, so this is maintainer-only
  /// and discloses nothing; a public balance endpoint would tell everyone how
  /// well funded the deployment is and help only the operator, who has
  /// `icp canister status` already.
  ///
  /// **Called from every update endpoint this canister owns**, and not from the
  /// four the mixin contributes: `get_encrypted_vetkey` — the call that
  /// actually fails — plus `get_vetkey_verification_key`, `set_user_rights` and
  /// `remove_user`. A mixin's methods cannot be wrapped
  /// (dfinity/vetkeys#443), so a session that only opens vaults and manages
  /// sharing never ticks this. Storing a secret is the earliest thing the
  /// canister can observe for itself.
  ///
  /// Printed on the transition rather than on every write: the log holds 4 KiB
  /// by default, so a line repeated per write would leave a buffer containing
  /// nothing but copies of itself.
  public func watchdog(state : Types.HealthState) {
    let balance = Cycles.balance();
    if (balance < WARN_OPERATOR_BELOW) {
      if (not state.warnedLowCycles) {
        state.warnedLowCycles := true;
        Debug.print(
          "WARN cycles balance is low (" # balance.toText()
          # "). Vault key derivation fails once the canister cannot afford"
          # " vetkd_derive_key, which surfaces to users as IC0406 and looks"
          # " like data loss. Top up."
        );
      };
    } else if (state.warnedLowCycles) {
      state.warnedLowCycles := false;
      Debug.print("INFO cycles balance recovered (" # balance.toText() # ")");
    };
  };

  /// Whether cycles may honestly be named to a user as the cause of a failure.
  public func blameable() : Bool = Cycles.balance() < BLAME_CYCLES_BELOW;
};
