import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Shared "Types";

/// The two endpoints that make an inter-canister call.
///
/// Their own group because that property is what an adopter wants to wrap: they
/// are the only place the library performs an action the canister does not
/// control, so they are the only place a `try/catch` would tell you anything.
///
/// Takes the constructed `EncryptedMaps` rather than the state: sibling mixins
/// cannot each declare `transient let encryptedMaps` — M0051 rejects a
/// duplicate binding exactly as it rejects a duplicate type.
mixin (encryptedMaps : EncryptedMaps.EncryptedMaps<Types.AccessRights>) {
  public shared func get_vetkey_verification_key() : async Shared.ByteBuf {
    { inner = await encryptedMaps.getVetkeyVerificationKey() };
  };

  public shared (msg) func get_encrypted_vetkey(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    transport_key : Shared.ByteBuf,
  ) : async Shared.Result<Shared.ByteBuf, Text> {
    switch (await encryptedMaps.getEncryptedVetkey(msg.caller, (map_owner, map_name.inner), transport_key.inner)) {
      case (#err(e)) { #Err(e) };
      case (#ok(key)) { #Ok({ inner = key }) };
    };
  };
};
