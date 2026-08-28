import EncryptedMapsCanister "mo:ic-vetkeys/encrypted_maps/Canister";
import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Runtime "mo:core/Runtime";
import Map "mo:core/pure/Map";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Char "mo:core/Char";
import List "mo:core/List";

// The whole vault backend (persistent by default via --default-persistent-actors). Every secret is encrypted in the browser under a
// vetKey; this canister only ever sees ciphertext and enforces who may read or
// write which vault.
actor PasswordManager {
  // `transient`: the key name is baked into `encryptedMapsState` at install and
  // never re-read. Local networks provision `test_key_1`; set VETKD_KEY_NAME
  // explicitly for mainnet.
  transient let keyName = Runtime.envVar<system>("VETKD_KEY_NAME") ?? "test_key_1";

  // The domain separator isolates this app's derived keys. Like the key name it
  // must stay stable for the life of the canister — changing either makes every
  // stored secret undecryptable.
  let encryptedMapsState = EncryptedMaps.newEncryptedMapsState<Types.AccessRights>(
    { curve = #bls12_381_g2; name = keyName },
    "pw_manager_vetkeys",
  );

  // Contributes the full endpoint set the @icp-sdk/vetkeys client expects:
  // vetKD key derivation, access control, vault listing, and value storage.
  include EncryptedMapsCanister(encryptedMapsState);

  // ---------------------------------------------------------------------------
  // Vault display names
  //
  // A vault *is* `(owner, mapName)` and its vetKey derives from that pair, so
  // renaming the map would mean decrypting every item, re-encrypting it under a
  // new key, and re-granting every collaborator — non-atomic, and visible to
  // them as the vault disappearing. This keeps the map exactly where it is and
  // stores a display name beside it, so a rename is one write.
  //
  // Purely additive: the mixin above is untouched, and this owns no value
  // endpoints, so there is no per-value state that could fall out of sync with
  // the library's own.
  //
  // The name is stored in the clear, deliberately. Everyone who can see a vault
  // must be able to read its name without deriving a key, or the lazy loading
  // this app depends on is undone. That is the same exposure map names already
  // have — access control has to be enforced in the clear regardless.
  // ---------------------------------------------------------------------------

  /// Bounds a single row. Display names are not key material, so this is about
  /// storage rather than correctness — but unbounded text from any caller is
  /// not something to leave open.
  transient let MAX_DISPLAY_NAME_BYTES = 64;

  func compareVaultIds(a : (Principal, Blob), b : (Principal, Blob)) : {
    #less;
    #greater;
    #equal;
  } {
    let byOwner = Principal.compare(a.0, b.0);
    if (byOwner == #equal) { Blob.compare(a.1, b.1) } else { byOwner };
  };

  /// `(owner, mapName) -> display name`. Absent means "show the map name", so
  /// existing vaults need no migration and nothing has to be backfilled.
  var vaultNames : Map.Map<(Principal, Blob), Text> = Map.empty<(Principal, Blob), Text>();

  public type VaultName = {
    owner : Principal;
    map_name : ByteBuf;
    display_name : Text;
  };

  /// Rename one of *your own* vaults, or clear the name by passing "".
  ///
  /// Owner-only by construction: the row is keyed on `msg.caller`, so there is
  /// no way to address someone else's vault. A collaborator renaming a shared
  /// vault for everyone would be a surprise, and this makes it unrepresentable
  /// rather than merely checked.
  public shared (msg) func set_vault_name(map_name : ByteBuf, display_name : Text) : async Result<(), Text> {
    let trimmed = Text.trim(display_name, #predicate(Char.isWhitespace));
    let id = (msg.caller, map_name.inner);

    // Clearing reverts to the map name, which is the same thing "unset" means.
    if (trimmed == "") {
      vaultNames := vaultNames.remove(compareVaultIds, id);
      return #Ok();
    };

    // Trimmed rather than rejected, unlike map names. A surrounding space in a
    // *map* name addresses a different vault and so must never be silently
    // repaired; a display name carries no identity, so trimming is safe and
    // saves the user a pointless error.
    if (Text.encodeUtf8(trimmed).size() > MAX_DISPLAY_NAME_BYTES) {
      return #Err("A vault name may be at most " # debug_show (MAX_DISPLAY_NAME_BYTES) # " bytes.");
    };

    vaultNames := vaultNames.add(compareVaultIds, id, trimmed);
    #Ok();
  };

  /// Display names for every vault the caller can see, owned and shared.
  ///
  /// One query and **zero key derivations** — the hard requirement. The sidebar
  /// must render names without opening a vault, or lazy loading is undone. Rows
  /// for vaults the caller cannot see are never returned, so a stray row is
  /// invisible as well as harmless.
  public query (msg) func get_vault_names() : async [VaultName] {
    let found = List.empty<VaultName>();

    func collect(owner : Principal, name : Blob) {
      switch (vaultNames.get(compareVaultIds, (owner, name))) {
        case (null) {};
        case (?displayName) {
          List.add(found, { owner; map_name = { inner = name }; display_name = displayName });
        };
      };
    };

    for ((owner, name) in encryptedMaps.getAccessibleSharedMapNames(msg.caller).values()) {
      collect(owner, name);
    };
    for (name in encryptedMaps.getOwnedNonEmptyMapNames(msg.caller).values()) {
      collect(msg.caller, name);
    };

    List.toArray(found);
  };
};
