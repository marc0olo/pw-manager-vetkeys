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

/// Every version of every secret, and putting an earlier one back.
///
/// The event log is append-only, so a writer can add versions but destroy
/// none; only the vault's owner can make a version unrecoverable, through
/// `drop_history`. That asymmetry is the point — a `ReadWrite` collaborator
/// can overwrite a secret, and this is what makes that recoverable.
mixin (
  encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
  events : Types.EventsState,
  health : Types.HealthState,
) {
  /// Every recorded version of one secret, oldest first.
  ///
  /// Visible to everyone who can read the vault, on the same reasoning as
  /// `get_trash`: a reader can already read the current value, so earlier
  /// values of the same secret are not a wider class of information. It does
  /// mean a member added later sees versions written before they arrived —
  /// deliberate, and `drop_history` is the owner's remedy.
  ///
  /// Not on the poll. Values ride this because it is user-initiated and scoped
  /// to one secret — nothing automatic carries ciphertext.
  public query (msg) func get_history(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    map_key : Shared.ByteBuf,
  ) : async Shared.Result<[Types.Version], Text> {
    if (not Access.canRead(encryptedMaps, msg.caller, map_owner, map_name.inner)) return #Err("unauthorized");
    let isLive = Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner);
    let rows = History.forKey(events.log, map_owner, map_name.inner, map_key.inner);
    // A deleted secret's events.log expires with it, all at once — so an expired
    // group answers empty rather than leaking what it used to hold.
    if (History.groupExpired(rows, isLive(map_key.inner), Recording.now())) return #Ok([]);
    #Ok(
      Array.map<(Nat64, History.Entry), Types.Version>(
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
  /// anything, and what lets a recovered secret keep its events.log.
  public shared (msg) func restore_version(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
    seq : Nat64,
  ) : async Shared.Result<(), Text> {
    Cycles.watchdog(health);
    let at = Recording.now();
    // The map key is part of the event key, so the row has to be found by
    // scanning this vault's events rather than by direct lookup. One vault's
    // log, on a user-initiated call.
    let isLive = Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner);
    var found : ?(Blob, History.Entry) = null;
    for (mapKey in History.keysIn(events.log, map_owner, map_name.inner).values()) {
      for ((rowSeq, entry) in History.forKey(events.log, map_owner, map_name.inner, mapKey).values()) {
        if (rowSeq == seq) { found := ?(mapKey, entry) };
      };
    };
    switch (found) {
      case (null) { #Err("no such version") };
      case (?(mapKey, entry)) {
        let rows = History.forKey(events.log, map_owner, map_name.inner, mapKey);
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
                Recording.record(events, msg.caller, map_owner, map_name.inner, [(mapKey, superseded, kind)], isLive);
                #Ok();
              };
            };
          };
        };
      };
    };
  };

  /// Per-item events.log facts for one vault: how much is restorable, and when the
  /// current value was actually written.
  ///
  /// A separate query rather than fields on `get_vault_summaries`, which a
  /// client polls: that response is a digest and a key list, and two numbers
  /// per item would grow it with the vault. This is read once when a vault is
  /// opened, alongside the values themselves.
  ///
  /// No ciphertext, so it costs no key derivation.
  public query (msg) func get_item_summaries(
    map_owner : Principal,
    map_name : Shared.ByteBuf,
  ) : async Shared.Result<[Types.ItemSummary], Text> {
    if (not Access.canRead(encryptedMaps, msg.caller, map_owner, map_name.inner)) return #Err("unauthorized");
    let isLive = Recording.liveness(encryptedMaps, msg.caller, map_owner, map_name.inner);
    let at = Recording.now();
    var out : [Types.ItemSummary] = [];
    for (mapKey in History.keysIn(events.log, map_owner, map_name.inner).values()) {
      let rows = History.forKey(events.log, map_owner, map_name.inner, mapKey);
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

  /// Drop the stored versions of one secret, keeping the secret itself.
  ///
  /// The owner's way to reclaim space, or to stop keeping a secret's earlier
  /// values, without a retention policy guessing on their behalf.
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
    map_name : Shared.ByteBuf,
    map_key : Shared.ByteBuf,
  ) : async Shared.Result<Nat, Text> {
    Cycles.watchdog(health);
    if (Principal.compare(msg.caller, map_owner) != #equal) return #Err("unauthorized");
    let (next, cleared) = History.dropHistory(events.log, map_owner, map_name.inner, map_key.inner);
    events.log := next;
    #Ok(cleared);
  };
};
