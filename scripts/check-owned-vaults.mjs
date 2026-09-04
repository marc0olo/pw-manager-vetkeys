/**
 * The owned-vault registry: a vault that exists while holding nothing.
 *
 * The library drops an owned map from its enumeration as soon as the map's last
 * value goes, so these are the claims that need a replica: that a vault
 * survives being emptied, that one can exist before anything is in it, and that
 * the registry is *unioned* with the library's listing rather than replacing it
 * — a map with no registry entry must still be visible to its owner.
 */
import { execSync } from "node:child_process";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";
import { idlFactory } from "../src/bindings/declarations/backend.did.js";
import { reportCycles } from "./lib/cycles.mjs";

// Running these checks is what drains the canister; see scripts/lib/cycles.mjs.
const cycles = reportCycles();

const status = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const backendId = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(status.root_key, "hex"));
const enc = new TextEncoder(), dec = new TextDecoder();

let derivations = 0;
const connect = async (identity) => {
  const agent = await HttpAgent.create({ identity, host: status.api_url, rootKey });
  const raw = new DefaultEncryptedMapsClient(agent, backendId);
  const real = raw.get_encrypted_vetkey.bind(raw);
  raw.get_encrypted_vetkey = (...args) => {
    derivations++;
    return real(...args);
  };
  return {
    me: identity.getPrincipal(),
    maps: new EncryptedMaps(raw),
    api: Actor.createActor(idlFactory, { agent, canisterId: backendId }),
  };
};

