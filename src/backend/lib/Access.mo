import EncryptedMaps "mo:ic-vetkeys/encrypted_maps/EncryptedMaps";
import VetKeys "mo:ic-vetkeys/Types";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Map "mo:core/pure/Map";

/// Who may see what, for the questions the library will not answer.
///
/// A module because both are asked from several groups — trash reads, the poll,
/// the health gate — so neither belongs to one of them.
module {
  /// Whether the caller may read this vault, which is the whole of the trash
  /// authorization: trash is a property of the vault, so anyone who can read
  /// the vault can read what has been deleted from it.
  ///
  /// Asked on every trash read rather than recorded when the entry was made, so
  /// revocation takes effect immediately — a collaborator who deleted an item
  /// and was later removed keeps no window onto the vault through its trash.
  public func canRead(
    encryptedMaps : EncryptedMaps.EncryptedMaps<VetKeys.AccessRights>,
    who : Principal,
    owner : Principal,
    mapName : Blob,
  ) : Bool {
    if (who.equal(owner)) return true;
    for ((sharedOwner, sharedName) in encryptedMaps.getAccessibleSharedMapNames(who).values()) {
      if (sharedOwner.equal(owner) and sharedName.equal(mapName)) return true;
    };
    false;
  };

  /// What *this caller* may do on this vault.
  ///
  /// Reads `keyManagerState.accessControl` directly, because `get_user_rights`
  /// requires `ReadWriteManage` — which is the upstream defect
  /// (dfinity/vetkeys#438). That makes this a workaround rather than a fix: it
  /// depends on the library's internal shape, so a change upstream breaks it
  /// loudly at compile time, which is the failure mode we want.
  public func rightsOf(
    state : EncryptedMaps.EncryptedMapsState<VetKeys.AccessRights>,
    caller : Principal,
    mapOwner : Principal,
    mapName : Blob,
  ) : ?VetKeys.AccessRights {
    // Ownership is identity-derived rather than an ACL entry, so it is not in
    // the map to look up.
    if (caller.equal(mapOwner)) return ?(#ReadWriteManage);

    switch (state.keyManager.accessControl.get(Principal.compare, caller)) {
      case (null) { null };
      case (?entries) {
        for (((owner, name), rights) in entries.values()) {
          if (owner.equal(mapOwner) and name.equal(mapName)) return ?rights;
        };
        null;
      };
    };
  };
};
