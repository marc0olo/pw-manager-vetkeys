import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Trash "../src/backend/lib/Trash";

/// Retention and visibility, tested without a replica.
///
/// These are the properties that decide whether a deleted secret is recoverable
/// or leaked, so they belong where they can be run for free — and where `now`
/// is an argument rather than a clock to wait on.

let alice = Principal.fromText("2ibo7-dia");
let bob = Principal.fromText("aaaaa-aa");
let vault = Text.encodeUtf8("Personal");
let other = Text.encodeUtf8("Work");
let key = func(t : Text) : Blob { Text.encodeUtf8(t) };

let T0 : Nat64 = 1_000_000_000_000;
let entry = func(v : Text, at : Nat64, by : Principal) : Trash.Entry {
  { value = Text.encodeUtf8(v); deletedAt = at; deletedBy = by };
};

do {
  // The retention constant has to be written as a literal, so check the
  // arithmetic it stands for rather than trusting the digits.
  assert Trash.RETENTION_NS == 90 * 24 * 60 * 60 * 1_000_000_000;
};

do {
  // Restore returns the exact bytes that were stored. Nothing is re-encrypted,
  // so this must be byte-identical or the value will not decrypt.
  let store = Trash.put(Trash.empty(), (alice, vault, key "a"), entry("ciphertext", T0, alice));
  let (_, taken) = Trash.take(store, (alice, vault, key "a"), T0 + 1);
  switch (taken) {
    case (null) { assert false };
    case (?e) { assert e.value == Text.encodeUtf8("ciphertext") };
  };
};

do {
  // Taking removes it, so a restore cannot be replayed.
  let store = Trash.put(Trash.empty(), (alice, vault, key "a"), entry("x", T0, alice));
  let (after, first) = Trash.take(store, (alice, vault, key "a"), T0);
  let (_, second) = Trash.take(after, (alice, vault, key "a"), T0);
  assert first != null;
  assert second == null;
};

do {
  // Expiry is enforced on read. Nothing has purged this store — the entry is
  // still physically present — and it must still be unreachable.
  let store = Trash.put(Trash.empty(), (alice, vault, key "a"), entry("x", T0, alice));
  let justInside = T0 + Trash.RETENTION_NS - 1;
  let justPast = T0 + Trash.RETENTION_NS;

  assert Trash.visible(store, alice, vault, justInside).size() == 1;
  assert Trash.visible(store, alice, vault, justPast).size() == 0;

  let (_, late) = Trash.take(store, (alice, vault, key "a"), justPast);
  assert late == null; // not restorable either, purge or no purge
};

do {
  // A vault's trash is its own.
  var store = Trash.put(Trash.empty(), (alice, vault, key "a"), entry("x", T0, alice));
  store := Trash.put(store, (alice, other, key "b"), entry("y", T0, alice));
  store := Trash.put(store, (bob, vault, key "c"), entry("z", T0, bob));

  assert Trash.visible(store, alice, vault, T0).size() == 1;
  assert Trash.visible(store, alice, other, T0).size() == 1;
  assert Trash.visible(store, bob, vault, T0).size() == 1;
};

do {
  // Who deleted it is carried, because it decides who may see it.
  let store = Trash.put(Trash.empty(), (alice, vault, key "a"), entry("x", T0, bob));
  let rows = Trash.visible(store, alice, vault, T0);
  assert rows.size() == 1;
  assert Principal.compare(rows[0].1.deletedBy, bob) == #equal;
};

do {
  // Purge drops the expired and keeps the rest — it is storage reclamation, so
  // it must not take anything still recoverable with it.
  var store = Trash.put(Trash.empty(), (alice, vault, key "old"), entry("x", T0, alice));
  store := Trash.put(store, (alice, vault, key "new"), entry("y", T0 + Trash.RETENTION_NS, alice));

  let purged = Trash.purge(store, T0 + Trash.RETENTION_NS);
  assert Trash.visible(purged, alice, vault, T0 + Trash.RETENTION_NS).size() == 1;

  let (_, gone) = Trash.take(purged, (alice, vault, key "old"), T0);
  assert gone == null;
};

do {
  // Purging changes nothing a reader could see: visibility already excluded
  // the expired entry. This is what makes the timer's absence survivable.
  var store = Trash.put(Trash.empty(), (alice, vault, key "old"), entry("x", T0, alice));
  store := Trash.put(store, (alice, vault, key "new"), entry("y", T0 + 1, alice));
  let at = T0 + Trash.RETENTION_NS;

  assert Trash.visible(store, alice, vault, at).size() == Trash.visible(Trash.purge(store, at), alice, vault, at).size();
};

do {
  // A wipe is N deletions sharing a timestamp, not a distinct kind of thing —
  // which is why the store has one entry per item and one restore path.
  var store = Trash.empty();
  for (k in ["a", "b", "c"].values()) {
    store := Trash.put(store, (alice, vault, key k), entry("x", T0, bob));
  };
  let rows = Trash.visible(store, alice, vault, T0);
  assert rows.size() == 3;
  for (row in rows.values()) { assert row.1.deletedAt == T0 };
};
