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

if (findings.length === 0) {
  console.log("PASS  no doc comment is stranded above another (TypeScript)");
  process.exit(0);
}
console.log(`FAIL  ${findings.length} stranded doc comment(s):\n`);
for (const f of findings) console.log("  " + f);
console.log("\nOne of the two blocks describes nothing. Merge them, or delete the stale one.");
process.exit(1);
