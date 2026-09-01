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
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMITTED = "src/bindings";
const DID = ".mops/.build/backend.did";

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

  const committed = list(COMMITTED);
  const generated = list(fresh);
  const drifted = [];

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
    console.log(`PASS  ${COMMITTED} matches the canister (${committed.length} files)`);
    console.log("\nThe committed binding is current.");
  } else {
    console.log(`FAIL  ${COMMITTED} is stale: ${drifted.join(", ")}`);
    console.log("\nRun `npm run bindings` and commit the result.");
    process.exit(1);
  }
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
