import EncryptedMapsCanister "mo:ic-vetkeys/encrypted_maps/Canister";
import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import Types "mo:ic-vetkeys/Types";
import Runtime "mo:core/Runtime";

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
};
