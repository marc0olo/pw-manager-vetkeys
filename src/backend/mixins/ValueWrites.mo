import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Shared "../lib/vetkeys/Types";
import Cycles "../lib/Cycles";
import History "../lib/History";
import Recording "../lib/Recording";
import Vaults "../lib/Vaults";
import Types "../types";

/// The three value writes, which this application owns rather than inherits.
///
/// Owning them is the only way to record the value each write replaced — the
/// whole of version history and the trash. The `ValueReads` group is inherited
/// unchanged beside this one, which is the split dfinity/vetkeys#443 asks for:
/// the reads needed no change and should not have had to move.
///
/// Four parameters, which is this group's contract: the library instance, the
/// event log it appends to, the registry a first write claims a vault in, and
/// the watchdog's flag. All four are records or immutable, because a mixin
/// takes a `var` by value.
mixin (
  encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
  events : Types.EventsState,
  vaults : Types.VaultsState,
  health : Types.HealthState,
) {
  public shared (msg) func insert_encrypted_value(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    map_key : Shared.ByteBuf,
    value : Shared.ByteBuf,
  ) : async Shared.Result<?Shared.ByteBuf, Text> {
    Cycles.watchdog(health);
    switch (encryptedMaps.insertEncryptedValue(msg.caller, (map_owner, map_name.inner), map_key.inner, value.inner)) {
      case (#err(e)) { #Err(e) };
      // Nothing was superseded, so there is no version to keep — but the write
      // itself is worth recording. Otherwise a secret nobody has edited has no
      // canister-side timestamp or author, and the only "updated" a client
      // could show is the one written *inside* the plaintext by whoever saved
      // it, which is the writer's to choose.
      case (#ok(null)) {
        Vaults.register(vaults, map_owner, map_name.inner);
        Recording.record(
          events,
          msg.caller,
          map_owner,
          map_name.inner,
          [(map_key.inner, null, #Created)],
          Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner),
        );
        #Ok(null);
      };
      case (#ok(?blob)) {
        // Registered here too, not only on a first write: a map that predates
        // the registry has no entry, and an ordinary edit is the cheapest place
        // to acquire one.
        Vaults.register(vaults, map_owner, map_name.inner);
        // The value this write replaced. Recording it here is the whole of
        // version events.log: without it an edit destroys the previous secret,
        // which trash never covered because trash only sees deletions.
        Recording.record(
          events,
          msg.caller,
          map_owner,
          map_name.inner,
          [(map_key.inner, ?blob, #Edited)],
          Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner),
        );
        #Ok(?{ inner = blob });
      };
    };
  };

  public shared (msg) func remove_encrypted_value(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    map_key : Shared.ByteBuf,
  ) : async Shared.Result<?Shared.ByteBuf, Text> {
    Cycles.watchdog(health);
    // The library call first: it performs the access check, and hands back the
    // value it removed. Only then is our store touched, so a caller without
    // rights leaves no trace.
    switch (encryptedMaps.removeEncryptedValue(msg.caller, (map_owner, map_name.inner), map_key.inner)) {
      case (#err(e)) { #Err(e) };
      case (#ok(null)) { #Ok(null) };
      case (#ok(?blob)) {
        Recording.record(
          events,
          msg.caller,
          map_owner,
          map_name.inner,
          [(map_key.inner, ?blob, #Deleted)],
          Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner),
        );
        #Ok(?{ inner = blob });
      };
    };
  };

  public shared (msg) func remove_map_values(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
  ) : async Shared.Result<[Shared.ByteBuf], Text> {
    Cycles.watchdog(health);
    // `removeMapValues` returns only the *keys* it removed, so the values have
    // to be read before the call — after it they are gone, and a wipe would
    // trash nothing.
    let before = switch (encryptedMaps.getEncryptedValuesForMap(msg.caller, (map_owner, map_name.inner))) {
      case (#err(_)) { [] };
      case (#ok(pairs)) { pairs };
    };
    switch (encryptedMaps.removeMapValues(msg.caller, (map_owner, map_name.inner))) {
      case (#err(e)) { #Err(e) };
      case (#ok(keys)) {
        Recording.record(
          events,
          msg.caller,
          map_owner,
          map_name.inner,
          Array.map<(Blob, Blob), (Blob, ?Blob, History.Kind)>(
            before,
            func((mapKey, value)) { (mapKey, ?value, #Deleted) },
          ),
          // The map is empty now, so nothing is live. Reading it back through
          // the library would say the same, at the cost of a second pass.
          func(_ : Blob) : Bool { false },
        );
        #Ok(Array.map<Blob, Shared.ByteBuf>(keys, func(b : Blob) : Shared.ByteBuf { { inner = b } }));
      };
    };
  };
};
