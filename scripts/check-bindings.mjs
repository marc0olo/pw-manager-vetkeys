/**
 * Fail if the committed Candid binding no longer matches the canister.
 *
 * The binding is generated but **committed**, so a fresh checkout can
 * typecheck, test and run the replica scripts without a Motoko toolchain, and
 * so an interface change shows up in a pull request diff rather than only at
 * runtime. The cost of committing generated code is that it can go stale
 * silently; this is what stops that.
 *
 * Silent is the operative word. Candid decodes a drifted record into something
 * plausible rather than throwing, so a stale binding surfaces as wrong data,
 * not an error — which is exactly the failure mode this whole change exists to
 * remove.
 *
 * The **stable signature** is committed for a different reason. Nothing reads
 * it at runtime; it is here so that changing the type of a stable variable
 * appears in a pull request diff. Twice now a Candid failure has been read as a
 * state incompatibility and a wrong deploy instruction written from it — once
 * claiming a reinstall was needed when it was not, once the reverse. A diff
 * showing exactly which stable types moved is what a reviewer can act on;
 * remembering to run `moc --stable-compatible` is not. See #42 for the check
 * that answers "is this safe", which needs this file as its baseline.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMITTED = "src/bindings";
// Only the generated declarations are compared against a fresh bindgen run; the
// stable signature lives beside them but comes from the build, not bindgen.
const DECLARATIONS = "declarations";
const DID = ".mops/.build/backend.did";
const MOST = ".mops/.build/backend.most";
const COMMITTED_MOST = "src/bindings/backend.most";

console.log("Rebuilding the canister so the .did reflects src/backend…");
execSync("icp build backend", { stdio: "pipe" });

const fresh = mkdtempSync(join(tmpdir(), "bindings-"));
try {
  execSync(`npx --no-install @icp-sdk/bindgen --did-file ${DID} --out-dir ${fresh} --actor-disabled`, {
    stdio: "pipe",
  });

  const list = (root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath.slice(root.length + 1), entry.name))
      .sort();

  const committed = list(join(COMMITTED, DECLARATIONS)).map((file) => join(DECLARATIONS, file));
  const generated = list(fresh);
  const drifted = [];

  // Written by `icp build`, not by bindgen, so it is compared on its own.
  if (readFileSync(MOST, "utf-8") !== readFileSync(COMMITTED_MOST, "utf-8")) {
    drifted.push(`${COMMITTED_MOST} (the stable signature moved — say in the PR whether an upgrade still carries the data)`);
  }

  if (committed.join() !== generated.join()) {
    drifted.push(`file list differs: ${committed.join(", ")} vs ${generated.join(", ")}`);
  } else {
    for (const file of committed) {
      if (readFileSync(join(COMMITTED, file), "utf-8") !== readFileSync(join(fresh, file), "utf-8")) {
        drifted.push(file);
      }
    }
  }

  if (drifted.length === 0) {
    console.log(`PASS  ${COMMITTED} matches the canister (${committed.length + 1} files)`);
    console.log("\nThe committed binding and stable signature are current.");
  } else {
    console.log(`FAIL  ${COMMITTED} is stale: ${drifted.join(", ")}`);
    console.log("\nRun `npm run bindings` and commit the result.");
    process.exit(1);
  }
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
