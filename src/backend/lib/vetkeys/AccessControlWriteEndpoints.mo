import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Shared "Types";

/// Granting and revoking access.
///
/// One group because they are the invariant boundary: every write to the
/// access-control state happens in `KeyManager.setUserRights` or
/// `removeUserRights`, so an application that gates one and inherits the other
/// has gated nothing.
mixin (encryptedMaps : EncryptedMaps.EncryptedMaps<Types.AccessRights>) {
  public shared (msg) func set_user_rights(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    user : Principal,
    access_rights : Types.AccessRights,
  ) : async Shared.Result<?Types.AccessRights, Text> {
    switch (encryptedMaps.setUserRights(msg.caller, (map_owner, map_name.inner), user, access_rights)) {
      case (#err(e)) { #Err(e) };
      case (#ok(previous)) { #Ok(previous) };
    };
  };

  public shared (msg) func remove_user(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    user : Principal,
  ) : async Shared.Result<?Types.AccessRights, Text> {
    switch (encryptedMaps.removeUser(msg.caller, (map_owner, map_name.inner), user)) {
      case (#err(e)) { #Err(e) };
      case (#ok(previous)) { #Ok(previous) };
    };
  };
};
