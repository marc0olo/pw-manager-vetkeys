import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import List "mo:core/List";
import Map "mo:core/pure/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Shared "../lib/vetkeys/Types";
import Access "../lib/Access";
import Cycles "../lib/Cycles";
import Digest "../lib/Digest";
import History "../lib/History";
import Recording "../lib/Recording";
import VaultsLib "../lib/Vaults";
import Types "../types";

/// Vaults as this application understands them: created, named, deleted, and
/// listed with everything a poll needs in one call.
///
/// The registry here is what makes an owned vault exist while it holds nothing
/// — the library's enumeration drops an emptied map (dfinity/vetkeys#439), and
/// this group is the local route around that.
///
/// Takes the state, not the whole actor: the library instance for reads, the
/// event log because deleting a vault drops its history and the poll reports
/// its trash, the registry it owns, and the watchdog flag.
mixin (
  encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
  encryptedMapsState : EncryptedMaps.EncryptedMapsState<VetKeys.AccessRights>,
  events : Types.EventsState,
  vaults : Types.VaultsState,
  health : Types.HealthState,
) {
  // Vault summaries for the poll
  //
  // The client polls every 15 s to notice a new item, an edit, or a revoked
  // vault. It used to do that with `get_all_accessible_encrypted_maps`, which
  // returns every accessible vault's complete ciphertext — measured at 14.6 KiB
  // for 50 items, re-downloaded and SHA-256'd on the main thread every tick,
  // purely to answer "did anything change".
  //
  // This returns the same listing with the values replaced by one digest per
  // vault: 1.2 KiB for the same 50 items, and no hashing in the browser. Item
  // *keys* are kept — they are plaintext, small, and the client needs them to
  // tell which item was deleted. Values are the bulk and are only ever needed
  // when a vault is actually opened, which is a separate call.
  //
  // The hashing moved rather than went away: this recomputes over every
  // accessible vault's full ciphertext on each poll, per client. It is well
  // inside a query's instruction budget, and the obvious fix — cache the digest
  // and invalidate on write — is *not available* here: writes go through the
  // mixin's own value endpoints, which this canister neither wraps nor can
  // hook. Making it incremental means owning those endpoints (the control-plane
  // variant, #8), or the library maintaining a per-map version itself.

  // Owned vaults
  //
  // The library composes `get_all_accessible_encrypted_maps` as *shared maps
  // from the ACL* ++ `get_owned_non_empty_map_names(caller)`, and that second
  // half loses a map the moment its last value goes (upstream
  // dfinity/vetkeys#439). So an owned vault cannot exist while empty, which is
  // why the client synthesises one and why creating a second would watch it
  // vanish on reload.
  //
  // This records the vaults a principal owns, and is **unioned** with the
  // library's enumeration rather than replacing it. The failure directions are
  // not symmetric: an entry with no map lists a vault with no contents, which
  // is exactly what an empty vault is, while a map with no entry would be a
  // vault its owner holds and cannot see. The second is unrecoverable from the
  // UI and would be reachable for every map that predates this, so a union
  // makes a missing entry free.
  //
  // For maps written *before* this existed the union is the only thing carrying
  // them, and one case it cannot carry: a vault already emptied, whose values
  // are gone and which was never registered. Its trash survives and becomes
  // unreachable. There is no events.log-derived backfill, so this ships with a
  // reinstall — which makes that state unreachable rather than merely unlikely.
  //
  // App-owned state duplicating something the library should know, so upstream
  // #439 is still the better fix — for every adopter, and with no second source
  // of truth. This is the route that does not wait.

  // Vault display names
  //
  // A vault *is* `(owner, mapName)` and its vetKey derives from that pair, so
  // renaming the map would mean decrypting every item, re-encrypting it under a
  // new key, and re-granting every collaborator — non-atomic, and visible to
  // them as the vault disappearing. This keeps the map exactly where it is and
  // stores a display name beside it, so a rename is one write.
  //
  // Purely additive: the mixin above is untouched, and this owns no value
  // endpoints, so there is no per-value state that could fall out of sync with
  // the library's own.
  //
  // The name is stored in the clear, deliberately. Everyone who can see a vault
  // must be able to read its name without deriving a key, or the lazy loading
  // this app depends on is undone. That is the same exposure map names already
  // have — access control has to be enforced in the clear regardless.

  /// Owned vaults the library's enumeration leaves out.
  ///
  /// The union half. An owned map disappears from
  /// `get_owned_non_empty_map_names` as soon as its last value goes, so
  /// without this an emptied vault takes its trash and its events.log out of reach
  /// exactly when recovery matters — and a second owned vault could never
  /// persist at all.
  ///
  /// Driven by the registry rather than by "has trash", which is what this
  /// replaces. That is sound only because registration cannot refuse: a vault
  /// can hold trash only if something was written to it, and every write
  /// registers, so the registry covers every vault the trash-based version did
  /// and also the ones holding nothing at all.
  ///
  /// It does not cover a vault emptied *before* this existed — no entry, no
  /// values, trash stranded. Nothing here can reconstruct that, which is why
  /// this ships with a reinstall rather than an upgrade.
  func ownedVaultsNotListed(caller : Principal, listed : [Types.VaultSummary], at : Nat64) : [Types.VaultSummary] {
    let extra = List.empty<Types.VaultSummary>();
    let seen = func(name : Blob) : Bool {
      for (summary in listed.values()) {
        if (Principal.compare(summary.owner, caller) == #equal and Blob.compare(summary.map_name.inner, name) == #equal) {
          return true;
        };
      };
      false;
    };
    for ((mapName, _) in Map.entries(VaultsLib.ownedBy(vaults, caller))) {
      if (not seen(mapName)) {
        // Absent from the library's listing means the map holds no values, so
        // nothing in it is live.
        let inTrash = History.trash(events.log, caller, mapName, func(_ : Blob) : Bool { false }, at);
        List.add(
          extra,
          {
            owner = caller;
            map_name = { inner = mapName };
            // Read rather than left empty. The caller owns this vault, so the
            // library will disclose its members — and this is the state where
            // the owner most needs them: an emptied vault whose collaborator
            // they may want to revoke. Reporting none made the share dialog say
            // "Only you." for a vault that was shared.
            access_control = switch (encryptedMaps.getSharedUserAccessForMap(caller, (caller, mapName))) {
              case (#err(_)) { [] };
              case (#ok(entries)) { entries };
            };
            item_keys = [];
            digest = { inner = Digest.ofKeyvals([]) };
            trashed = inTrash.size();
            my_rights = Access.rightsOf(encryptedMapsState, caller, caller, mapName);
            trash_digest = { inner = Recording.trashDigest(inTrash) };
          },
        );
      };
    };
    List.toArray(extra);
  };

  /// Claim a vault that holds nothing yet.
  ///
  /// The point of the registry: an entry can be written without inserting a
  /// value, which is what "create an empty vault" has always meant here. Until
  /// now a vault began existing when its first secret was stored, so there was
  /// no moment at which to name it or to land on it.
  ///
  /// The caller becomes the owner — a vault *is* `(owner, mapName)`, so there
  /// is nothing to assign. Idempotent: claiming one you already own succeeds
  /// and changes nothing, so a retry after a failed response is safe.
  ///
  /// The name is the caller's to choose and is stored in the clear, like every
  /// map name. The app generates an opaque id rather than a readable name (#13)
  /// so that renaming a vault does not leave the original in plaintext forever;
  /// that is a client concern, the same as item ids, and not something this can
  /// enforce.
  public shared (msg) func create_vault(map_name : Shared.ByteBuf) : async Shared.Result<(), Text> {
    Cycles.watchdog(health);
    if (Principal.isAnonymous(msg.caller)) {
      return #Err("Sign in to create a vault.");
    };
    if (map_name.inner.size() == 0) {
      return #Err("A vault needs a name.");
    };
    if (map_name.inner.size() > VaultsLib.MAX_MAP_NAME_BYTES) {
      return #Err("That name is too long.");
    };
    let mine = VaultsLib.ownedBy(vaults, msg.caller);
    if (mine.containsKey(Blob.compare, map_name.inner)) {
      return #Ok();
    };
    if (Map.size(mine) >= VaultsLib.MAX_CLAIMED_VAULTS_PER_OWNER) {
      return #Err("You have too many vaults.");
    };
    vaults.owned := vaults.owned.add(Principal.compare, msg.caller, mine.add(Blob.compare, map_name.inner, ()));
    #Ok();
  };

  /// Delete a vault: its contents, its events.log, its sharing and its name.
  ///
  /// **Atomic**, which is worth stating because the design in #21 assumed it
  /// could not be. That assumed the *client* would orchestrate it — wipe, then
  /// one `remove_user` per grantee — leaving a half-deleted vault if any call
  /// failed. Owning the endpoints makes it one update message, so it either all
  /// happens or none of it does, and there is no partial state for the UI to
  /// represent.
  ///
  /// **Owner only.** Revoking needs manage rights, so a `ReadWrite`
  /// collaborator can only empty a vault — which is why the UI keeps Empty and
  /// Delete as separate actions rather than one that quietly degrades.
  ///
  /// **Not cryptographic erasure.** A vault's key derives from
  /// `(owner, mapName)`, so re-creating one with the same name yields the same
  /// key and anyone holding old ciphertext can still read it. This removes data
  /// from the canister; it does not revoke the key. Vaults created through the
  /// app get a random name for exactly this reason (#13), which makes reuse
  /// effectively impossible — but the copy must not promise erasure.
  public shared (msg) func delete_vault(map_name : Shared.ByteBuf) : async Shared.Result<(), Text> {
    Cycles.watchdog(health);
    if (Principal.isAnonymous(msg.caller)) return #Err("unauthorized");
    let mapName = map_name.inner;
    let id = (msg.caller, mapName);

    // Ownership is identity-derived, so this is the whole check: a vault *is*
    // `(owner, mapName)` and the caller can only name their own.
    let mine = VaultsLib.ownedBy(vaults, msg.caller);
    let hasValues = switch (encryptedMaps.getEncryptedValuesForMap(msg.caller, id)) {
      case (#err(_)) { false };
      case (#ok(pairs)) { pairs.size() > 0 };
    };
    if (not mine.containsKey(Blob.compare, mapName) and not hasValues) {
      return #Err("no such vault");
    };

    // Revoke first. Doing it after the wipe would leave a window — inside this
    // message, so unobservable, but the order that reads correctly is the one
    // where nobody has access to a vault mid-teardown.
    switch (encryptedMaps.getSharedUserAccessForMap(msg.caller, id)) {
      case (#err(_)) {};
      case (#ok(entries)) {
        for ((user, _) in entries.values()) {
          if (Principal.compare(user, msg.caller) != #equal) {
            ignore encryptedMaps.removeUser(msg.caller, id, user);
          };
        };
      };
    };

    ignore encryptedMaps.removeMapValues(msg.caller, id);

    // Everything, not just the trash: nothing should survive a vault that is
    // gone, and events left behind would sit under a name no listing returns.
    let (next, _) = History.discardVault(events.log, msg.caller, mapName);
    events.log := next;

    let remaining = mine.remove(Blob.compare, mapName);
    vaults.owned := if (Map.isEmpty(remaining)) {
      vaults.owned.remove(Principal.compare, msg.caller);
    } else {
      vaults.owned.add(Principal.compare, msg.caller, remaining);
    };

    // The display name would otherwise outlive the vault and reappear on a
    // vault later created with the same name.
    let names = VaultsLib.namesOwnedBy(vaults, msg.caller).remove(Blob.compare, mapName);
    vaults.names := if (Map.isEmpty(names)) {
      vaults.names.remove(Principal.compare, msg.caller);
    } else {
      vaults.names.add(Principal.compare, msg.caller, names);
    };

    #Ok();
  };

  /// Every vault this caller owns, whether or not it holds anything.
  ///
  /// The registry read on its own, for a client that wants to know what it owns
  /// without inferring it from a listing that also carries shared vaults.
  public query (msg) func get_owned_vaults() : async [Shared.ByteBuf] {
    var out : [Shared.ByteBuf] = [];
    for ((mapName, _) in Map.entries(VaultsLib.ownedBy(vaults, msg.caller))) {
      out := Array.concat(out, [{ inner = mapName }]);
    };
    out;
  };

  /// Rename one of *your own* vaults, or clear the name by passing "".
  ///
  /// Owner-only by construction: the row is keyed on `msg.caller`, so there is
  /// no way to address someone else's vault. A collaborator renaming a shared
  /// vault for everyone would be a surprise, and this makes it unrepresentable
  /// rather than merely checked.
  public shared (msg) func set_vault_name(map_name : Shared.ByteBuf, display_name : Text) : async Shared.Result<(), Text> {
    Cycles.watchdog(health);
    // Nothing an anonymous caller stores can ever be read back — every row is
    // keyed on its author and only surfaces for them or for someone they shared
    // a vault with, and the anonymous principal owns no vaults. Refuse rather
    // than accumulate rows nobody can reach.
    if (Principal.isAnonymous(msg.caller)) {
      return #Err("Sign in to name a vault.");
    };

    let trimmed = Text.trim(display_name, #predicate(Char.isWhitespace));
    let mine = VaultsLib.namesOwnedBy(vaults, msg.caller);

    func store(names : Map.Map<Blob, Text>) {
      vaults.names := if (Map.isEmpty(names)) {
        vaults.names.remove(Principal.compare, msg.caller);
      } else {
        vaults.names.add(Principal.compare, msg.caller, names);
      };
    };

    // No clearing. It used to revert to the map name, which was reasonable while
    // that was something a user had chosen — but vaults are created with a
    // random id, so "reset" now renames the vault to `a3f1b2c4…`, which is
    // strictly worse than any name they could type. Removing the option is
    // simpler than explaining it.
    //
    // `vaultLabel`'s fallback to the map name stays, because a vault can still
    // be unnamed transiently: creating one is two calls, and a failure between
    // them leaves a vault whose label is its id until someone renames it.
    if (trimmed == "") {
      return #Err("A vault needs a name.");
    };

    // Trimmed rather than rejected, unlike map names. A surrounding space in a
    // *map* name addresses a different vault and so must never be silently
    // repaired; a display name carries no identity, so trimming is safe and
    // saves the user a pointless error.
    if (Text.encodeUtf8(trimmed).size() > VaultsLib.MAX_DISPLAY_NAME_BYTES) {
      return #Err("A vault name may be at most " # debug_show (VaultsLib.MAX_DISPLAY_NAME_BYTES) # " bytes.");
    };

    // Renaming a vault that already has a name replaces its row, so only a new
    // one counts against the cap.
    if (Map.size(mine) >= VaultsLib.MAX_NAMES_PER_OWNER and mine.get(Blob.compare, map_name.inner) == null) {
      return #Err("You have named the maximum of " # debug_show (VaultsLib.MAX_NAMES_PER_OWNER) # " vaults.");
    };

    // No two of this caller's vaults may *render* the same label.
    //
    // Not tidiness. `EmptyVaultDialog` and `DeleteVaultDialog` arm on the typed
    // label matching the vault's, and delete takes the values, their events.log,
    // the trash, the sharing and the registry entry in one irreversible call.
    // Two vaults labelled "Work" turn that confirmation into something the user
    // is deliberate about a *name* over, rather than a vault.
    //
    // Impossible before vaults could be created — an owner had exactly one — so
    // this arrives with the change that makes it reachable.
    //
    // Per owner, because cross-owner collision is already resolved on screen:
    // the sidebar splits owned from shared and tags the sharer. Exact match
    // after trimming, and deliberately neither case-insensitive nor
    // Unicode-normalised — `Work` and `work` are visually distinct, and
    // refusing a name for a difference the user cannot see is its own problem.
    if (VaultsLib.labelTaken(vaults, msg.caller, map_name.inner, trimmed)) {
      return #Err("You already have a vault called \"" # trimmed # "\".");
    };

    store(mine.add(Blob.compare, map_name.inner, trimmed));
    #Ok();
  };

  /// Display names for every vault the caller can see, owned and shared.
  ///
  /// One query and **zero key derivations** — the hard requirement. The sidebar
  /// must render names without opening a vault, or lazy loading is undone. Rows
  /// for vaults the caller cannot see are never returned, so a stray row is
  /// invisible as well as harmless.
  public query (msg) func get_vault_names() : async [Types.VaultName] {
    let found = List.empty<Types.VaultName>();

    // Your own rows, straight from the store.
    //
    // Deliberately *not* filtered against the library's map enumeration.
    // `get_owned_non_empty_map_names` omits an empty owned map (upstream
    // dfinity/vetkeys#439), and filtering through it meant a renamed *empty*
    // vault reported no name at all — a rename that silently did nothing, on
    // precisely the vault a new user has. A row for a map that does not exist
    // is harmless: the client joins these against the vault listing, so it
    // simply never matches.
    //
    for ((name, displayName) in Map.entries(VaultsLib.namesOwnedBy(vaults, msg.caller))) {
      List.add(found, { owner = msg.caller; map_name = { inner = name }; display_name = displayName });
    };

    // Rows for vaults shared with you, so collaborators see the same name the
    // owner does. Listed from the access control list, which carries no such
    // emptiness condition.
    for ((owner, name) in encryptedMaps.getAccessibleSharedMapNames(msg.caller).values()) {
      switch (VaultsLib.namesOwnedBy(vaults, owner).get(Blob.compare, name)) {
        case (null) {};
        case (?displayName) {
          List.add(found, { owner; map_name = { inner = name }; display_name = displayName });
        };
      };
    };

    List.toArray(found);
  };

  public query (msg) func get_vault_summaries() : async [Types.VaultSummary] {
    let at = Recording.now();
    let listed = Array.map<EncryptedMaps.EncryptedMapData<VetKeys.AccessRights>, Types.VaultSummary>(
      encryptedMaps.getAllAccessibleEncryptedMaps(msg.caller),
      func(map) {
        // Sorted so `item_keys` does not depend on the store's iteration
        // order. `Digest.ofKeyvals` sorts independently, so it stays a pure
        // function of the pairs and is testable without a canister.
        let sorted = Array.sort<(Blob, Blob)>(map.keyvals, func(a, b) { Blob.compare(a.0, b.0) });
        // Liveness from the keys already in hand, so the poll costs no extra
        // read to work out what is in the trash.
        let isLive = Recording.livenessOf(Array.map<(Blob, Blob), Blob>(map.keyvals, func((key, _)) { key }));
        let inTrash = if (Access.canRead(encryptedMaps, msg.caller, map.map_owner, map.map_name)) {
          History.trash(events.log, map.map_owner, map.map_name, isLive, at);
        } else { [] };
        {
          owner = map.map_owner;
          map_name = { inner = map.map_name };
          access_control = map.access_control;
          item_keys = Array.map<(Blob, Blob), Shared.ByteBuf>(sorted, func((key, _)) { { inner = key } });
          digest = { inner = Digest.ofKeyvals(map.keyvals) };
          trashed = inTrash.size();
          my_rights = Access.rightsOf(encryptedMapsState, msg.caller, map.map_owner, map.map_name);
          trash_digest = { inner = Recording.trashDigest(inTrash) };
        };
      },
    );
    Array.concat(listed, ownedVaultsNotListed(msg.caller, listed, at));
  };
};
