/**
 * Trash: what it recovers, and who may see it.
 *
 * `mops test` covers retention and visibility as pure functions of a store.
 * These are the parts that need a replica — that a deleted value really leaves
 * the map, that a restored one still *decrypts*, that read access sees the
 * trash while write access is what recovers from it, and that the listing and
 * the restore path agree about which entries exist.
 */
import { execSync } from "node:child_process";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";
import { idlFactory } from "../src/bindings/declarations/backend.did.js";

const status = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const backendId = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(status.root_key, "hex"));
const enc = new TextEncoder(), dec = new TextDecoder();

const connect = async (identity) => {
  const agent = await HttpAgent.create({ identity, host: status.api_url, rootKey });
  return {
    me: identity.getPrincipal(),
    maps: new EncryptedMaps(new DefaultEncryptedMapsClient(agent, backendId)),
    api: Actor.createActor(idlFactory, { agent, canisterId: backendId }),
  };
};

const failures = [];
const check = (label, pass, detail = "") => {
  if (!pass) failures.push(label);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const buf = (t) => ({ inner: enc.encode(t) });
const trashOf = async (who, owner, name) => {
  const r = await who.api.get_trash(owner, buf(name));
  return "Ok" in r ? r.Ok : { err: r.Err };
};

const alice = Ed25519KeyIdentity.generate();
const A = await connect(alice);
const me = alice.getPrincipal();
const bobId = Ed25519KeyIdentity.generate();
const B = await connect(bobId);
const NAME = "Personal", N = enc.encode(NAME);

await A.maps.setValue(me, N, enc.encode("k1"), enc.encode("secret one"));
await A.maps.setValue(me, N, enc.encode("k2"), enc.encode("secret two"));
await A.maps.setUserRights(me, N, bobId.getPrincipal(), { ReadWrite: null });

// ---- deleting moves rather than destroys ------------------------------------
await B.maps.removeEncryptedValue(me, N, enc.encode("k1"));
const live = await A.maps.getValuesForMap(me, N);
check("a deleted item leaves the vault", live.length === 1, `${live.length} left`);
check("and appears in the owner's trash", (await trashOf(A, me, NAME)).length === 1);

// ---- restore returns something that still decrypts --------------------------
const restored = await B.api.restore_trashed_value(me, buf(NAME), buf("k1"));
check("a collaborator with write access can restore it", "Ok" in restored, JSON.stringify(restored));
const after = await A.maps.getValuesForMap(me, N);
const back = after.find(([k]) => dec.decode(k) === "k1");
check(
  "and the restored value still decrypts to the original",
  back !== undefined && dec.decode(back[1]) === "secret one",
  back ? dec.decode(back[1]) : "missing",
);
check("trash is empty again", (await trashOf(A, me, NAME)).length === 0);

// ---- the listing must not carry ciphertext ----------------------------------
await A.maps.removeEncryptedValue(me, N, enc.encode("k2"));
const rows = await trashOf(A, me, NAME);
// The listing carries the ciphertext, so a client can show what an item was.
// #14's rule is that values never ride the *poll*; this is user-initiated and
// scoped to one vault, the same profile as opening it.
check("the listing carries the value", rows[0].value.inner.length > 0);
check("which still decrypts to the original",
  dec.decode(await A.maps.decryptFor(me, N, enc.encode("k2"), Uint8Array.from(rows[0].value.inner))) === "secret two");
check("and says who deleted it and when",
  rows[0].deleted_by.compareTo(me) === "eq" && rows[0].deleted_at > 0n);
await A.api.restore_trashed_value(me, buf(NAME), buf("k2"));

// ---- a wipe trashes everything, and restores as one -------------------------
await B.maps.removeMapValues(me, N);
check("a wipe empties the vault", (await A.maps.getValuesForMap(me, N)).length === 0);
check("and trashes every item", (await trashOf(A, me, NAME)).length === 2);

const bulk = await A.api.restore_trashed_values(me, buf(NAME));
check("the owner can undo a collaborator's wipe in one call", "Ok" in bulk && bulk.Ok === 2n,
  JSON.stringify(bulk, (_, v) => (typeof v === "bigint" ? String(v) : v)));
const recovered = await A.maps.getValuesForMap(me, N);
check("with both values intact",
  recovered.length === 2 && recovered.every(([, v]) => dec.decode(v).startsWith("secret")),
  `${recovered.length} items`);

// ---- the count in the poll, and reaching trash in an emptied vault ----------
//
// Asserting the count is *zero* would have passed even if it never worked, and
// did: manual testing found the owner seeing no trash at all. The cause was
// that an emptied owned vault leaves the library's listing (#11), taking its
// trash out of reach exactly when recovery matters most.
const summaryFor = async (who) =>
  (await who.api.get_vault_summaries()).find(
    (v) => dec.decode(Uint8Array.from(v.map_name.inner)) === NAME,
  );
{
  check("the poll reports no trash when there is none", Number((await summaryFor(A)).trashed) === 0);

  await A.maps.removeEncryptedValue(me, N, enc.encode("k1"));
  const after = await summaryFor(A);
  check("and a non-zero count once something is deleted", Number(after.trashed) > 0, String(after.trashed));

  // Empty it completely: every item deleted, nothing live left.
  await A.maps.removeMapValues(me, N);
  const emptied = await summaryFor(A);
  check(
    "a vault holding only trash is still listed to its owner",
    emptied !== undefined,
    emptied === undefined ? "vault vanished with its trash" : "",
  );
  check("with no items", emptied !== undefined && emptied.item_keys.length === 0);
  check("and its trash still reachable", emptied !== undefined && Number(emptied.trashed) > 0, String(emptied?.trashed));
  check("so it can be restored from", "Ok" in (await A.api.restore_trashed_values(me, buf(NAME))));
}

// ---- trash is scoped to the vault, not to who deleted the item -------------
//
// The invariant: what `get_trash` lists is what `restore_trashed_values` can
// recover. Both are the vault's entries, gated on reading and on writing
// respectively. Listing *less* than the restore path recovers would hide
// entries without protecting them — a member could restore what they were not
// shown, and then read it.
await A.maps.removeEncryptedValue(me, N, enc.encode("k1"));
const carolId = Ed25519KeyIdentity.generate();
const C = await connect(carolId);
await A.maps.setUserRights(me, N, carolId.getPrincipal(), { ReadWrite: null });

check("the owner sees the vault's trash", (await trashOf(A, me, NAME)).length === 1);
check("so does a collaborator who did not delete it", (await trashOf(B, me, NAME)).length === 1);
check("including one added after the deletion", (await trashOf(C, me, NAME)).length === 1);

{
  // The property, stated as a comparison rather than as two separate counts:
  // whatever the listing shows, the restore path recovers exactly that.
  const listed = (await trashOf(C, me, NAME)).length;
  const recovered = await C.api.restore_trashed_values(me, buf(NAME));
  check(
    "and recovers exactly what it was shown — no hidden entries",
    "Ok" in recovered && Number(recovered.Ok) === listed,
    `listed ${listed}, restored ${JSON.stringify(recovered, (_, v) => (typeof v === "bigint" ? String(v) : v))}`,
  );
}

// ---- reading is not recovering ---------------------------------------------
await A.maps.removeEncryptedValue(me, N, enc.encode("k1"));
const danaId = Ed25519KeyIdentity.generate();
const D = await connect(danaId);
await A.maps.setUserRights(me, N, danaId.getPrincipal(), { Read: null });

check("a read-only member sees what was deleted", (await trashOf(D, me, NAME)).length === 1);
check(
  "but cannot restore it",
  "Err" in (await D.api.restore_trashed_value(me, buf(NAME), buf("k1"))),
);
check(
  "nor in bulk",
  "Err" in (await D.api.restore_trashed_values(me, buf(NAME))),
);

// The disclosure this rule actually makes, asserted rather than described.
//
// For a write-holder, vault-scoped trash reveals nothing new — they could
// already restore the whole vault and read it. For a `Read` member it is new:
// they hold the vault key, so the ciphertext decrypts, and Dana was granted
// access *after* the deletion. There is no version of this where the listing
// is shown and the value stays unreadable, which is exactly what makes it a
// decision rather than an oversight.
{
  const rows = await trashOf(D, me, NAME);
  const plain = new TextDecoder().decode(
    await D.maps.decryptFor(me, N, enc.encode("k1"), Uint8Array.from(rows[0].value.inner)),
  );
  check(
    "and can decrypt a secret destroyed before they had access",
    plain === "secret one",
    `read ${JSON.stringify(plain)} — the accepted cost of vault-scoped trash`,
  );
}
// ---- revocation closes the window immediately -------------------------------
//
// The rule is asked on every read rather than recorded when the entry was made,
// so losing the vault loses its trash. This is what would break if `canRead`
// were ever replaced by something inferred from `deletedBy`.
await A.maps.removeUser(me, N, danaId.getPrincipal());
const revoked = await trashOf(D, me, NAME);
check("a revoked member sees nothing at all", revoked.err === "unauthorized", JSON.stringify(revoked));

const stranger = await connect(Ed25519KeyIdentity.generate());
const denied = await trashOf(stranger, me, NAME);
check("someone with no access to the vault is refused outright", denied.err === "unauthorized", JSON.stringify(denied));

// ---- emptying the trash, the remedy before sharing --------------------------
//
// Trash being vault-scoped means granting access hands over the trash too, so
// there has to be a way to put a secret out of reach *before* the grant. Time
// is otherwise the only remedy.
{
  check("there is something to discard", (await trashOf(A, me, NAME)).length > 0);
  const reader = await connect(Ed25519KeyIdentity.generate());
  await A.maps.setUserRights(me, N, reader.me, { Read: null });
  const refused = await reader.api.discard_trash(me, buf(NAME));
  check("a read-only member cannot empty the trash", "Err" in refused, JSON.stringify(refused));

  const dropped = await A.api.discard_trash(me, buf(NAME));
  check("the owner can", "Ok" in dropped, JSON.stringify(dropped, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  check("and the trash is empty", (await trashOf(A, me, NAME)).length === 0);
  check("with nothing left to restore",
    "Ok" in (await A.api.restore_trashed_values(me, buf(NAME))) &&
      (await A.maps.getValuesForMap(me, N)).every(([k]) => dec.decode(k) !== "k1"));
  check("the poll count agrees", Number((await summaryFor(A)).trashed ?? 0) === 0);

  // Scoped to the vault: another vault's trash is untouched. Otherwise
  // emptying one vault before sharing it would destroy recovery everywhere.
  const OTHER = "Work", O = enc.encode(OTHER);
  await A.maps.setValue(me, O, enc.encode("w1"), enc.encode("other secret"));
  await A.maps.removeEncryptedValue(me, O, enc.encode("w1"));
  await A.api.discard_trash(me, buf(NAME));
  check("emptying one vault's trash leaves another's alone", (await trashOf(A, me, OTHER)).length === 1);
}

console.log(
  failures.length === 0
    ? "\nDeletions are recoverable, restored values still decrypt, and the listing and the restore path agree."
    : `\n${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
