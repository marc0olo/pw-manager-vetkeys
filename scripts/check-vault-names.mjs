/**
 * Vault display names: renaming without moving the map.
 *
 * A script rather than a unit test because every claim is the canister's:
 * that a rename is visible to collaborators, that it costs no key derivation
 * (the whole point — the sidebar must render names without opening a vault),
 * and that nobody can rename a vault they do not own.
 */
import { execSync } from "node:child_process";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";

const status = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const backendId = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(status.root_key, "hex"));
const enc = new TextEncoder();

const idl = ({ IDL }) => {
  const ByteBuf = IDL.Record({ inner: IDL.Vec(IDL.Nat8) });
  const VaultName = IDL.Record({
    owner: IDL.Principal,
    map_name: ByteBuf,
    display_name: IDL.Text,
  });
  return IDL.Service({
    set_vault_name: IDL.Func([ByteBuf, IDL.Text], [IDL.Variant({ Ok: IDL.Null, Err: IDL.Text })], []),
    get_vault_names: IDL.Func([], [IDL.Vec(VaultName)], ["query"]),
  });
};

let derivations = 0;
async function connect(identity) {
  const agent = await HttpAgent.create({ identity, host: status.api_url, rootKey });
  const raw = new DefaultEncryptedMapsClient(agent, backendId);
  const real = raw.get_encrypted_vetkey.bind(raw);
  raw.get_encrypted_vetkey = (...args) => {
    derivations++;
    return real(...args);
  };
  return { maps: new EncryptedMaps(raw), names: Actor.createActor(idl, { agent, canisterId: backendId }) };
}

const failures = [];
const check = (label, pass, detail = "") => {
  if (!pass) failures.push(label);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const bytes = (text) => ({ inner: Array.from(enc.encode(text)) });
const nameFor = (rows, text) =>
  rows.find((r) => new TextDecoder().decode(Uint8Array.from(r.map_name.inner)) === text)?.display_name;

const alice = Ed25519KeyIdentity.generate();
const A = await connect(alice);
const me = alice.getPrincipal();
const bob = Ed25519KeyIdentity.generate();
const B = await connect(bob);

await A.maps.setValue(me, enc.encode("Personal"), enc.encode("i1"), enc.encode("{}"));
await A.maps.setUserRights(me, enc.encode("Personal"), bob.getPrincipal(), { Read: null });

// ---- a rename is one write, and moves nothing ------------------------------
check("a vault with no display name returns no row", (await A.names.get_vault_names()).length === 0);

const set = await A.names.set_vault_name(bytes("Personal"), "Home 🔐");
check("the owner can name their vault", "Ok" in set, JSON.stringify(set));
check("the name comes back", nameFor(await A.names.get_vault_names(), "Personal") === "Home 🔐");

// The map is untouched, so the key still decrypts what it always did.
derivations = 0;
const items = await A.maps.getValuesForMap(me, enc.encode("Personal"));
check("the items are still readable after the rename", items.length === 1, `${items.length} items`);

// ---- the hard requirement: naming costs no derivation ----------------------
derivations = 0;
await A.names.get_vault_names();
await B.names.get_vault_names();
check("reading names derives no keys", derivations === 0, `${derivations} derivations`);

// ---- collaborators see the same name ---------------------------------------
check(
  "a grantee sees the owner's chosen name",
  nameFor(await B.names.get_vault_names(), "Personal") === "Home 🔐",
);

const stranger = await connect(Ed25519KeyIdentity.generate());
check("someone with no access sees nothing", (await stranger.names.get_vault_names()).length === 0);

// ---- owner-only, by construction -------------------------------------------
await B.names.set_vault_name(bytes("Personal"), "Bob was here");
check(
  "a grantee cannot rename a vault they do not own",
  nameFor(await A.names.get_vault_names(), "Personal") === "Home 🔐",
  "the owner's name is unchanged",
);
check(
  "and their write does not surface for anyone",
  nameFor(await B.names.get_vault_names(), "Personal") === "Home 🔐",
);

// ---- editing and clearing ---------------------------------------------------
await A.names.set_vault_name(bytes("Personal"), "  Work notes  ");
check(
  "surrounding whitespace is trimmed, not rejected — it carries no identity here",
  nameFor(await A.names.get_vault_names(), "Personal") === "Work notes",
);

await A.names.set_vault_name(bytes("Personal"), "   ");
check("an empty name clears the row, reverting to the map name",
  (await A.names.get_vault_names()).length === 0);

// ---- bounded ----------------------------------------------------------------
const tooLong = await A.names.set_vault_name(bytes("Personal"), "x".repeat(65));
check("a name over 64 bytes is refused", "Err" in tooLong, JSON.stringify(tooLong));
const atCap = await A.names.set_vault_name(bytes("Personal"), "x".repeat(64));
check("64 bytes exactly is accepted", "Ok" in atCap);
const emojiTooLong = await A.names.set_vault_name(bytes("Personal"), "🔐".repeat(17));
check("the cap counts bytes, not characters", "Err" in emojiTooLong, "17 emoji is 68 bytes");

// ---- a name survives the vault going empty ----------------------------------
await A.names.set_vault_name(bytes("Personal"), "Home");
await A.maps.removeMapValues(me, enc.encode("Personal"));
check(
  "an emptied owned vault loses its name row from the listing (#11 placeholder territory)",
  nameFor(await A.names.get_vault_names(), "Personal") === undefined,
);
await A.maps.setValue(me, enc.encode("Personal"), enc.encode("i2"), enc.encode("{}"));
check(
  "but the row survives, so refilling the vault restores its name",
  nameFor(await A.names.get_vault_names(), "Personal") === "Home",
);

console.log(
  failures.length === 0
    ? "\nRenaming moves no map, costs no derivation, and only the owner can do it."
    : `\n${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
