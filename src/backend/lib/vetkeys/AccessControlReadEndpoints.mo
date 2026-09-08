import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Shared "Types";

/// Reading the access control list. Separate from the writes because an
/// application replacing the writes — to require consent before a share takes
/// effect — has no reason to change how rights are read back.
mixin (encryptedMaps : EncryptedMaps.EncryptedMaps<Types.AccessRights>) {
  public query (msg) func get_user_rights(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    user : Principal,
  ) : async Shared.Result<?Types.AccessRights, Text> {
    switch (encryptedMaps.getUserRights(msg.caller, (map_owner, map_name.inner), user)) {
      case (#err(e)) { #Err(e) };
      case (#ok(rights)) { #Ok(rights) };
    };
  };

  public query (msg) func get_shared_user_access_for_map(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
  ) : async Shared.Result<[(Principal, Types.AccessRights)], Text> {
    switch (encryptedMaps.getSharedUserAccessForMap(msg.caller, (map_owner, map_name.inner))) {
      case (#err(e)) { #Err(e) };
      case (#ok(entries)) { #Ok(entries) };
    };
  };
};
