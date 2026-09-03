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
// The binding the app itself ships, generated from the canister's Candid.
// Importing it rather than restating it is the point: this script used to
// declare its own copy, so it verified the canister while exercising a
// different interface than the frontend.
import { idlFactory } from "../src/bindings/declarations/backend.did.js";
// The cap the client enforces, imported rather than restated, so the checks
// below verify the canister agrees with it. Candid cannot carry a constant, so
// this is the one value the generated binding leaves hand-synced with main.mo.
import { MAX_DISPLAY_NAME_BYTES } from "../src/frontend/lib/backend.ts";

const status = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const backendId = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(status.root_key, "hex"));
const enc = new TextEncoder();


let derivations = 0;
async function connect(identity) {
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
    names: Actor.createActor(idlFactory, { agent, canisterId: backendId }),
  };
}

const failures = [];
const check = (label, pass, detail = "") => {
  if (!pass) failures.push(label);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const bytes = (text) => ({ inner: Array.from(enc.encode(text)) });
/**
 * Owner *and* name, because they are jointly the identity. Matching on the name
 * alone conflates two different vaults that happen to share one — which is the
 * whole reason display names exist.
 */
const nameFor = (rows, owner, text) =>
  rows.find(
    (r) =>
      r.owner.compareTo(owner) === "eq" &&
      new TextDecoder().decode(Uint8Array.from(r.map_name.inner)) === text,
  )?.display_name;

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
check("the name comes back", nameFor(await A.names.get_vault_names(), me, "Personal") === "Home 🔐");

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
  nameFor(await B.names.get_vault_names(), me, "Personal") === "Home 🔐",
);

const stranger = await connect(Ed25519KeyIdentity.generate());
check("someone with no access sees nothing", (await stranger.names.get_vault_names()).length === 0);

// ---- owner-only, by construction -------------------------------------------
await B.names.set_vault_name(bytes("Personal"), "Bob was here");
check(
  "a grantee cannot rename a vault they do not own",
  nameFor(await A.names.get_vault_names(), me, "Personal") === "Home 🔐",
  "the owner's name is unchanged",
);
// Bob's write does land, and it *is* returned to Bob — as a row keyed
// `(Bob, "Personal")`, his own data, for a vault he does not have. What matters
// is that it can never be joined onto anything: the client matches a name to a
// vault by owner *and* name, so only the owner's row attaches.
//
// Asserting "no such row exists" would be asserting the old, broken
// enumeration, which dropped every row the library would not confirm a map for
// — including the empty vault a new user actually has.
{
  const listing = await B.maps.canisterClient.get_all_accessible_encrypted_maps();
  const visible = new Set(
    listing.map(
      (m) => `${m.map_owner.toText()}/${new TextDecoder().decode(Uint8Array.from(m.map_name.inner))}`,
    ),
  );
  const joined = (await B.names.get_vault_names()).filter((row) =>
    visible.has(`${row.owner.toText()}/${new TextDecoder().decode(Uint8Array.from(row.map_name.inner))}`),
  );
  check(
    "exactly one name attaches to the grantee's view, and it is the owner's",
    joined.length === 1 && joined[0].display_name === "Home 🔐",
    joined.map((r) => `"${r.display_name}"`).join(", ") || "none",
  );
}

// ---- editing, but not clearing ----------------------------------------------
await A.names.set_vault_name(bytes("Personal"), "  Work notes  ");
check(
  "surrounding whitespace is trimmed, not rejected — it carries no identity here",
  nameFor(await A.names.get_vault_names(), me, "Personal") === "Work notes",
);

// A name used to be clearable, reverting the label to the map name. That was
// reasonable while the map name was something a user chose; vaults are created
// with a random id now, so clearing would rename the vault to `a3f1b2c4…`.
const cleared = await A.names.set_vault_name(bytes("Personal"), "   ");
check("an empty name is refused rather than clearing the row", "Err" in cleared, JSON.stringify(cleared));
check(
  "so the name it had survives",
  nameFor(await A.names.get_vault_names(), me, "Personal") === "Work notes",
);

// ---- bounded ----------------------------------------------------------------
const tooLong = await A.names.set_vault_name(bytes("Personal"), "x".repeat(MAX_DISPLAY_NAME_BYTES + 1));
check(`a name over ${MAX_DISPLAY_NAME_BYTES} bytes is refused`, "Err" in tooLong, JSON.stringify(tooLong));
const atCap = await A.names.set_vault_name(bytes("Personal"), "x".repeat(MAX_DISPLAY_NAME_BYTES));
check(`${MAX_DISPLAY_NAME_BYTES} bytes exactly is accepted`, "Ok" in atCap);

// 4 bytes per emoji, so one past the cap is one emoji past a quarter of it.
const emoji = Math.floor(MAX_DISPLAY_NAME_BYTES / 4) + 1;
const emojiTooLong = await A.names.set_vault_name(bytes("Personal"), "🔐".repeat(emoji));
check("the cap counts bytes, not characters", "Err" in emojiTooLong, `${emoji} emoji is ${emoji * 4} bytes`);

// ---- bounded in count, not just in size -------------------------------------
{
  const hoarder = await connect(Ed25519KeyIdentity.generate());
  let refusedAt = null;
  for (let i = 0; i < 105; i++) {
    const result = await hoarder.names.set_vault_name(bytes(`v${i}`), `Name ${i}`);
    if ("Err" in result) {
      refusedAt = i;
      break;
    }
  }
  check("a principal cannot occupy unbounded rows", refusedAt === 100, `refused at ${refusedAt}`);
  // Renaming replaces a row, so it must not be turned away by the cap.
  const rename = await hoarder.names.set_vault_name(bytes("v0"), "Renamed");
  check("but renaming an already-named vault still works at the cap", "Ok" in rename, JSON.stringify(rename));
}

// ---- anonymous callers cannot store rows ------------------------------------
{
  const { AnonymousIdentity } = await import("@icp-sdk/core/agent");
  const anon = await connect(new AnonymousIdentity());
  const result = await anon.names.set_vault_name(bytes("Personal"), "Anon");
  check("an anonymous caller is refused", "Err" in result, JSON.stringify(result));
}

// ---- an EMPTY vault can be renamed ------------------------------------------
//
// The reported bug. `get_owned_non_empty_map_names` omits an empty owned map
// (upstream dfinity/vetkeys#439), so enumerating owned names through it meant
// the write succeeded and the read returned nothing: a rename that silently did
// nothing, on precisely the vault a new user has.
await A.names.set_vault_name(bytes("Personal"), "Home");
await A.maps.removeMapValues(me, enc.encode("Personal"));
check(
  "an emptied vault keeps its name",
  nameFor(await A.names.get_vault_names(), me, "Personal") === "Home",
);

const fresh = await connect(Ed25519KeyIdentity.generate());
await fresh.names.set_vault_name(bytes("Personal"), "First vault");
check(
  "a vault that has never held an item can be named",
  nameFor(await fresh.names.get_vault_names(), fresh.me, "Personal") === "First vault",
);

await A.maps.setValue(me, enc.encode("Personal"), enc.encode("i2"), enc.encode("{}"));
check(
  "and refilling it does not disturb the name",
  nameFor(await A.names.get_vault_names(), me, "Personal") === "Home",
);

console.log(
  failures.length === 0
    ? "\nRenaming moves no map, costs no derivation, and only the owner can do it."
    : `\n${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