const failures = [];
const check = (label, pass, detail = "") => {
  if (!pass) failures.push(label);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const buf = (t) => ({ inner: enc.encode(t) });
const owned = async (who) => (await who.api.get_owned_vaults()).map((b) => dec.decode(Uint8Array.from(b.inner)));
const listed = async (who) =>
  (await who.api.get_vault_summaries()).map((v) => `${v.owner.toText().slice(0, 5)}/${dec.decode(Uint8Array.from(v.map_name.inner))}`);
const summaryFor = async (who, owner, name) =>
  (await who.api.get_vault_summaries()).find(
    (v) => v.owner.compareTo(owner) === "eq" && dec.decode(Uint8Array.from(v.map_name.inner)) === name,
  );
/** SHA-256 of nothing, which is what an empty vault's digest has to be. */
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const hex = (bytes) => Buffer.from(Uint8Array.from(bytes)).toString("hex");

const aliceId = Ed25519KeyIdentity.generate();
const A = await connect(aliceId);
const me = aliceId.getPrincipal();
const bobId = Ed25519KeyIdentity.generate();
const B = await connect(bobId);

// ---- a vault can exist holding nothing --------------------------------------
check("a new principal owns no vaults", (await owned(A)).length === 0);

derivations = 0;
check("creating one succeeds", "Ok" in (await A.api.create_vault(buf("Empty"))));
check("and derives no key", derivations === 0, `${derivations} derivations`);
check("it is now owned", (await owned(A)).includes("Empty"));

const empty = await summaryFor(A, me, "Empty");
check("and listed, though the library does not know it", empty !== undefined);
check("with no items", empty !== undefined && empty.item_keys.length === 0);
check("the digest of nothing", empty !== undefined && hex(empty.digest.inner) === EMPTY, hex(empty?.digest.inner ?? []));
check("no trash, and the digest of no trash", empty !== undefined && Number(empty.trashed) === 0 && hex(empty.trash_digest.inner) === EMPTY);
check("and full rights, since the caller owns it", empty !== undefined && "ReadWriteManage" in empty.my_rights[0]);

// The other read path over per-item facts has to survive a vault with no items.
const facts = await A.api.get_item_summaries(me, buf("Empty"));
check("per-item facts on an empty vault are empty, not an error", "Ok" in facts && facts.Ok.length === 0, JSON.stringify(facts));
check("its trash is empty, not an error", "Ok" in (await A.api.get_trash(me, buf("Empty"))));

// ---- creating is idempotent --------------------------------------------------
check("creating the same vault again succeeds", "Ok" in (await A.api.create_vault(buf("Empty"))));
check("and does not duplicate it", (await owned(A)).filter((n) => n === "Empty").length === 1);

// ---- registration cannot refuse ---------------------------------------------
//
// The gap this closes, measured before the fix: with registration bounded by
// the claim cap, a write past it went unregistered — and once that vault was
// emptied it left the library's enumeration too, so its owner could not see it
// and its trash was unreachable. A stranded recovery path is what #34 and #39
// exist to prevent, so the only safe registration is one that cannot decline.
//
// Bounding it also bought nothing: the library keeps no cap on maps per owner,
// so those writes already made the canister store the maps themselves.
{
  const capped = await connect(Ed25519KeyIdentity.generate());
  for (let i = 0; i < 100; i++) await capped.api.create_vault(buf(`c${i}`));
  check("this principal is at the claim cap", (await owned(capped)).length === 100);
  check("so claiming another is refused", "Err" in (await capped.api.create_vault(buf("Claimed"))));

  // A write is not a claim, and must still register.
  await capped.maps.setValue(capped.me, enc.encode("Beyond"), enc.encode("k1"), enc.encode("worth recovering"));
  check("but writing past the cap still registers the vault", (await owned(capped)).includes("Beyond"));

  await capped.maps.removeEncryptedValue(capped.me, enc.encode("Beyond"), enc.encode("k1"));
  const beyond = await summaryFor(capped, capped.me, "Beyond");
  check("so emptying it does not hide it from its owner", beyond !== undefined);
  check(
    "and its trash is still reachable",
    beyond !== undefined && Number(beyond.trashed) === 1,
    "unreachable trash is a destroyed secret as far as recovery is concerned",
  );
}

// ---- the union still carries a map the registry never saw -------------------
//
// Not reachable through the API any more — that is the point of registration
// being unconditional — so this asserts the surviving direction rather than the
// legacy one: a vault with values is listed whether or not it has an entry,
// because the library's enumeration is unioned in rather than replaced.
//
// The legacy case the union cannot carry (emptied before the registry existed,
// so no entry and no values) is why this ships with a reinstall.
await A.maps.setValue(me, enc.encode("Unregistered"), enc.encode("k1"), enc.encode("v1"));
check("a vault with values is listed", (await summaryFor(A, me, "Unregistered")) !== undefined);
check("and is registered by that write", (await owned(A)).includes("Unregistered"));

// ---- an emptied vault survives ----------------------------------------------
await A.maps.setValue(me, enc.encode("Emptied"), enc.encode("k1"), enc.encode("secret"));
await A.maps.removeEncryptedValue(me, enc.encode("Emptied"), enc.encode("k1"));
const emptied = await summaryFor(A, me, "Emptied");
check("an emptied vault is still listed", emptied !== undefined);
check("with its trash reachable", emptied !== undefined && Number(emptied.trashed) === 1, String(emptied?.trashed));

// ---- the emptied-and-shared vault reports its collaborators ------------------
//
// The bug the trash-driven version had: it reported no members, so the owner's
// share dialog said "Only you." for a vault that was shared — exactly when they
// might want to revoke whoever emptied it.
await A.maps.setValue(me, enc.encode("Shared"), enc.encode("k1"), enc.encode("secret"));
await A.maps.setUserRights(me, enc.encode("Shared"), bobId.getPrincipal(), { ReadWrite: null });
await B.maps.removeMapValues(me, enc.encode("Shared"));
const shared = await summaryFor(A, me, "Shared");
check("a collaborator emptying a vault does not hide it from its owner", shared !== undefined);
check(
  "and the owner still sees who has access",
  shared !== undefined && shared.access_control.length === 1,
  `${shared?.access_control.length ?? 0} members — 0 was the bug`,
);

// ---- scoped to the caller ----------------------------------------------------
check("a vault shared with someone is not theirs to own", !(await owned(B)).includes("Shared"));
check("but they can see it", (await listed(B)).some((v) => v.endsWith("/Shared")));
const stranger = await connect(Ed25519KeyIdentity.generate());
check("someone else's vaults are not listed to a stranger", (await listed(stranger)).length === 0);
check("nor owned by them", (await owned(stranger)).length === 0);

// ---- bounded, and anonymous callers refused ----------------------------------
{
  const anonModule = await import("@icp-sdk/core/agent");
  const anon = await connect(new anonModule.AnonymousIdentity());
  check("an anonymous caller cannot create a vault", "Err" in (await anon.api.create_vault(buf("Anon"))));
}
check("an empty name is refused", "Err" in (await A.api.create_vault({ inner: new Uint8Array() })));
check("a name over 32 bytes is refused", "Err" in (await A.api.create_vault(buf("x".repeat(33)))));
check("32 bytes exactly is accepted", "Ok" in (await A.api.create_vault(buf("x".repeat(32)))));

{
  const hoarder = await connect(Ed25519KeyIdentity.generate());
  let refusedAt = null;
  for (let i = 0; i < 105; i++) {
    if ("Err" in (await hoarder.api.create_vault(buf(`v${i}`)))) {
      refusedAt = i;
      break;
    }
  }
  check("a principal cannot claim unbounded vaults", refusedAt === 100, `refused at ${refusedAt}`);
  // Re-claiming one they already have must not be turned away by the cap.
  check("but re-creating one they hold still succeeds", "Ok" in (await hoarder.api.create_vault(buf("v0"))));
}

// ---- deleting a vault takes everything with it ------------------------------
//
// One update message, so there is no half-deleted state: #21's design assumed
// the client would wipe and then revoke per grantee, which could fail partway.
// Owning the endpoints removes that.
{
  const D = await connect(Ed25519KeyIdentity.generate());
  const dId = D.me;
  const V = enc.encode("Doomed");
  await D.maps.setValue(dId, V, enc.encode("k1"), enc.encode("v1"));
  await D.maps.setValue(dId, V, enc.encode("k1"), enc.encode("v2")); // a version
  await D.maps.setValue(dId, V, enc.encode("k2"), enc.encode("trash me"));
  await D.maps.removeEncryptedValue(dId, V, enc.encode("k2"));       // a trash row
  await D.api.set_vault_name(buf("Doomed"), "Work stuff");
  await D.maps.setUserRights(dId, V, bobId.getPrincipal(), { ReadWrite: null });

  check("it is there, shared, named, with history and trash",
    (await summaryFor(D, dId, "Doomed")) !== undefined &&
      (await D.api.get_trash(dId, buf("Doomed"))).Ok.length === 1 &&
      (await D.api.get_history(dId, buf("Doomed"), buf("k1"))).Ok.length >= 1 &&
      (await D.api.get_vault_names()).some((r) => r.display_name === "Work stuff"));

  // Not an ownership check that could be got wrong: `delete_vault` names the
  // caller as the owner, so a collaborator asking to delete "Doomed" asks about
  // *their own* vault of that name, which does not exist.
  const refusedByGrantee = await B.api.delete_vault(buf("Doomed"));
  check("a collaborator cannot reach the owner's vault at all", "Err" in refusedByGrantee, JSON.stringify(refusedByGrantee));
  check("and the owner's vault is untouched by their attempt", (await summaryFor(D, dId, "Doomed")) !== undefined);

  check("the owner can", "Ok" in (await D.api.delete_vault(buf("Doomed"))));
  check("it is gone from the listing", (await summaryFor(D, dId, "Doomed")) === undefined);
  check("and from the registry", !(await owned(D)).includes("Doomed"));
  check("its trash is gone, not stranded", (await D.api.get_trash(dId, buf("Doomed"))).Ok?.length === 0);
  check("its history too", (await D.api.get_history(dId, buf("Doomed"), buf("k1"))).Ok.length === 0);
  check("its display name does not outlive it",
    !(await D.api.get_vault_names()).some((r) => r.display_name === "Work stuff"),
    "or it would reappear on a vault later created with the same name");
  check("and the collaborator no longer sees it", !(await listed(B)).some((v) => v.endsWith("/Doomed")));

  check("deleting one that does not exist is refused", "Err" in (await D.api.delete_vault(buf("Never"))));
  // A vault claimed but never written to is still deletable.
  await D.api.create_vault(buf("Claimed"));
  check("a vault holding nothing can be deleted", "Ok" in (await D.api.delete_vault(buf("Claimed"))));
}

// ---- two of your vaults may not show the same label -------------------------
//
// Not tidiness. The empty-vault and delete-vault confirmations arm on the typed
// label matching the vault's, and delete is irreversible — so two vaults called
// "Work" turn that confirmation into something the user is deliberate about a
// *name* over rather than a vault. Reachable only since vaults can be created,
// which is why the rule arrives with them.
{
  const N = await connect(Ed25519KeyIdentity.generate());
  await N.api.create_vault(buf("v-one"));
  await N.api.create_vault(buf("v-two"));
  check("naming the first succeeds", "Ok" in (await N.api.set_vault_name(buf("v-one"), "Work")));

  const dup = await N.api.set_vault_name(buf("v-two"), "Work");
  check("naming a second one the same is refused", "Err" in dup, JSON.stringify(dup));
  check("and trimming does not sneak it past", "Err" in (await N.api.set_vault_name(buf("v-two"), "  Work  ")));
  check("a different name is fine", "Ok" in (await N.api.set_vault_name(buf("v-two"), "Home")));

  // Renaming a vault to the label it already has is not a collision with itself.
  check("re-applying a vault's own name succeeds", "Ok" in (await N.api.set_vault_name(buf("v-one"), "Work")));
  // Clearing reverts to the map name and cannot collide.
  check("clearing a name is refused, not a way to revert to the map id",
    "Err" in (await N.api.set_vault_name(buf("v-two"), "")));
  check(
    "and a label another vault holds stays refused",
    "Err" in (await N.api.set_vault_name(buf("v-two"), "Work")),
    "v-one has it",
  );

  // A vault can still be unnamed — creating one is two calls, and a failure
  // between them leaves the label as the id until someone renames it. Such a
  // vault renders as its map name, so a display name equal to that collides on
  // screen just as surely as a duplicate display name would. `v-four` is left
  // unnamed to model exactly that.
  await N.api.create_vault(buf("v-four"));
  await N.api.create_vault(buf("v-five"));
  const asMapName = await N.api.set_vault_name(buf("v-five"), "v-four");
  check("a name equal to an unnamed vault's map name is refused", "Err" in asMapName, JSON.stringify(asMapName));

  // Case-sensitive on purpose: refusing a name for a difference the user cannot
  // see is its own problem, and normalisation has no clean answer.
  check("but a different case is allowed", "Ok" in (await N.api.set_vault_name(buf("v-three"), "work")));

  // Per owner. Someone else calling theirs "Work" is not a collision — the
  // sidebar separates owned from shared and names the sharer.
  const other = await connect(Ed25519KeyIdentity.generate());
  await other.api.create_vault(buf("theirs"));
  check("another principal may use the same label", "Ok" in (await other.api.set_vault_name(buf("theirs"), "Work")));
}

// ---- reading it costs nothing ------------------------------------------------
derivations = 0;
await A.api.get_owned_vaults();
await A.api.get_vault_summaries();
check("listing owned vaults and polling derive no keys", derivations === 0, `${derivations} derivations`);

console.log(
  failures.length === 0
    ? "\nAn owned vault exists once claimed, survives being emptied, and a map with no registry entry is still visible to its owner."
    : `\n${failures.length} failure(s)`,
);
cycles.done();
process.exit(failures.length === 0 ? 0 : 1);
