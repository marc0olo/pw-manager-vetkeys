import EncryptedMapsControlPlaneCanister "mo:ic-vetkeys/encrypted_maps/ControlPlaneCanister";
import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Runtime "mo:core/Runtime";
import Map "mo:core/pure/Map";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Char "mo:core/Char";
import List "mo:core/List";
import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Sha256 "mo:sha2/Sha256";

// The whole vault backend (persistent by default via --default-persistent-actors). Every secret is encrypted in the browser under a
// vetKey; this canister only ever sees ciphertext and enforces who may read or
// write which vault.
actor PasswordManager {
  // `transient`: the key name is baked into `encryptedMapsState` at install and
  // never re-read. Local networks provision `test_key_1`; set VETKD_KEY_NAME
  // explicitly for mainnet.
  transient let keyName = Runtime.envVar<system>("VETKD_KEY_NAME") ?? "test_key_1";

  // The domain separator isolates this app's derived keys. Like the key name it
  // must stay stable for the life of the canister — changing either makes every
  // stored secret undecryptable.
  let encryptedMapsState = EncryptedMaps.newEncryptedMapsState<Types.AccessRights>(
    { curve = #bls12_381_g2; name = keyName },
    "pw_manager_vetkeys",
  );

  // The control-plane mixin: vetKD key derivation, access control and map-name
  // enumeration, but *not* the value endpoints. Those are below.
  //
  // The full `EncryptedMapsCanister` mixin contributes them, and would be a
  // couple of lines — but a mixin's methods cannot be wrapped, so owning them
  // is the only way to keep app state moving with value writes. The
  // `encrypted-maps` skill is explicit that exposing both the library's value
  // mutators and our own desynchronises the two stores, which is why this is
  // an either/or rather than an addition.
  //
  // Nothing about the interface changes: each endpoint below delegates to the
  // same `encryptedMaps.*` call the mixin made, with the same signature, so
  // `DefaultEncryptedMapsClient` cannot tell the difference. `npm run
  // check-bindings` is what holds that claim to account — a drifted signature
  // shows up as a diff in the generated Candid.
  include EncryptedMapsControlPlaneCanister(encryptedMapsState);

  // ---------------------------------------------------------------------------
  // Value endpoints, taken over from the mixin
  //
  // Pure delegations for now. Trash (#8) hangs off `remove_encrypted_value` and
  // `remove_map_values`; the audit log hangs off all three mutators. Kept as a
  // separate, behaviour-free step so that if something breaks, it is obvious
  // which change did it.
  // ---------------------------------------------------------------------------

  public type EncryptedMapData = {
    map_owner : Principal;
    map_name : ByteBuf;
    keyvals : [(ByteBuf, ByteBuf)];
    access_control : [(Principal, Types.AccessRights)];
  };

  // Written as the mixin writes it, with the mapping inline.
  //
  // A named helper declared `... : (ByteBuf, ByteBuf)` cannot be passed to
  // `Array.map`, and the reason is the *return* type rather than the parameter:
  //
  //     expression of type   ((Blob, Blob)) -> (ByteBuf, ByteBuf)
  //     cannot produce type  ((Blob, Blob)) -> ((ByteBuf, ByteBuf))
  //
  // Motoko reads `-> (A, B)` as returning two values, where `Array.map` wants
  // one value that is a tuple. Writing the return type as `((ByteBuf, ByteBuf))`
  // does compile — verified — but a stray pair of parentheses carrying that much
  // meaning is the kind of thing a later tidy-up removes, so the lambda stays.
  func bufs(pairs : [(Blob, Blob)]) : [(ByteBuf, ByteBuf)] {
    Array.map<(Blob, Blob), (ByteBuf, ByteBuf)>(
      pairs,
      func((a, b) : (Blob, Blob)) { ({ inner = a }, { inner = b }) },
    );
  };

  public query (msg) func get_encrypted_values_for_map(
    map_owner : Principal,
    map_name : ByteBuf,
  ) : async Result<[(ByteBuf, ByteBuf)], Text> {
    switch (encryptedMaps.getEncryptedValuesForMap(msg.caller, (map_owner, map_name.inner))) {
      case (#err(e)) { #Err(e) };
      case (#ok(values)) { #Ok(bufs(values)) };
    };
  };

  public query (msg) func get_all_accessible_encrypted_values() : async [((Principal, ByteBuf), [(ByteBuf, ByteBuf)])] {
    Array.map<((Principal, Blob), [(Blob, Blob)]), ((Principal, ByteBuf), [(ByteBuf, ByteBuf)])>(
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

  public query (msg) func get_encrypted_value(
    map_owner : Principal,
    map_name : ByteBuf,
    map_key : ByteBuf,
  ) : async Result<?ByteBuf, Text> {
    switch (encryptedMaps.getEncryptedValue(msg.caller, (map_owner, map_name.inner), map_key.inner)) {
      case (#err(e)) { #Err(e) };
      case (#ok(null)) { #Ok(null) };
      case (#ok(?blob)) { #Ok(?{ inner = blob }) };
    };
  };

  public shared (msg) func insert_encrypted_value(
    map_owner : Principal,
    map_name : ByteBuf,
    map_key : ByteBuf,
    value : ByteBuf,
  ) : async Result<?ByteBuf, Text> {
    switch (encryptedMaps.insertEncryptedValue(msg.caller, (map_owner, map_name.inner), map_key.inner, value.inner)) {
      case (#err(e)) { #Err(e) };
      case (#ok(null)) { #Ok(null) };
      case (#ok(?blob)) { #Ok(?{ inner = blob }) };
    };
  };

  public shared (msg) func remove_encrypted_value(
    map_owner : Principal,
    map_name : ByteBuf,
    map_key : ByteBuf,
  ) : async Result<?ByteBuf, Text> {
    switch (encryptedMaps.removeEncryptedValue(msg.caller, (map_owner, map_name.inner), map_key.inner)) {
      case (#err(e)) { #Err(e) };
      case (#ok(null)) { #Ok(null) };
      case (#ok(?blob)) { #Ok(?{ inner = blob }) };
    };
  };

  public shared (msg) func remove_map_values(
    map_owner : Principal,
    map_name : ByteBuf,
  ) : async Result<[ByteBuf], Text> {
    switch (encryptedMaps.removeMapValues(msg.caller, (map_owner, map_name.inner))) {
      case (#err(e)) { #Err(e) };
      case (#ok(values)) { #Ok(Array.map<Blob, ByteBuf>(values, func(b : Blob) : ByteBuf { { inner = b } })) };
    };
  };

  // ---------------------------------------------------------------------------
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
  // ---------------------------------------------------------------------------

  /// Bounds a single row. Display names are not key material, so this is about
  /// storage rather than correctness — but unbounded text from any caller is
  /// not something to leave open.
  transient let MAX_DISPLAY_NAME_BYTES = 64;

  /// Bounds how many rows one principal can occupy. Row *size* was bounded from
  /// the start and row *count* was not, which left an open-ended write for any
  /// caller. Generous enough that no real user meets it.
  transient let MAX_NAMES_PER_OWNER = 100;

  /// `owner -> mapName -> display name`. Absent means "show the map name", so
  /// nothing needs migrating or backfilling.
  ///
  /// Keyed by owner rather than by the `(owner, mapName)` pair, because the
  /// primary read is "every name *I* own" and that runs on the poll path. The
  /// pair-keyed form made it O(rows across all users) per poll.
  var vaultNames : Map.Map<Principal, Map.Map<Blob, Text>> = Map.empty<Principal, Map.Map<Blob, Text>>();

  func namesOwnedBy(owner : Principal) : Map.Map<Blob, Text> {
    switch (vaultNames.get(Principal.compare, owner)) {
      case (null) { Map.empty<Blob, Text>() };
      case (?names) { names };
    };
  };

  public type VaultName = {
    owner : Principal;
    map_name : ByteBuf;
    display_name : Text;
  };

  /// Rename one of *your own* vaults, or clear the name by passing "".
  ///
  /// Owner-only by construction: the row is keyed on `msg.caller`, so there is
  /// no way to address someone else's vault. A collaborator renaming a shared
  /// vault for everyone would be a surprise, and this makes it unrepresentable
  /// rather than merely checked.
  public shared (msg) func set_vault_name(map_name : ByteBuf, display_name : Text) : async Result<(), Text> {
    // Nothing an anonymous caller stores can ever be read back — every row is
    // keyed on its author and only surfaces for them or for someone they shared
    // a vault with, and the anonymous principal owns no vaults. Refuse rather
    // than accumulate rows nobody can reach.
    if (Principal.isAnonymous(msg.caller)) {
      return #Err("Sign in to name a vault.");
    };

    let trimmed = Text.trim(display_name, #predicate(Char.isWhitespace));
    let mine = namesOwnedBy(msg.caller);

    func store(names : Map.Map<Blob, Text>) {
      vaultNames := if (Map.isEmpty(names)) {
        vaultNames.remove(Principal.compare, msg.caller);
      } else {
        vaultNames.add(Principal.compare, msg.caller, names);
      };
    };

    // Clearing reverts to the map name, which is the same thing "unset" means.
    if (trimmed == "") {
      store(mine.remove(Blob.compare, map_name.inner));
      return #Ok();
    };

    // Trimmed rather than rejected, unlike map names. A surrounding space in a
    // *map* name addresses a different vault and so must never be silently
    // repaired; a display name carries no identity, so trimming is safe and
    // saves the user a pointless error.
    if (Text.encodeUtf8(trimmed).size() > MAX_DISPLAY_NAME_BYTES) {
      return #Err("A vault name may be at most " # debug_show (MAX_DISPLAY_NAME_BYTES) # " bytes.");
    };

    // Renaming a vault that already has a name replaces its row, so only a new
    // one counts against the cap.
    if (Map.size(mine) >= MAX_NAMES_PER_OWNER and mine.get(Blob.compare, map_name.inner) == null) {
      return #Err("You have named the maximum of " # debug_show (MAX_NAMES_PER_OWNER) # " vaults.");
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
  public query (msg) func get_vault_names() : async [VaultName] {
    let found = List.empty<VaultName>();

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
    for ((name, displayName) in Map.entries(namesOwnedBy(msg.caller))) {
      List.add(found, { owner = msg.caller; map_name = { inner = name }; display_name = displayName });
    };

    // Rows for vaults shared with you, so collaborators see the same name the
    // owner does. Listed from the access control list, which carries no such
    // emptiness condition.
    for ((owner, name) in encryptedMaps.getAccessibleSharedMapNames(msg.caller).values()) {
      switch (namesOwnedBy(owner).get(Blob.compare, name)) {
        case (null) {};
        case (?displayName) {
          List.add(found, { owner; map_name = { inner = name }; display_name = displayName });
        };
      };
    };

    List.toArray(found);
  };

  // ---------------------------------------------------------------------------
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
  // ---------------------------------------------------------------------------

  public type VaultSummary = {
    owner : Principal;
    map_name : ByteBuf;
    access_control : [(Principal, Types.AccessRights)];
    item_keys : [ByteBuf];
    /// SHA-256 over the vault's contents. Changes iff the contents change.
    digest : ByteBuf;
  };

  /// Length-prefix each blob before hashing it.
  ///
  /// Without this, `(key "aab", value "c")` and `(key "aa", value "bc")` hash
  /// identically — and a caller with write access chooses both, so an edit
  /// could be made to leave the digest unchanged and stay invisible to everyone
  /// else's poll. Framing the lengths makes the encoding injective.
  func writeFramed(digest : Sha256.Digest, blob : Blob) {
    let size = Nat.toNat64(blob.size());
    digest.writeArray(
      Array.tabulate<Nat8>(8, func(i) { Nat.toNat8(Nat64.toNat((size >> Nat.toNat64(8 * (7 - i))) & 0xFF)) })
    );
    digest.writeBlob(blob);
  };

  public query (msg) func get_vault_summaries() : async [VaultSummary] {
    Array.map<EncryptedMaps.EncryptedMapData<Types.AccessRights>, VaultSummary>(
      encryptedMaps.getAllAccessibleEncryptedMaps(msg.caller),
      func(map) {
        // Sorted so the digest does not depend on the store's iteration order.
        let sorted = Array.sort<(Blob, Blob)>(
          map.keyvals,
          func(a, b) { Blob.compare(a.0, b.0) },
        );
        let digest = Sha256.new();
        for ((key, value) in sorted.values()) {
          writeFramed(digest, key);
          writeFramed(digest, value);
        };
        {
          owner = map.map_owner;
          map_name = { inner = map.map_name };
          access_control = map.access_control;
          item_keys = Array.map<(Blob, Blob), ByteBuf>(sorted, func((key, _)) { { inner = key } });
          digest = { inner = digest.sum() };
        };
      },
    );
  };
};
