import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Blob "mo:core/Blob";
import Map "mo:core/pure/Map";
import Principal "mo:core/Principal";
import Shared "../lib/vetkeys/Types";
import Cycles "../lib/Cycles";
import Vaults "../lib/Vaults";
import Types "../types";

/// Granting and revoking access, which this application owns rather than
/// inherits.
///
/// The group is the access-control write boundary: every change to the ACL goes
/// through `setUserRights` or `removeUser`. Only the first can name a map that
/// does not exist, so only the first carries the existence check — removing
/// rights cannot bring a vault into being. The owner check is on both, because
/// it is a rule about *who may hold* rights, and the pair is what decides the
/// ACL's contents.
///
/// Owning it is what makes the vault invariant hold. `KeyManager` grants an
/// owner rights over any `(owner, mapName)` whether or not a map exists, and
/// the library lists shared maps from the ACL with no emptiness condition — so
/// sharing a map name nobody created would otherwise put a vault in the
/// grantee's sidebar that no `create_vault` ever named, and that its owner
/// cannot name afterwards.
///
/// It is also what keeps the owner out of their own ACL. Ownership is
/// identity-derived and never an ACL entry, but `KeyManager` refuses an
/// owner-targeted write only when the owner makes it — a manager's goes
/// through. The row it writes changes nothing about the owner's rights, and
/// lists the vault to its owner a second time, as shared with them.
mixin (
  encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
  vaults : Types.VaultsState,
  health : Types.HealthState,
) {
  /// The refusal for an ACL change that targets the owner.
  ///
  /// Authorization first, so a caller who may not manage this vault hears
  /// `unauthorized` whoever they named — the answer must not depend on the
  /// target. `getUserRights` is the check: it demands exactly the manage rights
  /// an ACL change does.
  func refuseOwnerTarget(caller : Principal, mapOwner : Principal, mapName : Blob) : Shared.Result<?VetKeys.AccessRights, Text> {
    switch (encryptedMaps.getUserRights(caller, (mapOwner, mapName), caller)) {
      case (#err(e)) { #Err(e) };
      case (#ok(_)) { #Err("the owner's access cannot be changed") };
    };
  };

  public shared (msg) func set_user_rights(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    user : Principal,
    access_rights : VetKeys.AccessRights,
  ) : async Shared.Result<?VetKeys.AccessRights, Text> {
    Cycles.watchdog(health);

    // Share-before-create is not a flow this app offers, so allowing it is
    // surface with no user behind it. Keyed on `map_owner` for the same reason
    // the value write is: rights are granted over their vault, not the
    // caller's.
    if (not Vaults.ownedBy(vaults, map_owner).containsKey(Blob.compare, map_name.inner)) {
      return #Err("no such vault");
    };
    if (user.equal(map_owner)) return refuseOwnerTarget(msg.caller, map_owner, map_name.inner);

    switch (encryptedMaps.setUserRights(msg.caller, (map_owner, map_name.inner), user, access_rights)) {
      case (#err(e)) { #Err(e) };
      case (#ok(previous)) { #Ok(previous) };
    };
  };

  public shared (msg) func remove_user(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    user : Principal,
  ) : async Shared.Result<?VetKeys.AccessRights, Text> {
    Cycles.watchdog(health);
    // Refused rather than answered with nothing removed, which is what the
    // library says — the same answer as for a principal never granted
    // anything, so "the owner is protected" was indistinguishable from "that
    // principal had nothing".
    if (user.equal(map_owner)) return refuseOwnerTarget(msg.caller, map_owner, map_name.inner);
    switch (encryptedMaps.removeUser(msg.caller, (map_owner, map_name.inner), user)) {
      case (#err(e)) { #Err(e) };
      case (#ok(previous)) { #Ok(previous) };
    };
  };
};
