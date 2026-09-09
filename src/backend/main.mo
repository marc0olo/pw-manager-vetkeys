import VetKdEndpoints "lib/vetkeys/VetKdEndpoints";
import EnumerationEndpoints "lib/vetkeys/EnumerationEndpoints";
import AccessControlReadEndpoints "lib/vetkeys/AccessControlReadEndpoints";
import AccessControlWriteEndpoints "lib/vetkeys/AccessControlWriteEndpoints";
import ValueReadEndpoints "lib/vetkeys/ValueReadEndpoints";
import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Types "types";
import Runtime "mo:core/Runtime";
import Map "mo:core/pure/Map";
import History "lib/History";
import HealthMixin "mixins/Health";
import ValueWritesMixin "mixins/ValueWrites";
import TrashMixin "mixins/Trash";
import HistoryMixin "mixins/History";
import VaultsMixin "mixins/Vaults";

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
  let encryptedMapsState = EncryptedMaps.newEncryptedMapsState<VetKeys.AccessRights>(
    { curve = #bls12_381_g2; name = keyName },
    "pw_manager_vetkeys",
  );

  // The endpoint groups dfinity/vetkeys#443 proposes, built under
  // `lib/vetkeys/` to test its boundaries before the library commits to them
  // (#58). Five are included exactly as the library would provide them; the
  // value **writes** are this application's own and appear further down,
  // because recording the value each write replaced is only possible from
  // inside them.
  //
  // Owning them is an either/or rather than an addition: the `encrypted-maps`
  // skill is explicit that exposing both the library's value mutators and ours
  // desynchronises the two stores.
  //
  // Nothing about the interface changes. Every group delegates to the same
  // `encryptedMaps.*` call the mixin made, with the same signature, so
  // `DefaultEncryptedMapsClient` cannot tell the difference — and
  // `npm run check-bindings` holds that to account, byte-for-byte, against the
  // binding generated before the split.
  //
  // The instance is constructed here and passed to each group rather than each
  // group building its own from the state. Sibling mixins cannot both declare
  // `encryptedMaps`: M0051 rejects a duplicate binding exactly as it rejects a
  // duplicate type, and a `transient let` is no exception — mixin-local
  // implementation details share one namespace with their siblings.
  //
  // Relatedly, though by a different mechanism and without any error:
  // `ByteBuf` and `Result` come from `lib/vetkeys/Types` and are referenced
  // through it rather than aliased here. A local
  // `public type Result<Ok, Err> = Shared.Result<Ok, Err>` compiles fine and
  // leaves the service correct, but declares the type twice, and the generated
  // binding then churns its `Result_N` names. Silent where M0051 above is
  // loud, which is what makes it worth writing down.

  // State comes before the `include`s that take it. An `include` argument is
  // evaluated where it appears, so it cannot name state declared later
  // (M0016) — `transient` makes no difference, and a *function* body can
  // forward-reference freely because it runs later. Each record exists because
  // a mixin takes a `var` by value, so a group's writes to a bare `var` would
  // never reach the actor.

  /// The append-only event log and the sequence it hands out. See lib/Recording.
  let events : Types.EventsState = { var log = History.empty(); var nextSeq = 0 };

  /// Whether the low-balance warning is standing. See lib/Cycles.
  let health : Types.HealthState = { var warnedLowCycles = false };

  /// Vault ownership and the display name each vault carries.
  let vaults : Types.VaultsState = {
    var owned = Map.empty<Principal, Map.Map<Blob, ()>>();
    var names = Map.empty<Principal, Map.Map<Blob, Text>>();
  };

  transient let encryptedMaps = EncryptedMaps.EncryptedMaps(encryptedMapsState, VetKeys.accessRightsOperations());

  include VetKdEndpoints(encryptedMaps);
  include EnumerationEndpoints(encryptedMaps);
  include AccessControlReadEndpoints(encryptedMaps);
  include AccessControlWriteEndpoints(encryptedMaps);
  include ValueReadEndpoints(encryptedMaps);

  // ---------------------------------------------------------------------------
  // This application's own groups
  // ---------------------------------------------------------------------------

  include ValueWritesMixin(encryptedMaps, events, vaults, health);
  include TrashMixin(encryptedMaps, events, health);
  include HistoryMixin(encryptedMaps, events, health);
  include VaultsMixin(encryptedMaps, encryptedMapsState, events, vaults, health);
  include HealthMixin(encryptedMaps, vaults);
};
