import Blob "mo:core/Blob";
import Text "mo:core/Text";
import Digest "../src/backend/lib/Digest";

/// The digest a poll compares to decide whether a vault changed.
///
/// These run under `mops test` — no replica, no cycles. That matters for the
/// injectivity case in particular: it is a security property, and it was
/// previously guarded only by a replica script that spends real cycles per run.
let blob = func(t : Text) : Blob { Text.encodeUtf8(t) };
let pair = func(k : Text, v : Text) : (Blob, Blob) { (blob k, blob v) };

do {
  // Same contents, same digest — the poll must not report a change that did
  // not happen.
  assert Digest.ofKeyvals([pair("a", "one")]) == Digest.ofKeyvals([pair("a", "one")]);
};

do {
  // Order-independent: the store's iteration order is not part of the content.
  let ab = Digest.ofKeyvals([pair("a", "1"), pair("b", "2")]);
  let ba = Digest.ofKeyvals([pair("b", "2"), pair("a", "1")]);
  assert ab == ba;
};

do {
  // A changed value changes the digest, including one of the same length —
  // which a length- or count-based signature would miss.
  assert Digest.ofKeyvals([pair("a", "one")]) != Digest.ofKeyvals([pair("a", "two")]);
};

do {
  // A changed *key* changes it too.
  assert Digest.ofKeyvals([pair("a", "1")]) != Digest.ofKeyvals([pair("b", "1")]);
};

do {
  // Adding and removing.
  let one = Digest.ofKeyvals([pair("a", "1")]);
  assert one != Digest.ofKeyvals([pair("a", "1"), pair("b", "2")]);
  assert one != Digest.ofKeyvals([]);
};

do {
  // Content-addressed, not a write counter: undoing an edit returns the digest
  // to its earlier value. A monotonic counter would fail this.
  let before = Digest.ofKeyvals([pair("a", "1")]);
  let edited = Digest.ofKeyvals([pair("a", "2")]);
  assert before != edited;
  assert before == Digest.ofKeyvals([pair("a", "1")]);
};

do {
  // Injectivity — the reason each blob is length-prefixed before hashing.
  //
  // Concatenated without framing, ("aab", "c") and ("aa", "bc") are the same
  // byte stream. A caller with write access chooses *both* halves, so an edit
  // could otherwise be crafted to leave the digest unchanged and stay invisible
  // to every other client's poll.
  assert Digest.ofKeyvals([pair("aab", "c")]) != Digest.ofKeyvals([pair("aa", "bc")]);

  // The same trap across a pair boundary rather than within one.
  assert Digest.ofKeyvals([pair("a", "bc")]) != Digest.ofKeyvals([pair("ab", "c")]);
};
