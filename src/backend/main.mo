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
import Digest "lib/Digest";
import History "lib/History";
import Time "mo:core/Time";
import Nat64 "mo:core/Nat64";

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
      // Nothing was superseded, so there is no version to keep — but the write
      // itself is worth recording. Otherwise a secret nobody has edited has no
      // canister-side timestamp or author, and the only "updated" a client
      // could show is the one written *inside* the plaintext by whoever saved
      // it, which is the writer's to choose.
      case (#ok(null)) {
        registerVault(map_owner, map_name.inner);
        record(
          msg.caller,
          map_owner,
          map_name.inner,
          [(map_key.inner, null, #Created)],
          liveness(msg.caller, map_owner, map_name.inner),
        );
        #Ok(null);
      };
      case (#ok(?blob)) {
        // Registered here too, not only on a first write: a map that predates
        // the registry has no entry, and an ordinary edit is the cheapest place
        // to acquire one.
        registerVault(map_owner, map_name.inner);
        // The value this write replaced. Recording it here is the whole of
        // version history: without it an edit destroys the previous secret,
        // which trash never covered because trash only sees deletions.
        record(
          msg.caller,
          map_owner,
          map_name.inner,
          [(map_key.inner, ?blob, #Edited)],
          liveness(msg.caller, map_owner, map_name.inner),
        );
        #Ok(?{ inner = blob });
      };
    };
  };

  public shared (msg) func remove_encrypted_value(
    map_owner : Principal,
    map_name : ByteBuf,
    map_key : ByteBuf,
  ) : async Result<?ByteBuf, Text> {
    // The library call first: it performs the access check, and hands back the
    // value it removed. Only then is our store touched, so a caller without
    // rights leaves no trace.
    switch (encryptedMaps.removeEncryptedValue(msg.caller, (map_owner, map_name.inner), map_key.inner)) {
      case (#err(e)) { #Err(e) };
      case (#ok(null)) { #Ok(null) };
      case (#ok(?blob)) {
        record(
          msg.caller,
          map_owner,
          map_name.inner,
          [(map_key.inner, ?blob, #Deleted)],
          liveness(msg.caller, map_owner, map_name.inner),
        );
        #Ok(?{ inner = blob });
      };
    };
  };

  public shared (msg) func remove_map_values(
    map_owner : Principal,
    map_name : ByteBuf,
  ) : async Result<[ByteBuf], Text> {
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
        record(
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
        #Ok(Array.map<Blob, ByteBuf>(keys, func(b : Blob) : ByteBuf { { inner = b } }));
      };
    };
  };

  /// The caller's own rights on a vault, or null if they have none.
  ///
  /// Surfaced on {@link VaultSummary} rather than as its own endpoint, so the
  /// client learns it from the listing it already polls.
  ///
  /// The library will not answer this: `get_user_rights` requires
  /// `ReadWriteManage`, and the vault listing flattens the refusal to an empty
  /// access-control list, so a `Read` or `ReadWrite` grantee cannot discover
  /// what they are allowed to do (upstream dfinity/vetkeys#438).
  ///
  /// The client's workaround was to offer every control and withdraw the ones
  /// the canister refused — which meant a read-only collaborator was shown
  /// "Delete" and "Empty vault" until they tried one. Correct, since the
  /// canister remains the authority, but it asks the user to discover their
  /// own permissions by bumping into them.
  ///
  /// We can answer it because we hold the state the library reads: the ACL is a
  /// plain field of `KeyManagerState`. Telling callers their *own* rights
  /// discloses nothing about anyone else, which is the whole of #438's request.
  func rightsOf(caller : Principal, map_owner : Principal, mapName : Blob) : ?Types.AccessRights {
    // Ownership is identity-derived rather than an ACL entry, so it is not in
    // the map to look up.
    if (Principal.compare(caller, map_owner) == #equal) return ?(#ReadWriteManage);

    switch (encryptedMapsState.keyManager.accessControl.get(caller)) {
      case (null) { null };
      case (?entries) {
        for (((owner, name), rights) in entries.values()) {
          if (Principal.compare(owner, map_owner) == #equal and Blob.compare(name, mapName) == #equal) {
            return ?rights;
          };
        };
        null;
      };
    };
  };

  // ---------------------------------------------------------------------------
  // Trash
  //
  // A deleted item moves here rather than vanishing, and can be restored for 90
  // days. The move keeps the map key **unchanged**, which is what makes it
  // cheap: the map key is the domain separator the item's AES key derives from,
  // so a restored value decrypts under exactly the key material it always did.
  // Nothing is re-encrypted and no client is involved.
  //
  // Expiry is enforced on read (see lib/Trash), so an expired entry is
  // unreachable whether or not anything has purged it.
  // ---------------------------------------------------------------------------

  var history : History.Store = History.empty();

  /// Orders events. Canister-wide rather than per secret, so the audit log can
  /// be read across vaults in the order things actually happened.
  var nextSeq : Nat64 = 0;

  func now() : Nat64 = Nat64.fromIntWrap(Time.now());

  /// Which map keys currently hold a value, as a predicate.
  ///
  /// Liveness is the mixin's state and the library's key comparator is private,
  /// so this goes through the public read API. Every caller here has already
  /// passed an access check; a refusal yields "nothing is live", which only ever
  /// makes the trash view larger, never a disclosure.
  func liveness(caller : Principal, owner : Principal, mapName : Blob) : Blob -> Bool {
    let live = switch (encryptedMaps.getEncryptedValuesForMap(caller, (owner, mapName))) {
      case (#err(_)) { [] };
      case (#ok(pairs)) { Array.map<(Blob, Blob), Blob>(pairs, func((key, _)) { key }) };
    };
    func(mapKey : Blob) : Bool {
      for (k in live.values()) { if (Blob.compare(k, mapKey) == #equal) return true };
      false;
    };
  };

  /// The same predicate from a list of keys already in hand, for the poll path
  /// where the listing has just produced them.
  func livenessOf(keys : [Blob]) : Blob -> Bool {
    func(mapKey : Blob) : Bool {
      for (k in keys.values()) { if (Blob.compare(k, mapKey) == #equal) return true };
      false;
    };
  };

  /// Append events, then reclaim this vault's expired groups.
  ///
  /// Reclamation is a side errand, not the guarantee: the read paths filter by
  /// age, so an expired group is unreachable whether or not this has run. What
  /// it costs to skip is bytes on disk for a vault nobody writes to.
  func record(
    by : Principal,
    owner : Principal,
    mapName : Blob,
    events : [(Blob, ?Blob, History.Kind)],
    isLive : Blob -> Bool,
  ) {
    let at = now();
    var next = history;
    for ((mapKey, value, kind) in events.values()) {
      next := History.append(next, (owner, mapName, mapKey, nextSeq), { value; at; by; kind });
      nextSeq += 1;
    };
    history := History.purge(next, owner, mapName, isLive, at);
  };

  /// Whether the caller may read this vault, which is the whole of the trash
  /// authorization: trash is a property of the vault, so anyone who can read
  /// the vault can read what has been deleted from it.
  ///
  /// Asked on every trash read rather than recorded when the entry was made, so
  /// revocation takes effect immediately — a collaborator who deleted an item
  /// and was later removed keeps no window onto the vault through its trash.
  func canRead(who : Principal, owner : Principal, mapName : Blob) : Bool {
    if (Principal.compare(who, owner) == #equal) return true;
    for ((sharedOwner, sharedName) in encryptedMaps.getAccessibleSharedMapNames(who).values()) {
      if (Principal.compare(sharedOwner, owner) == #equal and Blob.compare(sharedName, mapName) == #equal) {
        return true;
      };
    };
    false;
  };

  public type TrashedItem = {
    /// Which event this row is, and what `restore_version` takes.
    ///
    /// The map key is not an identity here: a secret can be deleted, restored
    /// and deleted again, so several events share it. Addressing a restore by
    /// map key would be ambiguous the moment that happens.
    seq : Nat64;
    map_key : ByteBuf;
    /// The ciphertext, so the client can show what an item actually was.
    ///
    /// #14 removed values from the *poll* — automatic, every 15 s, every
    /// accessible vault. This is none of those: user-initiated, one vault, off
    /// the poll path. That is the same profile as opening a vault, which
    /// returns every value in it, and trash is a subset of one vault. The rule
    /// #14 established is that values never ride the poll, not that they never
    /// cross the wire.
    ///
    /// Costs the client nothing extra to read: the value was never
    /// re-encrypted, so the key material cached from opening the vault
    /// decrypts it.
    value : ByteBuf;
    deleted_at : Nat64;
    deleted_by : Principal;
  };

  /// What is recoverable in one vault, with each item's ciphertext so a client
  /// can show what it was rather than only when it went. See `TrashedItem` for
  /// why returning values here is not the thing #14 removed from the poll.
  ///
  /// Visible to everyone who can read the vault. What that changes differs by
  /// access level, and the difference is worth stating precisely.
  ///
  /// For a member who can **write**, nothing new is disclosed:
  /// `restore_trashed_values` puts back every entry in the vault on write
  /// access alone, so they could already recover an entry withheld from the
  /// listing and then read it. Listing less than the restore path recovers
  /// hides entries without keeping them out of reach.
  ///
  /// For a `Read` member it **is** a new disclosure. They hold the vault key,
  /// so the ciphertext returned here decrypts, and one added after a deletion
  /// can read a secret destroyed before they had any access — which no path
  /// reached before. Accepted deliberately, not incidentally: trash belongs to
  /// the vault, the share dialog says how many entries a grantee would
  /// inherit, and `discard_trash` is the remedy.
  ///
  /// The alternative was to filter the restore path by the same predicate,
  /// making owner-or-deleter real rather than cosmetic — one line, since
  /// `restore_trashed_values` has the entry in hand. Rejected because it turns
  /// `deletedBy` into authorization data rather than display, and because it
  /// denies a team the case a shared vault exists for: recovering what a
  /// colleague who has since left deleted.
  public query (msg) func get_trash(map_owner : Principal, map_name : ByteBuf) : async Result<[TrashedItem], Text> {
    if (not canRead(msg.caller, map_owner, map_name.inner)) return #Err("unauthorized");
    #Ok(
      Array.filterMap<(Blob, Nat64, History.Entry), TrashedItem>(
        History.trash(history, map_owner, map_name.inner, liveness(msg.caller, map_owner, map_name.inner), now()),
        func((mapKey, seq, entry)) {
          // `History.trash` only yields value-carrying rows, so this cannot be
          // null. Matched rather than asserted: a trap here would take down a
          // query the whole sidebar depends on.
          switch (entry.value) {
            case (null) { null };
            case (?value) {
              ?{
                seq;
                map_key = { inner = mapKey };
                value = { inner = value };
                deleted_at = entry.at;
                deleted_by = entry.by;
              };
            };
          };
        },
      )
    );
  };

  public type VersionKind = { #Created; #Edited; #Deleted; #Restored };

  public type Version = {
    seq : Nat64;
    /// The value this event superseded. Absent for a restore, which superseded
    /// nothing, and for a version whose ciphertext the owner has dropped —
    /// the event is still here, which is the point of dropping rather than
    /// deleting.
    value : ?ByteBuf;
    at : Nat64;
    by : Principal;
    kind : VersionKind;
  };

  /// Every recorded version of one secret, oldest first.
  ///
  /// Visible to everyone who can read the vault, on the same reasoning as
  /// `get_trash`: a reader can already read the current value, so earlier
  /// values of the same secret are not a wider class of information. It does
  /// mean a member added later sees versions written before they arrived —
  /// deliberate, and `drop_history` is the owner's remedy.
  ///
  /// Not on the poll. Values ride this because it is user-initiated and scoped
  /// to one secret; #14's rule is that nothing automatic carries ciphertext.
  public query (msg) func get_history(
    map_owner : Principal,
    map_name : ByteBuf,
    map_key : ByteBuf,
  ) : async Result<[Version], Text> {
    if (not canRead(msg.caller, map_owner, map_name.inner)) return #Err("unauthorized");
    let isLive = liveness(msg.caller, map_owner, map_name.inner);
    let rows = History.forKey(history, map_owner, map_name.inner, map_key.inner);
    // A deleted secret's history expires with it, all at once — so an expired
    // group answers empty rather than leaking what it used to hold.
    if (History.groupExpired(rows, isLive(map_key.inner), now())) return #Ok([]);
    #Ok(
      Array.map<(Nat64, History.Entry), Version>(
        Array.sort<(Nat64, History.Entry)>(rows, func(a, b) { Nat64.compare(a.0, b.0) }),
        func((seq, entry)) {
          {
            seq;
            value = switch (entry.value) { case (null) { null }; case (?v) { ?{ inner = v } } };
            at = entry.at;
            by = entry.by;
            kind = entry.kind;
          };
        },
      )
    );
  };

  /// Put one version back, addressed by its event.
  ///
  /// Any version, not only a deleted one: restoring over a live secret
  /// supersedes it, which is an edit, so the value being replaced is kept like
  /// any other. That is why this is not called `restore_trashed_value` — the
  /// trash is one view of the log, and this operates on the log.
  ///
  /// Authorization is the library's: this is an insert, so a caller without
  /// write rights is refused there and nothing is recorded.
  ///
  /// Removes nothing. The row stays, and the secret leaves the trash because it
  /// has a live value again — which is what keeps a writer unable to destroy
  /// anything, and what lets a recovered secret keep its history.
  public shared (msg) func restore_version(
    map_owner : Principal,
    map_name : ByteBuf,
    seq : Nat64,
  ) : async Result<(), Text> {
    let at = now();
    // The map key is part of the event key, so the row has to be found by
    // scanning this vault's events rather than by direct lookup. One vault's
    // log, on a user-initiated call.
    let isLive = liveness(msg.caller, map_owner, map_name.inner);
    var found : ?(Blob, History.Entry) = null;
    for (mapKey in History.keysIn(history, map_owner, map_name.inner).values()) {
      for ((rowSeq, entry) in History.forKey(history, map_owner, map_name.inner, mapKey).values()) {
        if (rowSeq == seq) { found := ?(mapKey, entry) };
      };
    };
    switch (found) {
      case (null) { #Err("no such version") };
      case (?(mapKey, entry)) {
        let rows = History.forKey(history, map_owner, map_name.inner, mapKey);
        if (History.groupExpired(rows, isLive(mapKey), at)) return #Err("no such version");
        switch (entry.value) {
          case (null) { #Err("this version's value was dropped") };
          case (?value) {
            switch (encryptedMaps.insertEncryptedValue(msg.caller, (map_owner, map_name.inner), mapKey, value)) {
              case (#err(e)) { #Err(e) };
              case (#ok(superseded)) {
                // Restoring over a live value supersedes it, so that is an
                // edit and the replaced version is kept. Restoring into an
                // empty key supersedes nothing, and the event carries no value.
                let kind = switch (superseded) { case (null) { #Restored }; case (?_) { #Edited } };
                record(msg.caller, map_owner, map_name.inner, [(mapKey, superseded, kind)], isLive);
                #Ok();
              };
            };
          };
        };
      };
    };
  };

  public type ItemSummary = {
    map_key : ByteBuf;
    /// Restorable versions: value-carrying events only. A `#Created` marker and
    /// a version the owner has pruned are both on the record, but neither is
    /// something a client can offer to put back.
    versions : Nat;
    /// When the canister recorded the write that produced the current value.
    ///
    /// The newest event's timestamp, which is exactly that: an event stores the
    /// value it *replaced*, so the newest one is stamped when the replacement
    /// landed. For a secret nobody has edited it is the `#Created` event.
    ///
    /// Authoritative in the way the item's own `updatedAt` is not — that field
    /// lives inside the plaintext and is set by whoever last saved it, so it is
    /// the writer's to choose.
    updated_at : Nat64;
  };

  /// Per-item history facts for one vault: how much is restorable, and when the
  /// current value was actually written.
  ///
  /// A separate query rather than fields on `get_vault_summaries`, which runs
  /// every 15 s: #14 got the poll down to a digest and a key list, and two
  /// numbers per item would grow it with the vault. This is read once when a
  /// vault is opened, alongside the values themselves.
  ///
  /// No ciphertext, so it costs no key derivation.
  public query (msg) func get_item_summaries(
    map_owner : Principal,
    map_name : ByteBuf,
  ) : async Result<[ItemSummary], Text> {
    if (not canRead(msg.caller, map_owner, map_name.inner)) return #Err("unauthorized");
    let isLive = liveness(msg.caller, map_owner, map_name.inner);
    let at = now();
    var out : [ItemSummary] = [];
    for (mapKey in History.keysIn(history, map_owner, map_name.inner).values()) {
      let rows = History.forKey(history, map_owner, map_name.inner, mapKey);
      if (not History.groupExpired(rows, isLive(mapKey), at)) {
        var versions = 0;
        var newestSeq : Nat64 = 0;
        var updatedAt : Nat64 = 0;
        for ((seq, entry) in rows.values()) {
          if (entry.value != null) { versions += 1 };
          if (updatedAt == 0 or seq > newestSeq) { newestSeq := seq; updatedAt := entry.at };
        };
        out := Array.concat(out, [{ map_key = { inner = mapKey }; versions; updated_at = updatedAt }]);
      };
    };
    #Ok(out);
  };

  /// Put a whole vault's trash back, for undoing a wipe without one call per
  /// item.
  ///
  /// Authorization is the library's, per insert, so write access is what this
  /// needs and a reader is refused on the first entry. It restores every
  /// entry the trash lists rather than only the caller's own, which is why
  /// `get_trash` lists the same set — see its comment.
  ///
  /// Restores the **newest** version of each deleted secret. A vault can hold
  /// several events for one map key, and replaying them all would mean each
  /// insert overwriting the last — silent loss inside a recovery operation.
  /// `History.trash` already yields one row per key, which is that row.
  public shared (msg) func restore_trashed_values(map_owner : Principal, map_name : ByteBuf) : async Result<Nat, Text> {
    let at = now();
    let isLive = liveness(msg.caller, map_owner, map_name.inner);
    var restored = 0;
    var events : [(Blob, ?Blob, History.Kind)] = [];
    for ((mapKey, _, entry) in History.trash(history, map_owner, map_name.inner, isLive, at).values()) {
      switch (entry.value) {
        case (null) {};
        case (?value) {
          switch (encryptedMaps.insertEncryptedValue(msg.caller, (map_owner, map_name.inner), mapKey, value)) {
            case (#err(e)) { return #Err(e) };
            case (#ok(superseded)) {
              let kind = switch (superseded) { case (null) { #Restored }; case (?_) { #Edited } };
              events := Array.concat(events, [(mapKey, superseded, kind)]);
              restored += 1;
            };
          };
        };
      };
    };
    record(msg.caller, map_owner, map_name.inner, events, isLive);
    #Ok(restored);
  };

  /// Make a vault's deletions unrecoverable now, rather than waiting out their
  /// 90 days.
  ///
  /// The counterpart to trash being vault-scoped: sharing a vault hands the
  /// grantee its trash too, so there has to be a way to take a secret out of
  /// reach *before* granting access. Without this the exposure would have no
  /// remedy but time.
  ///
  /// **Owner only.** The earlier rule was write access, on the reasoning that
  /// `ReadWrite` already destroys a vault's contents through
  /// `remove_map_values`. Trash made that false: a writer can empty a vault but
  /// no longer destroy it, so this is the only true destruction and gating it on
  /// write hands back the power trash removed. Measured — a collaborator could
  /// wipe a vault they did not own, discard its trash, and the vault then
  /// dropped out of the owner's listing.
  ///
  /// Scoped to secrets with no live value, so it empties the trash without
  /// touching the version history of secrets that are still there.
  public shared (msg) func discard_trash(map_owner : Principal, map_name : ByteBuf) : async Result<Nat, Text> {
    if (Principal.compare(msg.caller, map_owner) != #equal) return #Err("unauthorized");
    let (next, dropped) = History.discardTrash(
      history,
      map_owner,
      map_name.inner,
      liveness(msg.caller, map_owner, map_name.inner),
    );
    history := next;
    #Ok(dropped);
  };

  /// Drop the stored versions of one secret, keeping the secret itself.
  ///
  /// The owner's way to reclaim space, or to stop keeping a secret's earlier
  /// values, without a retention policy guessing on their behalf (#38).
  ///
  /// Clears the ciphertext and **keeps the events**, so "edited by X at T"
  /// survives. Otherwise pruning would be a way to launder the audit trail.
  ///
  /// Not restricted to live secrets. Applied to a deleted one it clears the
  /// version the trash was offering, and `get_trash` then skips the group —
  /// a group whose newest event carries no value has nothing to put back. So
  /// this doubles as "delete this one trashed secret for good", which is the
  /// per-secret counterpart to `discard_trash`. Owner-only for that reason:
  /// it is a destruction, not housekeeping.
  public shared (msg) func drop_history(
    map_owner : Principal,
    map_name : ByteBuf,
    map_key : ByteBuf,
  ) : async Result<Nat, Text> {
    if (Principal.compare(msg.caller, map_owner) != #equal) return #Err("unauthorized");
    let (next, cleared) = History.dropHistory(history, map_owner, map_name.inner, map_key.inner);
    history := next;
    #Ok(cleared);
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
  public shared (msg) func create_vault(map_name : ByteBuf) : async Result<(), Text> {
    if (Principal.isAnonymous(msg.caller)) {
      return #Err("Sign in to create a vault.");
    };
    if (map_name.inner.size() == 0) {
      return #Err("A vault needs a name.");
    };
    if (map_name.inner.size() > MAX_MAP_NAME_BYTES) {
      return #Err("That name is too long.");
    };
    let mine = vaultsOwnedBy(msg.caller);
    if (mine.containsKey(Blob.compare, map_name.inner)) {
      return #Ok();
    };
    if (Map.size(mine) >= MAX_CLAIMED_VAULTS_PER_OWNER) {
      return #Err("You have too many vaults.");
    };
    ownedVaults := ownedVaults.add(Principal.compare, msg.caller, mine.add(Blob.compare, map_name.inner, ()));
    #Ok();
  };

  /// Delete a vault: its contents, its history, its sharing and its name.
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
  public shared (msg) func delete_vault(map_name : ByteBuf) : async Result<(), Text> {
    if (Principal.isAnonymous(msg.caller)) return #Err("unauthorized");
    let mapName = map_name.inner;
    let id = (msg.caller, mapName);

    // Ownership is identity-derived, so this is the whole check: a vault *is*
    // `(owner, mapName)` and the caller can only name their own.
    let mine = vaultsOwnedBy(msg.caller);
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
    let (next, _) = History.discardVault(history, msg.caller, mapName);
    history := next;

    let remaining = mine.remove(Blob.compare, mapName);
    ownedVaults := if (Map.isEmpty(remaining)) {
      ownedVaults.remove(Principal.compare, msg.caller);
    } else {
      ownedVaults.add(Principal.compare, msg.caller, remaining);
    };

    // The display name would otherwise outlive the vault and reappear on a
    // vault later created with the same name.
    let names = namesOwnedBy(msg.caller).remove(Blob.compare, mapName);
    vaultNames := if (Map.isEmpty(names)) {
      vaultNames.remove(Principal.compare, msg.caller);
    } else {
      vaultNames.add(Principal.compare, msg.caller, names);
    };

    #Ok();
  };

  /// Every vault this caller owns, whether or not it holds anything.
  ///
  /// The registry read on its own, for a client that wants to know what it owns
  /// without inferring it from a listing that also carries shared vaults.
  public query (msg) func get_owned_vaults() : async [ByteBuf] {
    var out : [ByteBuf] = [];
    for ((mapName, _) in Map.entries(vaultsOwnedBy(msg.caller))) {
      out := Array.concat(out, [{ inner = mapName }]);
    };
    out;
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

  // ---------------------------------------------------------------------------
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
  // unreachable. There is no history-derived backfill, so this ships with a
  // reinstall — which makes that state unreachable rather than merely unlikely.
  //
  // App-owned state duplicating something the library should know, so upstream
  // #439 is still the better fix — for every adopter, and with no second source
  // of truth. This is the route that does not wait.
  // ---------------------------------------------------------------------------

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
  transient let MAX_CLAIMED_VAULTS_PER_OWNER = 100;

  /// Bounds a map name. The library caps a map *key* at 32 bytes; a map name
  /// has no cap of its own, and an unbounded name from any caller is the same
  /// open-ended write the display-name cap closed.
  transient let MAX_MAP_NAME_BYTES = 32;

  /// `owner -> mapName`. Keyed by owner because the read is "every vault *I*
  /// own" and it runs on the poll path.
  var ownedVaults : Map.Map<Principal, Map.Map<Blob, ()>> = Map.empty<Principal, Map.Map<Blob, ()>>();

  func vaultsOwnedBy(owner : Principal) : Map.Map<Blob, ()> {
    switch (ownedVaults.get(Principal.compare, owner)) {
      case (null) { Map.empty<Blob, ()>() };
      case (?mine) { mine };
    };
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
  /// registration is one that cannot refuse. See
  /// {@link MAX_CLAIMED_VAULTS_PER_OWNER} for why bounding it here bought
  /// nothing.
  func registerVault(owner : Principal, mapName : Blob) {
    let mine = vaultsOwnedBy(owner);
    if (mine.containsKey(Blob.compare, mapName)) return;
    ownedVaults := ownedVaults.add(Principal.compare, owner, mine.add(Blob.compare, mapName, ()));
  };

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
  func labelTaken(owner : Principal, mapName : Blob, wanted : Text) : Bool {
    let names = namesOwnedBy(owner);
    for ((otherName, display) in Map.entries(names)) {
      if (Blob.compare(otherName, mapName) != #equal and display == wanted) return true;
    };
    for ((otherName, _) in Map.entries(vaultsOwnedBy(owner))) {
      if (Blob.compare(otherName, mapName) != #equal and names.get(Blob.compare, otherName) == null) {
        // Unnamed, so it renders as its map name.
        switch (Text.decodeUtf8(otherName)) {
          case (?asText) { if (asText == wanted) return true };
          case (null) {};
        };
      };
    };
    false;
  };

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
    if (Text.encodeUtf8(trimmed).size() > MAX_DISPLAY_NAME_BYTES) {
      return #Err("A vault name may be at most " # debug_show (MAX_DISPLAY_NAME_BYTES) # " bytes.");
    };

    // Renaming a vault that already has a name replaces its row, so only a new
    // one counts against the cap.
    if (Map.size(mine) >= MAX_NAMES_PER_OWNER and mine.get(Blob.compare, map_name.inner) == null) {
      return #Err("You have named the maximum of " # debug_show (MAX_NAMES_PER_OWNER) # " vaults.");
    };

    // No two of this caller's vaults may *render* the same label.
    //
    // Not tidiness. `EmptyVaultDialog` and `DeleteVaultDialog` arm on the typed
    // label matching the vault's, and delete takes the values, their history,
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
    if (labelTaken(msg.caller, map_name.inner, trimmed)) {
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
    /// Recoverable deletions the caller may see. Lets the UI offer restoring
    /// without a second round trip, and without hinting at entries it may not.
    trashed : Nat;
    /// What *this caller* may do here. See `rightsOf` — the library will not
    /// answer this, so a grantee otherwise has to discover their permissions by
    /// being refused.
    my_rights : ?Types.AccessRights;
    /// Fingerprint of what the trash listing would return.
    ///
    /// `trashed` alone cannot drive an open dialog: restoring one item and
    /// deleting another leaves the count unchanged while the contents differ,
    /// so a second viewer would keep a stale list. #14's rule is that the poll
    /// carries no ciphertext, and this is how it stays true — the digest says
    /// whether to re-read, and only then does anything fetch values.
    trash_digest : ByteBuf;
  };

  /// Owned vaults the library's enumeration leaves out.
  ///
  /// The union half. An owned map disappears from
  /// `get_owned_non_empty_map_names` as soon as its last value goes, so
  /// without this an emptied vault takes its trash and its history out of reach
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
  func ownedVaultsNotListed(caller : Principal, listed : [VaultSummary], at : Nat64) : [VaultSummary] {
    let extra = List.empty<VaultSummary>();
    let seen = func(name : Blob) : Bool {
      for (summary in listed.values()) {
        if (Principal.compare(summary.owner, caller) == #equal and Blob.compare(summary.map_name.inner, name) == #equal) {
          return true;
        };
      };
      false;
    };
    for ((mapName, _) in Map.entries(vaultsOwnedBy(caller))) {
      if (not seen(mapName)) {
        // Absent from the library's listing means the map holds no values, so
        // nothing in it is live.
        let inTrash = History.trash(history, caller, mapName, func(_ : Blob) : Bool { false }, at);
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
            my_rights = rightsOf(caller, caller, mapName);
            trash_digest = { inner = trashDigest(inTrash) };
          },
        );
      };
    };
    List.toArray(extra);
  };

  /// Fingerprint of a trash listing, for the poll.
  func trashDigest(rows : [(Blob, Nat64, History.Entry)]) : Blob {
    Digest.ofTrash(Array.map<(Blob, Nat64, History.Entry), (Blob, Nat64)>(rows, func((mapKey, seq, _)) { (mapKey, seq) }));
  };

  public query (msg) func get_vault_summaries() : async [VaultSummary] {
    let at = now();
    let listed = Array.map<EncryptedMaps.EncryptedMapData<Types.AccessRights>, VaultSummary>(
      encryptedMaps.getAllAccessibleEncryptedMaps(msg.caller),
      func(map) {
        // Sorted so `item_keys` does not depend on the store's iteration
        // order. `Digest.ofKeyvals` sorts independently, so it stays a pure
        // function of the pairs and is testable without a canister.
        let sorted = Array.sort<(Blob, Blob)>(map.keyvals, func(a, b) { Blob.compare(a.0, b.0) });
        // Liveness from the keys already in hand, so the poll costs no extra
        // read to work out what is in the trash.
        let isLive = livenessOf(Array.map<(Blob, Blob), Blob>(map.keyvals, func((key, _)) { key }));
        let inTrash = if (canRead(msg.caller, map.map_owner, map.map_name)) {
          History.trash(history, map.map_owner, map.map_name, isLive, at);
        } else { [] };
        {
          owner = map.map_owner;
          map_name = { inner = map.map_name };
          access_control = map.access_control;
          item_keys = Array.map<(Blob, Blob), ByteBuf>(sorted, func((key, _)) { { inner = key } });
          digest = { inner = Digest.ofKeyvals(map.keyvals) };
          trashed = inTrash.size();
          my_rights = rightsOf(msg.caller, map.map_owner, map.map_name);
          trash_digest = { inner = trashDigest(inTrash) };
        };
      },
    );
    Array.concat(listed, ownedVaultsNotListed(msg.caller, listed, at));
  };
};
