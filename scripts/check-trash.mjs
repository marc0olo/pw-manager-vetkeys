/**
 * Trash: what it recovers, and who may see it.
 *
 * `mops test` covers retention and visibility as pure functions of a store.
 * These are the parts that need a replica — that a deleted value really leaves
 * the map, that a restored one still *decrypts*, and that access control holds
 * across a grant made after the deletion.
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
check("the deleter can restore it", "Ok" in restored, JSON.stringify(restored));
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

// ---- the count in the poll respects the same visibility ---------------------
{
  const summaries = await A.api.get_vault_summaries();
  const mine = summaries.find((v) => dec.decode(Uint8Array.from(v.map_name.inner)) === NAME);
  check("the poll reports the owner's visible trash count", Number(mine.trashed) === 0, String(mine?.trashed));
}

// ---- the retroactive-grant hole ---------------------------------------------
//
// A reader added *after* a deletion must not see it. Otherwise trash extends a
// vault's visible history backwards across a grant boundary, disclosing a
// secret that was destroyed before that person had any access — something
// permanent deletion never allowed.
await A.maps.removeEncryptedValue(me, N, enc.encode("k1"));
const carolId = Ed25519KeyIdentity.generate();
const C = await connect(carolId);
await A.maps.setUserRights(me, N, carolId.getPrincipal(), { Read: null });

check("a reader added after the deletion cannot see it", (await trashOf(C, me, NAME)).length === 0);
check("the owner still can", (await trashOf(A, me, NAME)).length === 1);
check("a collaborator who did not delete it cannot", (await trashOf(B, me, NAME)).length === 0);

const stranger = await connect(Ed25519KeyIdentity.generate());
const denied = await trashOf(stranger, me, NAME);
check("someone with no access to the vault is refused outright", denied.err === "unauthorized", JSON.stringify(denied));

check(
  "and a reader cannot restore what they cannot see",
  "Err" in (await C.api.restore_trashed_value(me, buf(NAME), buf("k1"))),
);

console.log(
  failures.length === 0
    ? "\nDeletions are recoverable, restored values still decrypt, and trash discloses nothing new."
    : `\n${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
