import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Array "mo:core/Array";
import Shared "Types";

/// Which vaults a caller can see. Reads only, and the group an application
/// wants when it needs to filter what a user is shown — declining an
/// unsolicited share, for instance.
mixin (encryptedMaps : EncryptedMaps.EncryptedMaps<Types.AccessRights>) {
  public query (msg) func get_accessible_shared_map_names() : async [(Principal, Shared.ByteBuf)] {
    Array.map<(Principal, Blob), (Principal, Shared.ByteBuf)>(
      encryptedMaps.getAccessibleSharedMapNames(msg.caller),
      func((principal, name)) { (principal, { inner = name }) },
    );
  };

  public query (msg) func get_owned_non_empty_map_names() : async [Shared.ByteBuf] {
    Array.map<Blob, Shared.ByteBuf>(
      encryptedMaps.getOwnedNonEmptyMapNames(msg.caller),
      func(name) { { inner = name } },
    );
  };
};
