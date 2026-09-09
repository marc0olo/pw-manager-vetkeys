import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Map "mo:core/pure/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Result "mo:core/Result";
import Types "../types";

/// The registry of vaults this canister knows about, independent of whether the
/// library can still see them.
///
/// A module because the value writes register a vault, the vault group creates
/// and deletes them, and the poll lists them — three groups over one registry.
module {
  /// Bounds a single row. Display names are not key material, so this is about
  /// storage rather than correctness — but unbounded text from any caller is
  /// not something to leave open.
  public let MAX_DISPLAY_NAME_BYTES = 64;

  /// Bounds how many rows one principal can occupy. Row *size* was bounded from
  /// the start and row *count* was not, which left an open-ended write for any
  /// caller. Generous enough that no real user meets it.
  public let MAX_NAMES_PER_OWNER = 100;

  /// Bounds vaults *claimed* with `create_vault` — an entry with no map behind
  /// it, which is app-only state the library does not mirror.
  ///
  /// Registration on a write is deliberately **not** bounded by this. The
  /// library keeps no cap of its own on maps per owner, so a caller who writes
  /// to a thousand map names already makes the canister store a thousand maps;
  /// an entry here is a constant-factor addition to state they have already
  /// forced. Capping it bounded nothing and created a vault its owner could not
  /// see — measured: past the cap a write went unregistered, and emptying that
  /// vault then hid it while its trash survived.
  public let MAX_CLAIMED_VAULTS_PER_OWNER = 100;

  /// Bounds a map name. The library caps a map *key* at 32 bytes; a map name
  /// has no cap of its own, and an unbounded name from any caller is the same
  /// open-ended write the display-name cap closed.
  public let MAX_MAP_NAME_BYTES = 32;

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

  /// Every rule a display name must satisfy, in one place.
  ///
  /// Returns the *trimmed* name, which is what callers should store: a
  /// surrounding space carries no identity here, unlike in a map name where it
  /// addresses a different vault, so trimming is safe and saves the user a
  /// pointless error.
  ///
  /// Shared by creating and renaming, which is the point — the two used to
  /// enforce these separately, and creation enforced them *after* the vault
  /// existed.
  public func validateName(
    vaults : Types.VaultsState,
    owner : Principal,
    mapName : Blob,
    display : Text,
  ) : Result.Result<Text, Text> {
    let trimmed = Text.trim(display, #predicate(Char.isWhitespace));

    // No clearing. It used to revert to the map name, which was reasonable
    // while that was something a user had chosen — but vaults are created with
    // a random id, so "reset" would rename the vault to `a3f1b2c4…`.
    if (trimmed == "") return #err("A vault needs a name.");

    if (Text.encodeUtf8(trimmed).size() > MAX_DISPLAY_NAME_BYTES) {
      return #err("A vault name may be at most " # debug_show (MAX_DISPLAY_NAME_BYTES) # " bytes.");
    };

    // Renaming a vault that already has a name replaces its row, so only a new
    // one counts against the cap.
    let mine = namesOwnedBy(vaults, owner);
    if (Map.size(mine) >= MAX_NAMES_PER_OWNER and mine.get(Blob.compare, mapName) == null) {
      return #err("You have named the maximum of " # debug_show (MAX_NAMES_PER_OWNER) # " vaults.");
    };

    if (labelTaken(vaults, owner, mapName, trimmed)) {
      return #err("You already have a vault called \"" # trimmed # "\".");
    };

    #ok(trimmed);
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
