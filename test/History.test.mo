import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import History "../src/backend/lib/History";

/// The event log, tested without a replica.
///
/// These are the properties that decide whether a deleted or edited secret is
/// recoverable, so they belong where they can be run for free — and where `now`
/// and liveness are arguments rather than a clock and a canister.

let alice = Principal.fromText("2ibo7-dia");
let bob = Principal.fromText("aaaaa-aa");
let vault = Text.encodeUtf8("Personal");
let other = Text.encodeUtf8("Work");
let key = func(t : Text) : Blob { Text.encodeUtf8(t) };

let T0 : Nat64 = 1_000_000_000_000;
let nothingLive = func(_ : Blob) : Bool { false };
let allLive = func(_ : Blob) : Bool { true };
let onlyLive = func(live : Text) : Blob -> Bool {
  func(k : Blob) : Bool { Blob.compare(k, key live) == #equal };
};

var seq : Nat64 = 0;
let add = func(store : History.Store, mapName : Blob, k : Text, v : ?Text, at : Nat64, by : Principal, kind : History.Kind) : History.Store {
  let entry = {
    value = switch (v) { case (null) { null }; case (?text) { ?Text.encodeUtf8(text) } };
    at;
    by;
    kind;
  };
  let next = History.append(store, (alice, mapName, key k, seq), entry);
  seq += 1;
  next;
};

do {
  // The retention constant has to be written as a literal, so check the
  // arithmetic it stands for rather than trusting the digits.
  assert History.RETENTION_NS == 90 * 24 * 60 * 60 * 1_000_000_000;
};

do {
  // The fix, stated as a property. Deleting the same key twice must produce two
  // rows: with one row per key, the second deletion replaced the first, so
  // anyone who could write could destroy a trashed secret by re-inserting at
  // its key and deleting again — and the replacement carried their principal.
  var store = History.empty();
  store := add(store, vault, "k1", ?"the real secret", T0, alice, #Deleted);
  store := add(store, vault, "k1", ?"overwritten by bob", T0 + 1, bob, #Deleted);

  let rows = History.forKey(store, alice, vault, key "k1");
  assert rows.size() == 2;
  // Both survive, and the original is still readable.
  var sawOriginal = false;
  for ((_, entry) in rows.values()) {
    if (entry.value == ?Text.encodeUtf8("the real secret")) { sawOriginal := true };
  };
  assert sawOriginal;
};

do {
  // An edit keeps the value it replaced. This is what trash never covered:
  // deletions were recoverable, edits silently destroyed the previous secret.
  var store = History.empty();
  store := add(store, vault, "k1", ?"v1", T0, alice, #Edited);
  store := add(store, vault, "k1", ?"v2", T0 + 1, bob, #Edited);
  assert History.forKey(store, alice, vault, key "k1").size() == 2;
  // Still live, so none of it is trash.
  assert History.trash(store, alice, vault, allLive, T0 + 2).size() == 0;
};

do {
  // Trash is the newest event for a key with no live value — one row per
  // secret, not one per event, or "restore all" would replay every version and
  // each insert would overwrite the last.
  var store = History.empty();
  store := add(store, vault, "k1", ?"v1", T0, alice, #Edited);
  store := add(store, vault, "k1", ?"v2", T0 + 1, alice, #Deleted);

  let rows = History.trash(store, alice, vault, nothingLive, T0 + 2);
  assert rows.size() == 1;
  assert rows[0].2.value == ?Text.encodeUtf8("v2");
};

do {
  // Liveness is what takes a secret out of the trash, not the removal of a row.
  // That is what leaves a writer unable to destroy anything, and what lets a
  // recovered secret keep its history.
  var store = History.empty();
  store := add(store, vault, "k1", ?"v1", T0, alice, #Deleted);
  assert History.trash(store, alice, vault, nothingLive, T0 + 1).size() == 1;

  // Same store, key now live: gone from the trash, history untouched.
  assert History.trash(store, alice, vault, allLive, T0 + 1).size() == 0;
  assert History.forKey(store, alice, vault, key "k1").size() == 1;
};

do {
  // Expiry belongs to the secret. A live secret's history never expires,
  // however old — otherwise a two-year-old version would vanish from under a
  // secret still in use.
  var store = History.empty();
  store := add(store, vault, "k1", ?"ancient", T0, alice, #Edited);
  let rows = History.forKey(store, alice, vault, key "k1");
  assert not History.groupExpired(rows, true, T0 + 10 * History.RETENTION_NS);
};

do {
  // A deleted secret's whole group expires together, 90 days after the
  // *deletion* — not per row, or an old version would expire while yesterday's
  // deletion stayed and "the secret and its history go together" would be false.
  var store = History.empty();
  store := add(store, vault, "k1", ?"old version", T0, alice, #Edited);
  store := add(store, vault, "k1", ?"final", T0 + History.RETENTION_NS, alice, #Deleted);
  let rows = History.forKey(store, alice, vault, key "k1");

  // The edit is far older than retention, but the deletion anchors the clock.
  assert not History.groupExpired(rows, false, T0 + History.RETENTION_NS + 1);
  assert History.groupExpired(rows, false, T0 + 2 * History.RETENTION_NS);
};

do {
  // The case where liveness is load-bearing: a secret whose newest event is a
  // deletion but which holds a value again. Reachable from the app — you have
  // an item open, someone else deletes it, you save — so the insert lands at a
  // key whose last recorded event was a deletion.
  //
  // Its history must not expire on that stale deletion's clock: the secret is
  // in use, and the row is a version of something live.
  var store = History.empty();
  store := add(store, vault, "k1", ?"before", T0, bob, #Deleted);
  let rows = History.forKey(store, alice, vault, key "k1");
  let long = T0 + 10 * History.RETENTION_NS;
  assert History.groupExpired(rows, false, long);
  assert not History.groupExpired(rows, true, long);
  // And it is not offered for recovery either, because it is not deleted.
  assert History.trash(store, alice, vault, allLive, long).size() == 0;
};

do {
  // Restoring inside the window stops the group expiring, which is how
  // recovery brings the history back with the secret.
  var store = History.empty();
  store := add(store, vault, "k1", ?"v1", T0, alice, #Deleted);
  store := add(store, vault, "k1", null, T0 + 1, alice, #Restored);
  let rows = History.forKey(store, alice, vault, key "k1");
  // Newest event is a restore, so nothing is counting down.
  assert not History.groupExpired(rows, false, T0 + 10 * History.RETENTION_NS);
};

do {
  // Discarding is scoped to secrets with no live value. Dropping every row for
  // the vault would take the version history of secrets that are still there,
  // so emptying the trash before sharing would silently destroy live data.
  var store = History.empty();
  store := add(store, vault, "gone", ?"deleted thing", T0, alice, #Deleted);
  store := add(store, vault, "kept", ?"old version of a live thing", T0, alice, #Edited);

  let (after, dropped) = History.discardTrash(store, alice, vault, onlyLive "kept");
  assert dropped == 1;
  assert History.forKey(after, alice, vault, key "gone").size() == 0;
  assert History.forKey(after, alice, vault, key "kept").size() == 1;
};

do {
  // Dropping a live secret's history clears the ciphertext and keeps the
  // events, so "edited by X at T" survives: pruning must not be a way to
  // launder the audit trail.
  var store = History.empty();
  store := add(store, vault, "k1", ?"v1", T0, bob, #Edited);
  store := add(store, vault, "k1", ?"v2", T0 + 1, bob, #Edited);

  let (after, cleared) = History.dropHistory(store, alice, vault, key "k1");
  assert cleared == 2;
  let rows = History.forKey(after, alice, vault, key "k1");
  assert rows.size() == 2;
  for ((_, entry) in rows.values()) {
    assert entry.value == null;
    // The record of who and when is what is being preserved.
    assert Principal.compare(entry.by, bob) == #equal;
  };
};

do {
  // A group whose newest event carries no value has nothing to put back, so it
  // is history rather than trash — otherwise the dialog would offer a Restore
  // that could only fail.
  var store = History.empty();
  store := add(store, vault, "k1", null, T0, alice, #Deleted);
  assert History.trash(store, alice, vault, nothingLive, T0 + 1).size() == 0;
};

do {
  // Scoped to one vault, by owner *and* name: a vault is the pair, not the name.
  var store = History.empty();
  store := add(store, vault, "k1", ?"x", T0, alice, #Deleted);
  store := add(store, other, "k1", ?"y", T0, alice, #Deleted);

  let (after, dropped) = History.discardTrash(store, alice, vault, nothingLive);
  assert dropped == 1;
  assert History.trash(after, alice, other, nothingLive, T0 + 1).size() == 1;

  // And the purge leaves the other vault alone even when both are expired.
  let late = T0 + 2 * History.RETENTION_NS;
  let purged = History.purge(store, alice, vault, nothingLive, late);
  assert History.forKey(purged, alice, vault, key "k1").size() == 0;
  assert History.forKey(purged, alice, other, key "k1").size() == 1;
};

do {
  // Purging changes nothing a reader could see: the read paths already exclude
  // an expired group. This is what makes the timer's absence survivable.
  var store = History.empty();
  store := add(store, vault, "k1", ?"x", T0, alice, #Deleted);
  let late = T0 + 2 * History.RETENTION_NS;
  assert History.trash(store, alice, vault, nothingLive, late).size()
    == History.trash(History.purge(store, alice, vault, nothingLive, late), alice, vault, nothingLive, late).size();
};

do {
  // One entry per distinct secret, however many events each has.
  var store = History.empty();
  for (k in ["a", "b", "a", "c", "b"].values()) {
    store := add(store, vault, k, ?"x", T0, alice, #Edited);
  };
  assert History.keysIn(store, alice, vault).size() == 3;
};

do {
  // Pruning is not restricted to live secrets, and applied to a deleted one it
  // takes the group out of the trash rather than leaving a listed row whose
  // value has gone. That is what lets the poll's digest stand in for the
  // ciphertext: a cleared value changes the row *set*, never a listed row's
  // meaning.
  var store = History.empty();
  store := add(store, vault, "k1", ?"deleted secret", T0, alice, #Deleted);
  assert History.trash(store, alice, vault, nothingLive, T0 + 1).size() == 1;

  let (after, cleared) = History.dropHistory(store, alice, vault, key "k1");
  assert cleared == 1;
  // Gone from the trash, so nothing offers a Restore that could only fail.
  assert History.trash(after, alice, vault, nothingLive, T0 + 1).size() == 0;
  // But the event survives: who deleted it, and when, is still on the record.
  let rows = History.forKey(after, alice, vault, key "k1");
  assert rows.size() == 1;
  assert rows[0].1.value == null;
  assert rows[0].1.kind == #Deleted;
};
