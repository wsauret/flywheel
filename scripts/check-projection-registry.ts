import * as fs from "node:fs";
import * as path from "node:path";
import { AGGREGATE_READ_ALLOWLIST } from "./aggregate-read-allowlist.ts";
import { checkAggregateReads } from "./aggregate-reads.ts";

// Every projection must be registered, never built per call.
//
// `createEventProjection` initializes on its first awaited operation, so a
// rebuilt factory discards its cursor and rereads history. That cost is invisible
// at the call site - the expression reads like object construction - and eight
// separate call sites paid it per read before anyone noticed, one of them
// re-reading fifty-one workflow aggregates on every background sweep.
//
// The registry in src/infra/projection-registry.ts owns projection lifetime, so
// this gate exists to keep the next factory from quietly opting out of it: a
// `createEventProjection` call that is not the body of a `heldProjection`
// registration fails the build with the file and line that needs the wrapper.
//
// The same gate names syntactically visible full and per-item durable reads,
// which scripts/aggregate-reads.ts finds and
// scripts/aggregate-read-allowlist.ts excuses only with a stated reason.

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SOURCE_ROOT = path.join(REPO_ROOT, "src");

// The registry is the one place allowed to hold a projection without
// registering it, because it is what registration is.
const EXEMPT = new Set([
  path.join("src", "infra", "event-projection.ts"),
  path.join("src", "infra", "projection-registry.ts"),
]);

/** A call to the projection constructor, with or without an explicit type argument. */
const CONSTRUCTS_PROJECTION = /\bcreateEventProjection\s*(<[^>]*>)?\s*\(/;

/** A projection built and read in one expression, which is the stale read.
 *
 *  Before projections were registered this was correct, because construction
 *  folded. Now the second caller gets the projection the first one built, and
 *  `getState` returns whatever that caller left without checking the store. An
 *  owner that feeds its own projection through `apply` reads `getState`
 *  legitimately, and always holds it in a variable first, so it never matches. */
const READS_A_FRESH_BUILD = /\bcreate\w*Projection\s*(<[^>]*>)?\s*\([^;]*\)\s*\.getState\s*\(\)/;

/** `const x = createSomeProjection(...)`, capturing the variable it binds. */
const BINDS_A_PROJECTION = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:create\w*Projection|heldProjection)\s*(<[^>]*>)?\s*\(/g;

/** Whether a file ever feeds the projection bound to `name`.
 *
 *  An owner that pushes its own facts through `apply` reads `getState`
 *  legitimately, and the tool execution store depends on that: it compares the
 *  entry before its apply against the entry after, which folding other facts in
 *  between would break. A binding that never applies is a reader, and a reader
 *  calling `getState` on a held projection gets whatever the last holder left. */
function feedsProjection(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\.apply\\s*\\(`).test(source);
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly kind: "unregistered" | "stale-read";
}

function listSourceFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(full);
  }
}

/** Whether this `createEventProjection` call is the body of a registration.
 *
 *  Matched over the text preceding the call on its own line and the two lines
 *  above it, which is where `heldProjection(reader, key, () =>` sits in every
 *  shape the codebase uses: a direct `return`, an assignment, and a call split
 *  across lines. */
function isRegistered(lines: readonly string[], index: number): boolean {
  const window = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
  return /heldProjection\s*\([\s\S]*=>\s*$|heldProjection\s*\([\s\S]*createEventProjection/.test(window);
}

/** Prints the unreviewed reads and the allowances nothing needs. */
function reportAggregateReads(report: Awaited<ReturnType<typeof checkAggregateReads>>): boolean {
  if (report.violations.length > 0) {
    console.error("durable read that recomputes instead of advancing:\n");
    for (const finding of report.violations) {
      console.error(`  ${finding.file}:${finding.line} [${finding.scope}] ${finding.rule}`);
      console.error(`    ${finding.snippet}`);
    }
    console.error(
      "\nA read from an aggregate's first fact, or a durable read per member, costs work that grows with the",
    );
    console.error("history or the member count. Advance a registered projection from its last position, read the owning");
    console.error("live state, or batch the members into one read. Only a one-shot caller (a person command, the CLI,");
    console.error("startup, recovery, a migration) may stay, with an entry and its reason in scripts/aggregate-read-allowlist.ts.\n");
  }
  if (report.staleAllowances.length > 0) {
    console.error("aggregate-read allowances that no read needs; remove them from scripts/aggregate-read-allowlist.ts:\n");
    for (const entry of report.staleAllowances) console.error(`  ${entry.file} [${entry.scope}] ${entry.rule}`);
    console.error("");
  }
  return report.violations.length > 0 || report.staleAllowances.length > 0;
}

async function main(): Promise<void> {
  const files: string[] = [];
  listSourceFiles(SOURCE_ROOT, files);

  const violations: Violation[] = [];
  const staleReads: Violation[] = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file);
    if (EXEMPT.has(relative)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      // Matches an explicit type argument too: createEventProjection<State>(...)
      // slipped past an includes() check and left a factory unregistered.
      if (!CONSTRUCTS_PROJECTION.test(line)) continue;
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
      if (isRegistered(lines, index)) continue;
      violations.push({ file: relative, line: index + 1, snippet: line.trim(), kind: "unregistered" });
    }
    for (const [index, line] of lines.entries()) {
      if (!READS_A_FRESH_BUILD.test(line)) continue;
      staleReads.push({ file: relative, line: index + 1, snippet: line.trim(), kind: "stale-read" });
    }
    // The same read written across two lines, which the single-expression
    // pattern above cannot see.
    const source = lines.join("\n");
    for (const match of source.matchAll(BINDS_A_PROJECTION)) {
      const name = match[1];
      if (name === undefined || feedsProjection(source, name)) continue;
      const reads = new RegExp(`\\b${name}\\.getState\\s*\\(\\)`);
      const at = lines.findIndex((line) => reads.test(line));
      if (at === -1) continue;
      staleReads.push({ file: relative, line: at + 1, snippet: lines[at]?.trim() ?? "", kind: "stale-read" });
    }
  }

  const aggregateReads = await checkAggregateReads(REPO_ROOT, AGGREGATE_READ_ALLOWLIST);
  const aggregateFailures = reportAggregateReads(aggregateReads);

  if (violations.length === 0 && staleReads.length === 0 && !aggregateFailures) {
    console.log("projections: registration and freshness patterns pass; visible full and per-item reads are reviewed");
    return;
  }

  if (staleReads.length > 0) {
    console.error("projection read with getState by a caller that does not feed it, which reads stale state:\n");
    for (const stale of staleReads) {
      console.error(`  ${stale.file}:${stale.line}`);
      console.error(`    ${stale.snippet}`);
    }
    console.error(
      "\nUse replay(), which folds what is new and sees another process's commits. getState() returns",
    );
    console.error("what the last holder left, and is only for an owner that feeds the projection itself.\n");
  }

  if (violations.length === 0) process.exit(1);
  console.error("projection built without registering its lifetime:\n");
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.snippet}`);
  }
  console.error(
    "\nWrap the call in heldProjection(reader, key, () => createEventProjection(...)).",
  );
  console.error(
    "The key must name the family and every id the factory closes over, so two projections that",
  );
  console.error("fold different facts never share one.");
  process.exit(1);
}

await main();
