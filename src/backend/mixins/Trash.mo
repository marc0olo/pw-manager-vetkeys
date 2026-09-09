import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Shared "../lib/vetkeys/Types";
import Access "../lib/Access";
import Cycles "../lib/Cycles";
import History "../lib/History";
import Recording "../lib/Recording";
import Types "../types";

/// What has been deleted from a vault, and putting it back.
///
/// Reads are gated on being able to read the *vault*, not on having been the
/// one who deleted: trash is a property of the vault, so a colleague's
/// deletion is recoverable by anyone who could have read the secret anyway.
/// Restoring needs write access, which the library enforces on the write
/// itself.
mixin (
  encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
  events : Types.EventsState,
  health : Types.HealthState,
) {
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
  public query (msg) func get_trash(map_owner : Principal, map_name : Shared.ByteBuf) : async Shared.Result<[Types.TrashedItem], Text> {
    if (not Access.canRead(encryptedMaps, msg.caller, map_owner, map_name.inner)) return #Err("unauthorized");
    #Ok(
      Array.filterMap<(Blob, Nat64, History.Entry), Types.TrashedItem>(
        History.trash(events.log, map_owner, map_name.inner, Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner), Recording.now()),
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
  public shared (msg) func restore_trashed_values(map_owner : Principal, map_name : Shared.ByteBuf) : async Shared.Result<Nat, Text> {
    Cycles.watchdog(health);
    let at = Recording.now();
    let isLive = Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner);
    var restored = 0;
    var pending : [(Blob, ?Blob, History.Kind)] = [];
    for ((mapKey, _, entry) in History.trash(events.log, map_owner, map_name.inner, isLive, at).values()) {
      switch (entry.value) {
        case (null) {};
        case (?value) {
          switch (encryptedMaps.insertEncryptedValue(msg.caller, (map_owner, map_name.inner), mapKey, value)) {
            case (#err(e)) { return #Err(e) };
            case (#ok(superseded)) {
              let kind = switch (superseded) { case (null) { #Restored }; case (?_) { #Edited } };
              pending := pending.concat([(mapKey, superseded, kind)]);
              restored += 1;
            };
          };
        };
      };
    };
    Recording.record(events, msg.caller, map_owner, map_name.inner, pending, isLive);
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
  /// touching the version events.log of secrets that are still there.
  public shared (msg) func discard_trash(map_owner : Principal, map_name : Shared.ByteBuf) : async Shared.Result<Nat, Text> {
    Cycles.watchdog(health);
    if (Principal.compare(msg.caller, map_owner) != #equal) return #Err("unauthorized");
    let (next, dropped) = History.discardTrash(
      events.log,
      map_owner,
      map_name.inner,
      Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner),
    );
    events.log := next;
    #Ok(dropped);
  };
};
