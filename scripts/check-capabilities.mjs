/**
 * The access-level table the UI now states out loud, verified against a running
 * replica.
 *
 * Worth a script rather than a unit test because every claim here is the
 * canister's behaviour, not ours: which operations each level permits, that a
 * refusal always says exactly `unauthorized`, and that a non-manager cannot see
 * their own rights — the defect that made every level behave like `Read`.
 *
 * If any of this drifts, the share dialog starts lying about what it grants.
 */
import { execSync } from "node:child_process";
import { HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";

const status = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const backendId = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(status.root_key, "hex"));
const enc = new TextEncoder();

const connect = async (identity) =>
  new EncryptedMaps(
    new DefaultEncryptedMapsClient(
      await HttpAgent.create({ identity, host: status.api_url, rootKey }),
      backendId,
    ),
  );

const failures = [];
const check = (label, pass, detail = "") => {
  if (!pass) failures.push(label);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Runs an operation and reports "ok" or the exact refusal message. */
const attempt = async (fn) => {
  try {
    await fn();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const owner = Ed25519KeyIdentity.generate();
const O = await connect(owner);
const me = owner.getPrincipal();

/** A fresh vault with two items, shared with a new principal at `level`. */
async function vaultSharedAt(level, name) {
  const mapName = enc.encode(name);
  await O.setValue(me, mapName, enc.encode("i1"), enc.encode('{"title":"one"}'));
  await O.setValue(me, mapName, enc.encode("i2"), enc.encode('{"title":"two"}'));
  const grantee = Ed25519KeyIdentity.generate();
  await O.setUserRights(me, mapName, grantee.getPrincipal(), { [level]: null });
  return { mapName, grantee, G: await connect(grantee) };
}

// ---- the table ------------------------------------------------------------
const EXPECTED = {
  Read: { write: "unauthorized", manage: "unauthorized", wipe: "unauthorized" },
  ReadWrite: { write: "ok", manage: "unauthorized", wipe: "ok" },
  ReadWriteManage: { write: "ok", manage: "ok", wipe: "ok" },
};

for (const [level, expected] of Object.entries(EXPECTED)) {
  const { mapName, G } = await vaultSharedAt(level, `Vault ${level}`);
  const got = {
    write: await attempt(() => G.setValue(me, mapName, enc.encode("x"), enc.encode("{}"))),
    manage: await attempt(() =>
      G.setUserRights(me, mapName, Ed25519KeyIdentity.generate().getPrincipal(), { Read: null }),
    ),
    // Wipe last: it empties the vault the earlier checks rely on.
    wipe: await attempt(() => G.removeMapValues(me, mapName)),
  };
  for (const op of ["write", "manage", "wipe"]) {
    check(`${level} · ${op} -> ${expected[op]}`, got[op] === expected[op], got[op]);
  }
}

// ---- ReadWrite is destructive, which the labels must say -------------------
check(
  "ReadWrite can empty a vault it does not own — there is no separate delete right",
  EXPECTED.ReadWrite.wipe === "ok",
);

// ---- the root cause: a grantee cannot see their own rights ----------------
{
  const { mapName, grantee, G } = await vaultSharedAt("ReadWrite", "Vault ACL");
  const maps = await G.canisterClient.get_all_accessible_encrypted_maps();
  const listed = maps.find((m) => new TextDecoder().decode(m.map_name.inner) === "Vault ACL");
  check("a writer sees the vault in their listing", listed !== undefined);
  check(
    "but its access list comes back empty, so rights cannot be read (dfinity/vetkeys#438)",
    listed.access_control.length === 0,
    `${listed.access_control.length} entries`,
  );
  const inferred =
    listed.access_control.find((entry) => entry[0].compareTo(grantee.getPrincipal()) === "eq")?.[1] ??
    null;
  check("so the old inference yields null -> read-only", inferred === null);
  check(
    "while the write it hid actually succeeds",
    (await attempt(() => G.setValue(me, mapName, enc.encode("proof"), enc.encode("{}")))) === "ok",
  );
}

// ---- what a wipe leaves behind, which the dialog promises ------------------
//
// "The vault itself stays, and so does everyone's access to it." Both halves
// are checked here, and the owner's half is subtler than it looks: an empty
// *owned* map drops out of the canister's listing entirely (#11, upstream
// dfinity/vetkeys#439), and only the frontend's placeholder keeps it on screen.
{
  const named = (maps) =>
    maps.find((m) => new TextDecoder().decode(m.map_name.inner) === "Vault Survives");
  const { mapName, G } = await vaultSharedAt("ReadWrite", "Vault Survives");
  await G.removeMapValues(me, mapName);

  const forOwner = named(await O.canisterClient.get_all_accessible_encrypted_maps());
  check(
    "an emptied owned vault drops out of the owner's listing (#11 — the placeholder covers this)",
    forOwner === undefined,
  );

  const forGrantee = named(await G.canisterClient.get_all_accessible_encrypted_maps());
  check("but the grantee still sees it, because it is listed from the ACL", forGrantee !== undefined);
  check("with no items left", forGrantee !== undefined && forGrantee.keyvals.length === 0);
  check(
    "and can still write to it, so the wipe did not revoke anyone",
    (await attempt(() => G.setValue(me, mapName, enc.encode("after"), enc.encode("{}")))) === "ok",
  );
}

// ---- a manager cannot lock the owner out -----------------------------------
//
// The interesting part is *how*. Ownership is identity-derived, not an ACL
// entry, so `removeUser` on the owner removes nothing and returns the previous
// rights as `undefined` — the same answer as for a principal who was never
// granted anything. `getUserRights` meanwhile synthesises the owner's rights
// and reports `ReadWriteManage`, so the two endpoints disagree about whether
// the owner is a member, and a caller cannot tell "the owner is protected"
// from "that principal had nothing". Upstream dfinity/vetkeys#437 covers this:
// the owner guard uses `&&`, so it only fires when the owner targets
// themselves. Its suggested fix — reject any ACL mutation where `user == owner`
// — resolves this and the duplicate listing that vault.ts de-duplicates, which
// is why one issue number is cited for two symptoms.
//
// Unreachable from our UI, which filters the owner out of the share list.
{
  const { mapName, G } = await vaultSharedAt("ReadWriteManage", "Vault Owner");
  const removed = await G.removeUser(me, mapName, me);
  check("removing the owner removes nothing", removed === undefined, JSON.stringify(removed));
  check(
    "yet getUserRights reports the owner as a manager — the two disagree",
    JSON.stringify(await G.getUserRights(me, mapName, me)) === JSON.stringify({ ReadWriteManage: null }),
  );
  check(
    "but it is a no-op: the owner can still write",
    (await attempt(() => O.setValue(me, mapName, enc.encode("still"), enc.encode("{}")))) === "ok",
  );
  check(
    "and can still manage, so a manager cannot seize the vault",
    (await attempt(() =>
      O.setUserRights(me, mapName, Ed25519KeyIdentity.generate().getPrincipal(), { Read: null }),
    )) === "ok",
  );
}

console.log(
  failures.length === 0
    ? "\nThe access-level table holds, and every refusal says exactly `unauthorized`."
    : `\n${failures.length} failure(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
