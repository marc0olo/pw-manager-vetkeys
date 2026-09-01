/**
 * What a poll costs: zero vetKD derivations, and no ciphertext on the wire.
 *
 * Worth a script rather than a unit test because both are properties of a
 * running replica. A careless switch back to `getAllAccessibleMaps()` would
 * silently restore the per-vault derivation this change removed, and a switch
 * back to `get_all_accessible_encrypted_maps` would silently restore the
 * ciphertext download — neither shows up as a failure anywhere else.
 */
import { execSync } from "node:child_process";
import { HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Actor } from "@icp-sdk/core/agent";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";

// The binding the app itself ships, generated from the canister's Candid — so
// this measures the interface the frontend actually polls, not a restatement
// of it that could drift from it silently.
import { idlFactory } from "../src/bindings/declarations/backend.did.js";

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
  return {
    maps: new EncryptedMaps(client),
    poll: Actor.createActor(idlFactory, { agent, canisterId: backendId }),
  };
}

const failures = [];
const check = (label, pass, detail = "") => {
  if (!pass) failures.push(label);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const alice = Ed25519KeyIdentity.generate();
const me = alice.getPrincipal();
const A = (await connect(alice)).maps;
const OWN = enc.encode("Personal");

/** A realistic entry, so the byte comparison below reflects real vaults. */
const entry = (title) =>
  JSON.stringify({
    id: "0".repeat(24),
    title,
    username: "user@example.com",
    url: `https://${title.toLowerCase()}.example.com/login`,
    password: "x".repeat(24),
    notes: "Recovery codes in the safe.",
    updatedAt: 1756300000000,
  });

await A.setValue(me, OWN, enc.encode("i1"), enc.encode(entry("GitHub")));
await A.setValue(me, OWN, enc.encode("i2"), enc.encode(entry("AWS")));
for (let i = 0; i < SHARED; i++) {
  const other = Ed25519KeyIdentity.generate();
  const em = (await connect(other)).maps;
  const name = enc.encode(`Team ${i}`);
  await em.setValue(other.getPrincipal(), name, enc.encode(`t${i}`), enc.encode(entry(`Team${i}`)));
  await em.setUserRights(other.getPrincipal(), name, me, { Read: null });
}

// A fresh client stands in for a page load.
const app = await connect(alice);
const appMaps = app.maps;
const expected = SHARED + 1;

derivations = 0;
const poll = await app.poll.get_vault_summaries();
check(`a poll sees all ${expected} vaults`, poll.length === expected, `${poll.length}`);
check("a poll derives no keys", derivations === 0, `${derivations} derivations`);

const counted = poll.every((m) => Array.isArray(m.item_keys));
check("a poll can count items without a key", counted);

derivations = 0;
for (let i = 0; i < 4; i++) await app.poll.get_vault_summaries();
check("four more polls derive nothing", derivations === 0, `${derivations} derivations`);

derivations = 0;
const items = await appMaps.getValuesForMap(me, OWN);
check("opening one vault costs exactly one derivation", derivations === 1, `${derivations}`);
check("opening it returns its items", items.length === 2, `${items.length} items`);

derivations = 0;
await appMaps.getValuesForMap(me, OWN);
check("reopening the same vault is free", derivations === 0, `${derivations}`);

derivations = 0;
await app.poll.get_vault_summaries();
check("polling after opening still derives nothing", derivations === 0, `${derivations}`);

// ---- the other half: no ciphertext on the wire ------------------------------
//
// Derivations were the cost that bought cycles; bytes are the cost that lands
// on the client. A poll used to re-download every accessible vault's complete
// ciphertext and SHA-256 it on the main thread, purely to answer "did anything
// change". Now the canister answers that with one digest per vault.
{
  const bulk = await appMaps.canisterClient.get_all_accessible_encrypted_maps();
  const size = (rows, pick) => rows.reduce((n, r) => n + pick(r), 0);

  const oldBytes = size(bulk, (m) =>
    m.keyvals.reduce((n, [k, v]) => n + k.inner.length + v.inner.length, 0),
  );
  const newBytes = size(poll, (m) =>
    m.item_keys.reduce((n, k) => n + k.inner.length, 0) + m.digest.inner.length,
  );

  check(
    "the poll carries no encrypted values at all",
    poll.every((m) => !("keyvals" in m)),
  );
  check(
    "every vault still reports a digest",
    poll.every((m) => m.digest.inner.length === 32),
  );
  check(
    "the poll is smaller than the listing it replaced",
    newBytes < oldBytes,
    `${newBytes} B vs ${oldBytes} B — ${(((oldBytes - newBytes) / oldBytes) * 100).toFixed(1)}% less`,
  );
}

// ---- what an empty vault digests to ----------------------------------------
//
// The client synthesises a placeholder for its own vault while that vault is
// empty (#11), and seeds it with EMPTY_FINGERPRINT. That constant has to equal
// what the canister reports for an empty vault, or the two routes to the same
// vault would disagree and report a spurious change.
{
  const empty = Ed25519KeyIdentity.generate();
  const E = await connect(empty);
  const name = enc.encode("Emptied");
  await E.maps.setValue(empty.getPrincipal(), name, enc.encode("k"), enc.encode("v"));
  await E.maps.setUserRights(empty.getPrincipal(), name, me, { Read: null });
  await E.maps.removeMapValues(empty.getPrincipal(), name);

  const listed = (await app.poll.get_vault_summaries()).find(
    (m) => new TextDecoder().decode(Uint8Array.from(m.map_name.inner)) === "Emptied",
  );
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const EMPTY_FINGERPRINT =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  check(
    "an empty vault digests to the constant the client seeds its placeholder with",
    listed !== undefined && hex(Uint8Array.from(listed.digest.inner)) === EMPTY_FINGERPRINT,
    listed === undefined ? "not listed" : hex(Uint8Array.from(listed.digest.inner)).slice(0, 16),
  );
}

// The regression this guards against: the old bulk call. Measured on a COLD
// client, since `app` has already cached the own vault's key — reusing it here
// would understate the cost of a page load.
const coldClient = (await connect(alice)).maps;
derivations = 0;
await coldClient.getAllAccessibleMaps();
check(
  `the old bulk call costs ${expected} derivations on a fresh load`,
  derivations === expected,
  `${derivations} — this is what the change avoids`,
);

console.log(
  failures.length === 0
    ? `\n${SHARED + 1} vaults: a poll costs 0 derivations, carries no ciphertext, and opening one vault costs 1.`
    : `\n${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
