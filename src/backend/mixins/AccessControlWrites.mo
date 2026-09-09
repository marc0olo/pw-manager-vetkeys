import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Blob "mo:core/Blob";
import Map "mo:core/pure/Map";
import Shared "../lib/vetkeys/Types";
import Cycles "../lib/Cycles";
import Vaults "../lib/Vaults";
import Types "../types";

/// Granting and revoking access, which this application owns rather than
/// inherits.
///
/// The group is the access-control write boundary: every change to the ACL goes
/// through `setUserRights` or `removeUser`. Only the first can name a map that
/// does not exist, so only the first carries a precondition here — removing
/// rights cannot bring a vault into being. A gate on *who may hold* rights
/// would need both, since the pair is what decides the ACL's contents.
///
/// Owning it is what makes the vault invariant hold. `KeyManager` grants an
/// owner rights over any `(owner, mapName)` whether or not a map exists, and
/// the library lists shared maps from the ACL with no emptiness condition — so
/// sharing a map name nobody created would otherwise put a vault in the
/// grantee's sidebar that no `create_vault` ever named, and that its owner
/// cannot name afterwards.
mixin (
  encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
  vaults : Types.VaultsState,
  health : Types.HealthState,
) {
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
    switch (encryptedMaps.removeUser(msg.caller, (map_owner, map_name.inner), user)) {
      case (#err(e)) { #Err(e) };
      case (#ok(previous)) { #Ok(previous) };
    };
  };
};
