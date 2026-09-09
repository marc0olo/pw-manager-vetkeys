import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Array "mo:core/Array";
import Shared "Types";

/// Reading encrypted values. Delegations, and the group this application has
/// never had a reason to change — it inherits all four, which is the point of
/// separating them from the writes it does change.
mixin (encryptedMaps : EncryptedMaps.EncryptedMaps<Types.AccessRights>) {
  public type EncryptedMapData = {
    map_owner : Principal;
    map_name : Shared.ByteBuf;
    keyvals : [(Shared.ByteBuf, Shared.ByteBuf)];
    access_control : [(Principal, Types.AccessRights)];
  };

  /// Written with the mapping inline, because a named helper declared
  /// `... : (ByteBuf, ByteBuf)` cannot be passed to `Array.map`:
  ///
  ///     expression of type   ((Blob, Blob)) -> (ByteBuf, ByteBuf)
  ///     cannot produce type  ((Blob, Blob)) -> ((ByteBuf, ByteBuf))
  ///
  /// Motoko reads `-> (A, B)` as returning two values, where `Array.map` wants
  /// one value that is a tuple. Writing the return type as `((A, B))` does
  /// compile — verified — but a stray pair of parentheses carrying that much
  /// meaning is what a later tidy-up removes, so the lambda stays.
  ///
  /// Any endpoint group that maps pairs hits this, which is why the note lives
  /// with the code rather than in the application that used to hold it.
  func bufs(pairs : [(Blob, Blob)]) : [(Shared.ByteBuf, Shared.ByteBuf)] {
    Array.map<(Blob, Blob), (Shared.ByteBuf, Shared.ByteBuf)>(
      pairs,
      func((a, b) : (Blob, Blob)) { ({ inner = a }, { inner = b }) },
    );
  };

  public query (msg) func get_encrypted_values_for_map(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
  ) : async Shared.Result<[(Shared.ByteBuf, Shared.ByteBuf)], Text> {
    switch (encryptedMaps.getEncryptedValuesForMap(msg.caller, (map_owner, map_name.inner))) {
      case (#err(e)) { #Err(e) };
      case (#ok(values)) { #Ok(bufs(values)) };
    };
  };

  public query (msg) func get_encrypted_value(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    map_key : Shared.ByteBuf,
  ) : async Shared.Result<?Shared.ByteBuf, Text> {
    switch (encryptedMaps.getEncryptedValue(msg.caller, (map_owner, map_name.inner), map_key.inner)) {
      case (#err(e)) { #Err(e) };
      case (#ok(null)) { #Ok(null) };
      case (#ok(?blob)) { #Ok(?{ inner = blob }) };
    };
  };

  public query (msg) func get_all_accessible_encrypted_values() : async [((Principal, Shared.ByteBuf), [(Shared.ByteBuf, Shared.ByteBuf)])] {
    Array.map<((Principal, Blob), [(Blob, Blob)]), ((Principal, Shared.ByteBuf), [(Shared.ByteBuf, Shared.ByteBuf)])>(
      encryptedMaps.getAllAccessibleEncryptedValues(msg.caller),
      func(((owner, name), values)) { ((owner, { inner = name }), bufs(values)) },
    );
  };

  public query (msg) func get_all_accessible_encrypted_maps() : async [EncryptedMapData] {
    Array.map<EncryptedMaps.EncryptedMapData<Types.AccessRights>, EncryptedMapData>(
      encryptedMaps.getAllAccessibleEncryptedMaps(msg.caller),
      func(map) {
        {
          map_owner = map.map_owner;
          map_name = { inner = map.map_name };
          keyvals = bufs(map.keyvals);
          access_control = map.access_control;
        };
      },
    );
  };
};
