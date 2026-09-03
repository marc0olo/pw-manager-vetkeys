import Blob "mo:core/Blob";
import Map "mo:core/pure/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";
import Array "mo:core/Array";

/// Every version of every secret, as an append-only log of events.
///
/// One store serves three views, because they are the same rows read three ways:
///
/// - **trash** — the newest event for a key that has no live value
/// - **version history** — every value-carrying event for a key
/// - **audit log** — every event, without the ciphertext
///
/// ## Why events rather than items
///
/// Keying by `(owner, mapName, mapKey)` — one row per secret — meant a second
/// deletion of the same key *replaced* the first. Anyone who could write could
/// therefore destroy a trashed secret by re-inserting at its key and deleting
/// again, and the replacement carried their principal and timestamp, so the
/// record of who deleted it was theirs to choose. Keying by event closes both:
/// a later event adds a row, and no write path can remove or alter one.
///
/// ## Append-only, and what that rests on
///
/// Nothing here removes a row except {@link discardTrash}, {@link dropHistory}
/// and {@link purge} — the first two are the owner's decision, the third is
/// storage reclamation. In particular **restoring removes nothing**: the trash
/// view is derived from whether a key has a live value, so an entry stops being
/// "in the trash" because the secret came back, not because a row was deleted.
///
/// That is what makes a writer unable to destroy anything. It also means a
/// trashed secret keeps its history, and a recovered one keeps it too, without
/// anything being moved: the ciphertext stays keyed as it always was, so it
/// still decrypts under the vault key.
///
/// ## Expiry is enforced on read, and per secret
///
/// `mo:core/Timer` does not persist timers across upgrades, so a purge timer
/// silently stops after a deploy. If "expired entries are gone" were the
/// timer's job, the guarantee would evaporate on the next deploy. So the read
/// paths filter by age and {@link purge} only reclaims bytes.
///
/// Expiry is a property of the **secret**, not of the row. A row is
/// unreachable once the key it belongs to has been deleted for longer than
/// retention — so a two-year-old version of a live secret stays, and deleting
/// that secret starts one clock over its whole history. Restore inside the
/// window and the group stops expiring, which is why recovery brings the
/// history back with it.
///
/// Pure: every function takes the store, `now`, and — where liveness matters —
/// a predicate supplied by the caller. Nothing reads a clock, a caller or
/// canister state, which is what lets these rules be tested without a replica.
module {

  /// How long a deleted secret and its history can be recovered: 90 days, in
  /// nanoseconds.
  ///
  /// Written out rather than computed. A module-level `let` must be a static
  /// expression, so `90 * 24 * 60 * 60 * 1_000_000_000` does not compile here —
  /// the test suite checks the number against that product.
  public let RETENTION_NS : Nat64 = 7_776_000_000_000_000;

  /// Why a version stopped being current, or that a secret began.
  public type Kind = {
    /// A first write, superseding nothing. Carries no value — the value it
    /// created is the live one. Recorded so that every secret has an
    /// authoritative creation time and an author: without it a never-edited
    /// secret has no canister-side record at all, and the only timestamp is
    /// the one the writer put inside the plaintext.
    #Created;
    /// Superseded by a write. Carries the value it replaced.
    #Edited;
    /// Removed from the map. Carries the value it removed.
    #Deleted;
    /// Put back. Carries no value: the key was empty, so the insert superseded
    /// nothing. Recorded anyway, or "who restored this" would go unrecorded.
    #Restored;
  };

  /// `seq` is what makes a row an event rather than a secret. Monotonic and
  /// canister-wide, so it also orders events across vaults for the audit log.
  public type Key = (Principal, Blob, Blob, Nat64);

  public type Entry = {
    /// The ciphertext exactly as it was stored, or `null` for an event that
    /// superseded nothing (a restore) or whose value the owner has dropped.
    ///
    /// Never re-encrypted: the map key is unchanged, so it still decrypts under
    /// the key material it always did.
    value : ?Blob;
    at : Nat64;
    by : Principal;
    kind : Kind;
  };

  public type Store = Map.Map<Key, Entry>;

  public func empty() : Store = Map.empty<Key, Entry>();

  public func compareKeys(a : Key, b : Key) : { #less; #greater; #equal } {
    let byOwner = Principal.compare(a.0, b.0);
    if (byOwner != #equal) return byOwner;
    let byMap = Blob.compare(a.1, b.1);
    if (byMap != #equal) return byMap;
    let byKey = Blob.compare(a.2, b.2);
    if (byKey != #equal) return byKey;
    Nat64.compare(a.3, b.3);
  };

  /// Record one event. `seq` must be unique and increasing; the canister owns
  /// the counter.
  public func append(store : Store, key : Key, entry : Entry) : Store {
    store.add(compareKeys, key, entry);
  };

  func inVault(key : Key, owner : Principal, mapName : Blob) : Bool {
    Principal.compare(key.0, owner) == #equal and Blob.compare(key.1, mapName) == #equal;
  };

  /// Every event for one secret, oldest first.
  public func forKey(store : Store, owner : Principal, mapName : Blob, mapKey : Blob) : [(Nat64, Entry)] {
    let rows = Iter.filter<(Key, Entry)>(
      Map.entries(store),
      func((key, _)) { inVault(key, owner, mapName) and Blob.compare(key.2, mapKey) == #equal },
    );
    Iter.toArray(Iter.map<(Key, Entry), (Nat64, Entry)>(rows, func((key, entry)) { (key.3, entry) }));
  };

  /// The distinct secrets this vault has events for, in key order.
  public func keysIn(store : Store, owner : Principal, mapName : Blob) : [Blob] {
    let seen = Iter.filter<(Key, Entry)>(Map.entries(store), func((key, _)) { inVault(key, owner, mapName) });
    var out : [Blob] = [];
    for ((key, _) in seen) {
      var already = false;
      for (k in out.values()) { if (Blob.compare(k, key.2) == #equal) { already := true } };
      if (not already) { out := Array.concat(out, [key.2]) };
    };
    out;
  };

  /// When this secret was last deleted, if its newest event is a deletion.
  ///
  /// `null` for a secret whose newest event is an edit or a restore — either
  /// way it is not sitting in the trash, and its history does not expire.
  func deletedAt(rows : [(Nat64, Entry)]) : ?Nat64 {
    var newest : ?(Nat64, Entry) = null;
    for ((seq, entry) in rows.values()) {
      switch (newest) {
        case (null) { newest := ?(seq, entry) };
        case (?(bestSeq, _)) { if (seq > bestSeq) { newest := ?(seq, entry) } };
      };
    };
    switch (newest) {
      case (?(_, entry)) { if (entry.kind == #Deleted) ?entry.at else null };
      case (null) { null };
    };
  };

  /// Whether a secret's whole group of events is past retention.
  ///
  /// Takes the group rather than one row, because expiry belongs to the secret:
  /// a live secret's history never expires, and a deleted one's expires all at
  /// once, 90 days after the deletion.
  public func groupExpired(rows : [(Nat64, Entry)], isLive : Bool, now : Nat64) : Bool {
    if (isLive) return false;
    switch (deletedAt(rows)) {
      case (null) { false };
      case (?at) { now >= at + RETENTION_NS };
    };
  };

  /// What is recoverable in one vault: the newest event for each secret that
  /// has no live value and has not expired.
  ///
  /// `isLive` answers "does this map key currently hold a value?" — the mixin's
  /// state, injected so this module stays testable on its own.
  public func trash(
    store : Store,
    owner : Principal,
    mapName : Blob,
    isLive : Blob -> Bool,
    now : Nat64,
  ) : [(Blob, Nat64, Entry)] {
    var out : [(Blob, Nat64, Entry)] = [];
    for (mapKey in keysIn(store, owner, mapName).values()) {
      if (not isLive(mapKey)) {
        let rows = forKey(store, owner, mapName, mapKey);
        if (not groupExpired(rows, false, now)) {
          var newest : ?(Nat64, Entry) = null;
          for ((seq, entry) in rows.values()) {
            switch (newest) {
              case (null) { newest := ?(seq, entry) };
              case (?(bestSeq, _)) { if (seq > bestSeq) { newest := ?(seq, entry) } };
            };
          };
          switch (newest) {
            // A group whose newest event carries no value has nothing to put
            // back — the owner dropped the ciphertext. It is history, not trash.
            case (?(seq, entry)) { if (entry.value != null) { out := Array.concat(out, [(mapKey, seq, entry)]) } };
            case (null) {};
          };
        };
      };
    };
    out;
  };

  /// One event by its sequence number, if it is still reachable.
  public func get(store : Store, key : Key) : ?Entry {
    store.get(compareKeys, key);
  };

  /// Drop the events of every secret in this vault that has no live value —
  /// the trash, and the history belonging to it.
  ///
  /// Scoped to non-live keys deliberately. Dropping every row for the vault
  /// would take the version history of secrets that are still there, so
  /// emptying the trash before sharing would silently destroy live data.
  public func discardTrash(
    store : Store,
    owner : Principal,
    mapName : Blob,
    isLive : Blob -> Bool,
  ) : (Store, Nat) {
    var dropped = 0;
    let kept = Map.foldLeft<Key, Entry, Store>(
      store,
      empty(),
      func(kept, key, entry) {
        if (inVault(key, owner, mapName) and not isLive(key.2)) {
          dropped += 1;
          kept;
        } else { kept.add(compareKeys, key, entry) };
      },
    );
    (kept, dropped);
  };

  /// Drop every event belonging to one vault, whatever its state.
  ///
  /// For deleting the vault itself, where {@link discardTrash}'s scoping to
  /// non-live keys would be wrong: nothing should survive a vault that is gone,
  /// and leaving events behind would strand them under a name no listing
  /// returns. Distinct from `discardTrash` so the intent is in the name rather
  /// than in the caller happening to have removed the values first.
  public func discardVault(store : Store, owner : Principal, mapName : Blob) : (Store, Nat) {
    var dropped = 0;
    let kept = Map.foldLeft<Key, Entry, Store>(
      store,
      empty(),
      func(kept, key, entry) {
        if (inVault(key, owner, mapName)) {
          dropped += 1;
          kept;
        } else { kept.add(compareKeys, key, entry) };
      },
    );
    (kept, dropped);
  };

  /// Drop the *ciphertext* of one live secret's history, keeping the events.
  ///
  /// The owner's way to reclaim storage without losing the record: "edited by X
  /// at T" survives, so pruning cannot be used to launder the audit trail.
  public func dropHistory(store : Store, owner : Principal, mapName : Blob, mapKey : Blob) : (Store, Nat) {
    var cleared = 0;
    let next = Map.foldLeft<Key, Entry, Store>(
      store,
      empty(),
      func(acc, key, entry) {
        if (inVault(key, owner, mapName) and Blob.compare(key.2, mapKey) == #equal and entry.value != null) {
          cleared += 1;
          acc.add(compareKeys, key, { entry with value = null });
        } else { acc.add(compareKeys, key, entry) };
      },
    );
    (next, cleared);
  };

  /// Drop one vault's groups that are past retention. Storage reclamation only —
  /// correctness does not depend on this having run, because {@link trash} and
  /// {@link forKey}'s callers filter by age too.
  ///
  /// Scoped to one vault rather than sweeping the store, because deciding
  /// expiry needs to know which keys are live and that is the mixin's state.
  /// Called on the write path, where the vault being touched has its live keys
  /// to hand; a vault nobody writes to keeps expired bytes on disk, which is
  /// the residual case documented on the canister.
  public func purge(
    store : Store,
    owner : Principal,
    mapName : Blob,
    isLive : Blob -> Bool,
    now : Nat64,
  ) : Store {
    Map.foldLeft<Key, Entry, Store>(
      store,
      empty(),
      func(kept, key, entry) {
        if (not inVault(key, owner, mapName)) return kept.add(compareKeys, key, entry);
        let rows = forKey(store, key.0, key.1, key.2);
        if (groupExpired(rows, isLive(key.2), now)) kept else kept.add(compareKeys, key, entry);
      },
    );
  };
};
