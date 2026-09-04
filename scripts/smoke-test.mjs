// End-to-end check of the vetKeys storage path against the local replica,
// using the exact byte encodings src/frontend/lib/vault.ts uses.
import { execSync } from "node:child_process";
import { HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";
import { reportCycles } from "./lib/cycles.mjs";

// Running these checks is what drains the canister; see scripts/lib/cycles.mjs.
const cycles = reportCycles();

const status = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const canisterId = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(status.root_key, "hex"));
const host = status.api_url;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VAULT = encoder.encode("Personal");

async function connect(identity) {
  const agent = await HttpAgent.create({ identity, host, rootKey });
  return new EncryptedMaps(new DefaultEncryptedMapsClient(agent, canisterId));
}

function itemId() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
}

const alice = Ed25519KeyIdentity.generate();
const bob = Ed25519KeyIdentity.generate();
const alicePrincipal = alice.getPrincipal();
const bobPrincipal = bob.getPrincipal();

const A = await connect(alice);
const B = await connect(bob);

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. Store an item and read it back decrypted.
const id = itemId();
const item = {
  id,
  title: "GitHub",
  username: "marco@example.com",
  password: "Tr0ub4dor&3-correct-horse",
  url: "github.com",
  notes: "recovery codes in the safe",
  updatedAt: Date.now(),
};
await A.setValue(alicePrincipal, VAULT, encoder.encode(id), encoder.encode(JSON.stringify(item)));
const readBack = JSON.parse(decoder.decode(await A.getValue(alicePrincipal, VAULT, encoder.encode(id))));
check("owner round-trips an item", readBack.password === item.password && readBack.title === "GitHub");

// 2. The canister must hold ciphertext, not the plaintext password.
const rawAgent = await HttpAgent.create({ identity: alice, host, rootKey });
const raw = await new DefaultEncryptedMapsClient(rawAgent, canisterId).get_encrypted_values_for_map(
  alicePrincipal,
  { inner: VAULT },
);
const storedBytes = Buffer.from(raw.Ok[0][1].inner);
check(
  "stored bytes are ciphertext",
  !storedBytes.includes(Buffer.from("Tr0ub4dor")) && !storedBytes.includes(Buffer.from("GitHub")),
  `${storedBytes.length} bytes on chain`,
);

// 3. getAllAccessibleMaps lists the vault with decrypted values (what the UI uses).
const maps = await A.getAllAccessibleMaps();
const personal = maps.find((m) => decoder.decode(m.mapName) === "Personal");
check(
  "getAllAccessibleMaps decrypts the vault",
  personal !== undefined && JSON.parse(decoder.decode(personal.keyvals[0][1])).title === "GitHub",
);

// 4. A stranger cannot read the vault.
let denied = false;
try {
  await B.getValue(alicePrincipal, VAULT, encoder.encode(id));
} catch (error) {
  denied = true;
  check("stranger is denied", true, String(error.message ?? error).slice(0, 60));
}
if (!denied) check("stranger is denied", false, "read succeeded — access control broken");

// 5. Share read-only, then Bob can decrypt.
await A.setUserRights(alicePrincipal, VAULT, bobPrincipal, { Read: null });
const shared = JSON.parse(decoder.decode(await B.getValue(alicePrincipal, VAULT, encoder.encode(id))));
check("shared reader decrypts", shared.password === item.password);

// 6. A read-only grantee cannot write.
let writeBlocked = false;
try {
  await B.setValue(alicePrincipal, VAULT, encoder.encode(itemId()), encoder.encode("{}"));
} catch {
  writeBlocked = true;
}
check("read-only grantee cannot write", writeBlocked);

// 7. Revoke, and Bob loses access.
await A.removeUser(alicePrincipal, VAULT, bobPrincipal);
let revoked = false;
try {
  await B.getValue(alicePrincipal, VAULT, encoder.encode(id));
} catch {
  revoked = true;
}
check("revoked reader is locked out", revoked);

// 8. Delete the item.
await A.removeEncryptedValue(alicePrincipal, VAULT, encoder.encode(id));
const after = await A.getAllAccessibleMaps();
check("delete removes the item", after.every((m) => m.keyvals.every(([k]) => decoder.decode(k) !== id)));

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
cycles.done();
process.exit(failed.length === 0 ? 0 : 1);
