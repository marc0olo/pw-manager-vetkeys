import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Sha256 "mo:sha2/Sha256";

/// A content digest for a vault, so a poll can tell whether it changed without
/// downloading it.
///
/// Pure: no state, no caller, no authorization. That is the point of it living
/// here rather than beside the endpoint — the property below is a fact about two
/// byte strings and is testable without a replica.
module {

  /// Length-prefix a blob before hashing it.
  ///
  /// Without this the encoding is not injective: `("aab", "c")` and
  /// `("aa", "bc")` produce the same byte stream. A caller with write access
  /// chooses **both** the key and the value, so an edit could be crafted to
  /// leave the digest unchanged and stay invisible to every other client's
  /// poll. Framing the lengths makes that impossible rather than unlikely.
  func writeFramed(digest : Sha256.Digest, blob : Blob) {
    let size = Nat.toNat64(blob.size());
    digest.writeArray(
      Array.tabulate<Nat8>(8, func(i) { Nat.toNat8(Nat64.toNat((size >> Nat.toNat64(8 * (7 - i))) & 0xFF)) })
    );
    digest.writeBlob(blob);
  };

  /// SHA-256 over a vault's contents. Equal iff the contents are equal.
  ///
  /// Sorted by key first, so the result does not depend on the store's
  /// iteration order, and returns to an earlier value when an edit is undone —
  /// it tracks content rather than counting writes.
  public func ofKeyvals(keyvals : [(Blob, Blob)]) : Blob {
    let sorted = Array.sort<(Blob, Blob)>(keyvals, func(a, b) { Blob.compare(a.0, b.0) });
    let digest = Sha256.new();
    for ((key, value) in sorted.values()) {
      writeFramed(digest, key);
      writeFramed(digest, value);
    };
    digest.sum();
  };

  /// SHA-256 over a trash listing: which secrets are in it, and which version
  /// of each.
  ///
  /// The sequence number is enough to stand for the value. Events are
  /// append-only, so a given `seq` always names the same ciphertext — and the
  /// rows that could have their value cleared belong to live secrets, which are
  /// never in the trash. Hashing the seq rather than the ciphertext keeps this
  /// cheap on the poll path.
  ///
  /// Framed and sorted for the same reasons as {@link ofKeyvals}.
  public func ofTrash(rows : [(Blob, Nat64)]) : Blob {
    let sorted = Array.sort<(Blob, Nat64)>(
      rows,
      func(a, b) {
        let byKey = Blob.compare(a.0, b.0);
        if (byKey != #equal) byKey else Nat64.compare(a.1, b.1);
      },
    );
    let digest = Sha256.new();
    for ((mapKey, seq) in sorted.values()) {
      writeFramed(digest, mapKey);
      digest.writeArray(
        Array.tabulate<Nat8>(8, func(i) { Nat.toNat8(Nat64.toNat((seq >> Nat.toNat64(8 * (7 - i))) & 0xFF)) })
      );
    };
    digest.sum();
  };
};
