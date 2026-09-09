import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Time "mo:core/Time";
import Digest "Digest";
import History "History";
import Types "../types";

/// Writing to the event log, and the liveness question every write needs.
///
/// A module because the value writes, restores, and the poll all record or ask
/// about liveness — it belongs to no single group, and a group may not hold the
/// sequence counter it advances.
module {
  public func now() : Nat64 = Nat64.fromIntWrap(Time.now());

  /// Which map keys currently hold a value, as a predicate.
  ///
  /// Liveness is the library's state and its key comparator is private, so this
  /// goes through the public read API. Every caller here has already passed an
  /// access check; a refusal yields "nothing is live", which only ever makes the
  /// trash view larger, never a disclosure.
  public func liveness(
    encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
    caller : Principal,
    owner : Principal,
    mapName : Blob,
  ) : Blob -> Bool {
    let live = switch (encryptedMaps.getEncryptedValuesForMap(caller, (owner, mapName))) {
      case (#err(_)) { [] };
      case (#ok(pairs)) { pairs.map(func((key, _)) = key) };
    };
    livenessOf(live);
  };

  /// The same predicate from a list of keys already in hand, for the poll path
  /// where the listing has just produced them.
  public func livenessOf(keys : [Blob]) : Blob -> Bool {
    func(mapKey : Blob) : Bool = keys.contains(mapKey);
  };

  /// Append events, then reclaim this vault's expired groups.
  ///
  /// Reclamation is a side errand, not the guarantee: the read paths filter by
  /// age, so an expired group is unreachable whether or not this has run. What
  /// it costs to skip is bytes on disk for a vault nobody writes to.
  public func record(
    events : Types.EventsState,
    by : Principal,
    owner : Principal,
    mapName : Blob,
    entries : [(Blob, ?Blob, History.Kind)],
    isLive : Blob -> Bool,
  ) {
    let at = now();
    var next = events.log;
    for ((mapKey, value, kind) in entries.values()) {
      next := History.append(next, (owner, mapName, mapKey, events.nextSeq), { value; at; by; kind });
      events.nextSeq += 1;
    };
    events.log := History.purge(next, owner, mapName, isLive, at);
  };

  /// Fingerprint of what a trash listing would return.
  public func trashDigest(rows : [(Blob, Nat64, History.Entry)]) : Blob {
    Digest.ofTrash(rows.map(func((key, seq, _)) = (key, seq)));
  };
};
