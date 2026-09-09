import Blob "mo:core/Blob";
import Map "mo:core/pure/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Types "../types";

/// The registry of vaults this canister knows about, independent of whether the
/// library can still see them.
///
/// A module because the value writes register a vault, the vault group creates
/// and deletes them, and the poll lists them — three groups over one registry.
module {
  /// The vaults this owner holds, or an empty map.
  public func ownedBy(vaults : Types.VaultsState, owner : Principal) : Map.Map<Blob, ()> {
    vaults.owned.get(Principal.compare, owner) ?? Map.empty<Blob, ()>();
  };

  /// The names this owner has given their vaults, or an empty map.
  ///
  /// `vaults.names` is `owner -> mapName -> display name`, and absent means
  /// "show the map name", so nothing needs backfilling. Keyed by owner rather
  /// than by the `(owner, mapName)` pair because the primary read is "every
  /// name *I* own", which runs on the poll path; the pair-keyed form made it
  /// O(rows across all users) per poll.
  public func namesOwnedBy(vaults : Types.VaultsState, owner : Principal) : Map.Map<Blob, Text> {
    vaults.names.get(Principal.compare, owner) ?? Map.empty<Blob, Text>();
  };

  /// Record that this principal owns this vault, if it is not recorded already.
  ///
  /// Called when a value is written, so a vault becomes permanent the moment it
  /// holds something — and stays listed after everything in it is deleted,
  /// which is the whole point.
  ///
  /// **Unconditional.** Declining to register — on a cap, or on any other
  /// condition — produces a map with no entry, and once its values go it is a
  /// vault its owner holds and cannot see, with its trash out of reach. That is
  /// the one failure direction this whole design avoids, so the only safe
  /// registration is one that cannot refuse.
  public func register(vaults : Types.VaultsState, owner : Principal, mapName : Blob) {
    let mine = ownedBy(vaults, owner);
    if (mine.containsKey(Blob.compare, mapName)) return;
    vaults.owned := vaults.owned.add(Principal.compare, owner, mine.add(Blob.compare, mapName, ()));
  };

  /// Whether another vault of this owner's already shows this label.
  ///
  /// Checks display names *and* map names, because an unnamed vault renders as
  /// its map name — so a display name equal to another vault's map name
  /// collides on screen just as surely as a duplicate display name. Vaults
  /// created through the app have random map names, which makes that case
  /// vanishingly unlikely rather than impossible.
  ///
  /// Excludes the vault being named, so renaming one to the label it already
  /// carries is not a collision with itself.
  public func labelTaken(
    vaults : Types.VaultsState,
    owner : Principal,
    mapName : Blob,
    wanted : Text,
  ) : Bool {
    let names = namesOwnedBy(vaults, owner);
    for ((otherName, display) in Map.entries(names)) {
      if (not otherName.equal(mapName) and display == wanted) return true;
    };
    for ((otherName, _) in Map.entries(ownedBy(vaults, owner))) {
      if (not otherName.equal(mapName) and names.get(Blob.compare, otherName) == null) {
        // Unnamed, so it renders as its map name.
        switch (Text.decodeUtf8(otherName)) {
          case (?asText) { if (asText == wanted) return true };
          case (null) {};
        };
      };
    };
    false;
  };
};
