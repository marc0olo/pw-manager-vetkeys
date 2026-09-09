import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Shared "../lib/vetkeys/Types";
import Cycles "../lib/Cycles";
import Types "../types";
import Map "mo:core/pure/Map";
import Principal "mo:core/Principal";
import Blob "mo:core/Blob";

/// Why a `vetkd_derive_key` call might have just failed, for a client that has
/// one to explain.
///
/// Takes the vaults registry as well as its own state, because the gate below
/// is "can this caller already see a vault" — the health answer is scoped by
/// vault ownership, which is a dependency across groups rather than within
/// one. Worth noting for dfinity/vetkeys#443: a group's parameters are its
/// contract, and this one reaches wider than its name suggests.
mixin (
  encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
  vaults : Types.VaultsState,
) {
  /// The canister cannot classify the failure itself. `get_encrypted_vetkey`
  /// belongs to the control-plane groups, and a mixin's methods cannot be
  /// wrapped, so there is no server-side place to catch it
  /// (dfinity/vetkeys#443). So the client has to ask, and this is the answer.
  ///
  /// **Restricted to callers who can already see a vault.** By the time a
  /// derive can fail for you, you have one: `create_vault` makes no
  /// inter-canister call, so it succeeds on an unfunded canister, and opening
  /// what you just created is the first thing that derives. Someone with no
  /// vault therefore has no failure to explain, and learns nothing here.
  ///
  /// Being honest about that gate: it stops passive scraping, not a determined
  /// prober, who can make an identity and a vault. It is a speed bump plus a
  /// "you are affected anyway" filter, not a boundary. What keeps it cheap to
  /// be wrong is that the answer is one bit and says nothing about how much
  /// funding is left, or for how long.
  public query (msg) func get_service_health() : async Shared.Result<Types.ServiceHealth, Text> {
    if (not seesAnyVault(msg.caller)) return #Err("unauthorized");
    #Ok(if (Cycles.blameable()) #low_cycles else #funded);
  };

  /// Whether this caller has any vault at all — owned or shared with them.
  ///
  /// Read from the registry and the access control list rather than from
  /// `getAllAccessibleEncryptedMaps`, which would carry every vault's
  /// ciphertext to answer a yes/no question.
  func seesAnyVault(who : Principal) : Bool {
    let mine = vaults.owned.get(Principal.compare, who) ?? Map.empty<Blob, ()>();
    if (mine.size() > 0) return true;
    encryptedMaps.getAccessibleSharedMapNames(who).size() > 0;
  };
};
