/**
 * Catches a doc comment stranded above another doc comment.
 *
 * Six times in one stack, a block landed next to an existing one and left the
 * old text describing code that had moved or changed — twice in a single PR,
 * once in the commit right after the rule was written down. Six instances says
 * the rule is not the mechanism, so this is the mechanism.
 *
 * `*​/` followed only by whitespace and then `/**` is essentially never
 * deliberate in this codebase: two JSDoc blocks with nothing between them means
 * one of them documents nothing. Motoko has no equivalent signal — consecutive
 * `///` lines merge into a single block, so there is nothing structural to
 * detect — which is why this covers the TypeScript half only. Half is better
 * than the none a habit has caught.
 *
 * A second check rides along, for the one Motoko rule that *is* structural:
 * `main.mo` must contain no `///`. moc emits actor-body doc comments into the
 * Candid doc stream, where they bind to the next endpoint *by position* — so
 * reordering the `include`s once moved "the append-only event log" onto
 * `restore_version`. A composition root exposes no endpoints of its own, so
 * every `///` in it describes something the interface does not have.
 *
 * moc 1.16.0 fixed the mis-binding: a `///` on an actor-body declaration is now
 * dropped cleanly rather than landing on the next endpoint (measured — it no
 * longer reaches the `.did` at all). This check stays for two reasons that
 * outlive the bug. The compiler is pinned, so a downgrade brings it back; and a
 * `///` in a composition root documents something the interface does not have,
 * which is worth refusing whether or not it leaks.
 *
 * **The blind spot is deliberate, and closing it makes the check worse.** A
 * stranded pair on the *first* declaration of a file is not flagged, because
 * `seenCode` is still false there. That looks like an oversight and is not:
 * in that position `[file header][declaration doc][code]` and
 * `[stale doc][current doc][code]` are structurally identical, and only
 * meaning separates them. Replacing the check with "allow adjacency only when
 * the first block opens the file" was tried — it catches the first-declaration
 * case and then flags every legitimate header that sits below imports, which
 * this repository has. A gate that cries wolf gets deleted, so the trade is
 * zero false positives at the cost of one position per file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/frontend", "scripts"];
const EXT = /\.(ts|tsx|mts|mjs)$/;

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : walk(path);
    return EXT.test(entry) ? [path] : [];
  });
}

const findings = [];
for (const file of ROOTS.flatMap(walk)) {
  const lines = readFileSync(file, "utf-8").split("\n");
  // A file-header block followed by the first declaration's own block is
  // ordinary and correct, so only blocks that open after real code count.
  let seenCode = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    // Imports do not count: a file-header block often sits below them.
    const isCode =
      t && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("//") && !t.startsWith("import ");
    if (isCode) seenCode = true;
    if (!t.endsWith("*/")) return;
    if (!seenCode) return;
    // Skip blank lines, then look for another block opening immediately after.
    let k = i + 1;
    while (k < lines.length && lines[k].trim() === "") k++;
    if (k < lines.length && lines[k].trim().startsWith("/**")) {
      findings.push(`${file}:${i + 1} — a doc block ends here and another opens at line ${k + 1}`);
    }
  });
}

// `///` in the composition root reaches the generated interface. See above.
const COMPOSITION_ROOT = "src/backend/main.mo";
const rootDocs = readFileSync(COMPOSITION_ROOT, "utf-8")
  .split("\n")
  .map((line, i) => [line, i + 1])
  .filter(([line]) => line.trim().startsWith("///"));

if (rootDocs.length > 0) {
  console.log(`FAIL  ${rootDocs.length} doc comment(s) in ${COMPOSITION_ROOT}:\n`);
  for (const [line, n] of rootDocs) console.log(`  ${COMPOSITION_ROOT}:${n} — ${line.trim()}`);
  console.log("\nThese reach the Candid and attach to whichever endpoint follows. Use `//`.");
  process.exit(1);
}

if (findings.length === 0) {
  console.log("PASS  no doc comment is stranded above another (TypeScript)");
  console.log("PASS  the composition root leaks no doc comments into the interface");
  process.exit(0);
}
console.log(`FAIL  ${findings.length} stranded doc comment(s):\n`);
for (const f of findings) console.log("  " + f);
console.log("\nOne of the two blocks describes nothing. Merge them, or delete the stale one.");
process.exit(1);
