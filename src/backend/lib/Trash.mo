import Blob "mo:core/Blob";
import Map "mo:core/pure/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";

/// Deleted items, kept for 90 days.
///
/// Pure: every function takes the store and `now` and returns a new store or a
/// view of it. Nothing here reads a clock, a caller or canister state, which is
/// what lets the retention and visibility rules be tested without a replica.
///
/// **Expiry is enforced on read, not by the purge.** `mo:core/Timer` does not
/// persist timers across upgrades, so a purge timer silently stops after a
/// deploy until something re-arms it. If "expired entries are gone" were the
/// timer's job, the guarantee would evaporate on the next deploy. Instead
/// {@link visible} and {@link take} filter by age, so an expired entry can
/// never be returned however long the timer has been dead; {@link purge} only
/// reclaims storage, where losing it costs bytes rather than correctness.
module {

  /// How long a deleted item can be recovered: 90 days, in nanoseconds.
  ///
  /// Written out rather than computed. A module-level `let` must be a static
  /// expression, so `90 * 24 * 60 * 60 * 1_000_000_000` does not compile here —
  /// the test below checks the number against that product.
  public let RETENTION_NS : Nat64 = 7_776_000_000_000_000;

  public type Key = (Principal, Blob, Blob);

  public type Entry = {
    /// The ciphertext exactly as it was stored. Never re-encrypted: the map key
    /// is unchanged, so it still decrypts under the key material it always did.
    value : Blob;
    deletedAt : Nat64;
    /// Who deleted it. Half of who may see it — see the canister.
    deletedBy : Principal;
  };

  public type Store = Map.Map<Key, Entry>;

  public func empty() : Store = Map.empty<Key, Entry>();

  public func compareKeys(a : Key, b : Key) : { #less; #greater; #equal } {
    let byOwner = Principal.compare(a.0, b.0);
    if (byOwner != #equal) return byOwner;
    let byMap = Blob.compare(a.1, b.1);
    if (byMap != #equal) return byMap;
    Blob.compare(a.2, b.2);
  };

  public func isExpired(entry : Entry, now : Nat64) : Bool {
    now >= entry.deletedAt + RETENTION_NS;
  };

  public func put(store : Store, key : Key, entry : Entry) : Store {
    store.add(compareKeys, key, entry);
  };

  /// Take an entry out for restoring. An expired entry is not there to take,
  /// whatever the purge has or has not done.
  public func take(store : Store, key : Key, now : Nat64) : (Store, ?Entry) {
    switch (store.get(compareKeys, key)) {
      case (null) { (store, null) };
      case (?entry) {
        if (isExpired(entry, now)) { (store, null) } else {
          (store.remove(compareKeys, key), ?entry);
        };
      };
    };
  };

  /// Everything recoverable in one vault, oldest deletion first.
  public func visible(store : Store, owner : Principal, mapName : Blob, now : Nat64) : [(Blob, Entry)] {
    let rows = Iter.filter<(Key, Entry)>(
      Map.entries(store),
      func(((entryOwner, entryMap, _), entry)) {
        Principal.compare(entryOwner, owner) == #equal and Blob.compare(entryMap, mapName) == #equal and not isExpired(entry, now);
      },
    );
    Iter.toArray(Iter.map<(Key, Entry), (Blob, Entry)>(rows, func(((_, _, mapKey), entry)) { (mapKey, entry) }));
  };

  /// Drop one vault's entries outright, expired or not. Unlike `purge` this is
  /// a decision rather than housekeeping: it makes deletions unrecoverable
  /// before their 90 days are up, which is the only way to take a secret out of
  /// reach ahead of sharing the vault with someone new.
  public func discard(store : Store, owner : Principal, mapName : Blob) : (Store, Nat) {
    var dropped = 0;
    let kept = Map.foldLeft<Key, Entry, Store>(
      store,
      empty(),
      func(kept, key, entry) {
        let (entryOwner, entryMap, _) = key;
        if (Principal.compare(entryOwner, owner) == #equal and Blob.compare(entryMap, mapName) == #equal) {
          dropped += 1;
          kept;
        } else { kept.add(compareKeys, key, entry) };
      },
    );
    (kept, dropped);
  };

  /// Drop everything past retention. Storage reclamation only — correctness
  /// does not depend on this having run.
  public func purge(store : Store, now : Nat64) : Store {
    Map.foldLeft<Key, Entry, Store>(
      store,
      empty(),
      func(kept, key, entry) { if (isExpired(entry, now)) kept else kept.add(compareKeys, key, entry) },
    );
  };
};
