import VetKeys "mo:ic-vetkeys/Types";
import Shared "lib/vetkeys/Types";
import Map "mo:core/pure/Map";
import History "lib/History";

/// Every type this canister exposes beyond the ones the endpoint groups
/// contribute. The central schema the Motoko architecture asks for: `main.mo`
/// composes, `lib/` computes, `mixins/` serves, and the shapes they agree on
/// live here.
module {
  /// The append-only event log and the sequence it hands out.
  ///
  /// One record so the groups that write events can receive both — the counter
  /// only means anything alongside the log it indexes, and a mixin receives a
  /// `var` by value, so writes to a bare one would not propagate back.
  ///
  /// `nextSeq` orders events canister-wide rather than per secret, so an audit
  /// log can be read across vaults in the order things actually happened.
  public type EventsState = { var log : History.Store; var nextSeq : Nat64 };

  /// The vaults this canister knows about itself: which principal owns which
  /// map, and the display name each carries.
  ///
  /// One record because the two are written together — creating a vault claims
  /// a name, deleting it releases both — and because a mixin cannot take a
  /// `var` and have its writes propagate back.
  ///
  /// Both are keyed by owner rather than by the `(owner, mapName)` pair,
  /// because the primary read is "everything *I* own" and that runs on the poll
  /// path; the pair-keyed form made it O(rows across all users) per poll.
  public type VaultsState = {
    var owned : Map.Map<Principal, Map.Map<Blob, ()>>;
    var names : Map.Map<Principal, Map.Map<Blob, Text>>;
  };

  /// Whether the low-balance warning is currently standing.
  ///
  /// A record for the same reason as the two above. Stable, and that is
  /// load-bearing: it makes **the newest watchdog line in the log the current
  /// state**, which is the contract `scripts/lib/cycles.mjs` reads it under.
  /// Transient would reset on every deploy, and since a healthy deploy prints
  /// nothing, a warning from before it would stand as the newest line long
  /// after a top-up cleared it.
  public type HealthState = { var warnedLowCycles : Bool };

  /// What the canister can say about its own ability to derive vault keys.
  ///
  /// A state, never a number: the balance itself is the operator's business.
  ///
  /// The threshold for `#low_cycles` is {@link BLAME_CYCLES_BELOW}, which is not
  /// the one the operator's warning uses: naming a cause to a user demands more
  /// than warning early does.
  public type ServiceHealth = {
  /// Derivation should work. If a call still failed, the cause is not one
  /// this canister can name.
  #funded;
  /// Near the point where `vetkd_derive_key` is refused.
  #low_cycles;
};

  public type TrashedItem = {
  /// Which event this row is, and what `restore_version` takes.
  ///
  /// The map key is not an identity here: a secret can be deleted, restored
  /// and deleted again, so several events share it. Addressing a restore by
  /// map key would be ambiguous the moment that happens.
  seq : Nat64;
  map_key : Shared.ByteBuf;
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
  value : Shared.ByteBuf;
  deleted_at : Nat64;
  deleted_by : Principal;
};

  public type VersionKind = { #Created; #Edited; #Deleted; #Restored };

  public type Version = {
  seq : Nat64;
  /// The value this event superseded. Absent for a restore, which superseded
  /// nothing, and for a version whose ciphertext the owner has dropped —
  /// the event is still here, which is the point of dropping rather than
  /// deleting.
  value : ?Shared.ByteBuf;
  at : Nat64;
  by : Principal;
  kind : VersionKind;
};

  public type ItemSummary = {
  map_key : Shared.ByteBuf;
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

  public type VaultName = {
  owner : Principal;
  map_name : Shared.ByteBuf;
  display_name : Text;
};

  public type VaultSummary = {
  owner : Principal;
  map_name : Shared.ByteBuf;
  access_control : [(Principal, VetKeys.AccessRights)];
  item_keys : [Shared.ByteBuf];
  /// SHA-256 over the vault's contents. Changes iff the contents change.
  digest : Shared.ByteBuf;
  /// Recoverable deletions the caller may see. Lets the UI offer restoring
  /// without a second round trip, and without hinting at entries it may not.
  trashed : Nat;
  /// What *this caller* may do here. See `rightsOf` — the library will not
  /// answer this, so a grantee otherwise has to discover their permissions by
  /// being refused.
  my_rights : ?VetKeys.AccessRights;
  /// Fingerprint of what the trash listing would return.
  ///
  /// `trashed` alone cannot drive an open dialog: restoring one item and
  /// deleting another leaves the count unchanged while the contents differ,
  /// so a second viewer would keep a stale list. #14's rule is that the poll
  /// carries no ciphertext, and this is how it stays true — the digest says
  /// whether to re-read, and only then does anything fetch values.
  trash_digest : Shared.ByteBuf;
};
};
