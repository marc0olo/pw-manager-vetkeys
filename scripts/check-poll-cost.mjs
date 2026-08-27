/**
 * The claim lazy loading rests on: a poll costs zero vetKD derivations, and
 * opening one vault costs exactly one.
 *
 * Worth a script rather than a unit test because it counts real
 * `get_encrypted_vetkey` calls against a running replica. A careless switch from
 * the raw client back to `getAllAccessibleMaps()` would silently restore the
 * per-vault cost this change exists to remove, and nothing else would notice.
 */
import { execSync } from "node:child_process";
import { HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";

const status = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const backendId = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(status.root_key, "hex"));
const enc = new TextEncoder();

/** How many vaults get shared with our user. */
const SHARED = 5;

let derivations = 0;
async function connect(identity) {
  const agent = await HttpAgent.create({ identity, host: status.api_url, rootKey });
  const client = new DefaultEncryptedMapsClient(agent, backendId);
  const real = client.get_encrypted_vetkey.bind(client);
  client.get_encrypted_vetkey = (...args) => {
    derivations++;
    return real(...args);
  };
  return new EncryptedMaps(client);
}

const failures = [];
const check = (label, pass, detail = "") => {
  if (!pass) failures.push(label);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const alice = Ed25519KeyIdentity.generate();
const me = alice.getPrincipal();
const A = await connect(alice);
const OWN = enc.encode("Personal");

await A.setValue(me, OWN, enc.encode("i1"), enc.encode('{"title":"GitHub"}'));
await A.setValue(me, OWN, enc.encode("i2"), enc.encode('{"title":"AWS"}'));
for (let i = 0; i < SHARED; i++) {
  const other = Ed25519KeyIdentity.generate();
  const em = await connect(other);
  const name = enc.encode(`Team ${i}`);
  await em.setValue(other.getPrincipal(), name, enc.encode(`t${i}`), enc.encode("{}"));
  await em.setUserRights(other.getPrincipal(), name, me, { Read: null });
}

// A fresh client stands in for a page load.
const app = await connect(alice);
const expected = SHARED + 1;

derivations = 0;
const poll = await app.canisterClient.get_all_accessible_encrypted_maps();
check(`a poll sees all ${expected} vaults`, poll.length === expected, `${poll.length}`);
check("a poll derives no keys", derivations === 0, `${derivations} derivations`);

const counted = poll.every((m) => Array.isArray(m.keyvals));
check("a poll can count items without a key", counted);

derivations = 0;
for (let i = 0; i < 4; i++) await app.canisterClient.get_all_accessible_encrypted_maps();
check("four more polls derive nothing", derivations === 0, `${derivations} derivations`);

derivations = 0;
const items = await app.getValuesForMap(me, OWN);
check("opening one vault costs exactly one derivation", derivations === 1, `${derivations}`);
check("opening it returns its items", items.length === 2, `${items.length} items`);

derivations = 0;
await app.getValuesForMap(me, OWN);
check("reopening the same vault is free", derivations === 0, `${derivations}`);

derivations = 0;
await app.canisterClient.get_all_accessible_encrypted_maps();
check("polling after opening still derives nothing", derivations === 0, `${derivations}`);

// The regression this guards against: the old bulk call. Measured on a COLD
// client, since `app` has already cached the own vault's key — reusing it here
// would understate the cost of a page load.
const coldClient = await connect(alice);
derivations = 0;
await coldClient.getAllAccessibleMaps();
check(
  `the old bulk call costs ${expected} derivations on a fresh load`,
  derivations === expected,
  `${derivations} — this is what the change avoids`,
);

console.log(
  failures.length === 0
    ? `\n${SHARED + 1} vaults: a poll costs 0 derivations, opening one costs 1.`
    : `\n${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
