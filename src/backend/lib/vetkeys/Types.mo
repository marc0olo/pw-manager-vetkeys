/// The types every endpoint group shares.
///
/// Extracted because two mixins cannot declare the same type (M0051), so the
/// groups can only be siblings if exactly one place declares `ByteBuf` and
/// `Result`. This is the prerequisite dfinity/vetkeys#443 names, built here to
/// check it holds at fifteen endpoints rather than the two a probe covers.
module {
  /// Matches the Rust canister's representation: a bare `Blob` cannot be
  /// serialised efficiently there without nesting it.
  public type ByteBuf = { inner : Blob };

  public type Result<Ok, Err> = { #Ok : Ok; #Err : Err };
};
