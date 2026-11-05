import * as fs from "node:fs";
import * as path from "node:path";

// Intent corpora gate. The architecture-intent and product-intent corpora are
// the living authorities that code, tests, and documents cite by statement id,
// so a malformed or duplicated id, an unlinked domain file, a statement that
// names implementation detail, or a citation that resolves to nothing is a
// build failure. A statement stays short enough to read as one contract: a body
// of at most 100 words in sentences of at most 35 words, and an architecture
// statement adds at most one sentence of rationale and one of rejected
// alternative. The retired architecture decision records are no authority, so a
// citation of them fails too.
//
// The citing scope is every tracked and unignored text file, listed by Git
// rather than a directory crawl, because ignored worktrees under the
// repository hold whole copies of the tree.

type IntentRule = "statement-format" | "duplicate-id" | "domain-link" | "grain" | "length" | "dangling-id" | "adr-reference";

interface IntentViolation {
  file: string;
  line: number;
  rule: IntentRule;
  detail: string;
}

const ARCHITECTURE_DIR = "docs/architecture-intent";
const PRODUCT_DIR = "docs/product-intent";
const UPDATES_FILE = `${PRODUCT_DIR}/updates.md`;
const README = "README.md";

const ARCHITECTURE_HEADING = /^## ARCH-[A-Z]+-\d{3}: \S/;
const PRODUCT_HEADING = /^## PI-[A-Z]+-\d{3}: \S/;
const UPDATE_BULLET = /^- `UPD-\d{3}`: \S/;
const UPDATE_LIKE = /^-\s+`?UPD-/;
const STATEMENT_ID = /^(?:## |- `)((?:ARCH|PI)-[A-Z]+-\d{3}|UPD-\d{3})/;
const CITED_ID = /\b(?:(?:ARCH|PI)-[A-Z]+-\d{3}|UPD-\d{3})\b/g;
const ADR_REFERENCE = /docs\/adrs|\bADR-\d+/gi;
// The stale-tool-result masker never masks reads of any repository's ADRs, so
// it and its test name the conventional directory as generic behavior.
const GENERIC_ADR_PATH_FILES = new Set([
  "src/orchestration/agent-runtime/compaction/stale-tool-result-masker.ts",
  "tests/unit/orchestration/agent-runtime/context/stale-tool-result-masker.test.ts",
]);

const DOMAIN_LINK = /\]\(([^)/#\s]+\.md)\)/g;
const INLINE_CODE = /`[^`]+`/;
const FILE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|toml|ya?ml|sqlite|db|sh|ps1|exe|lock|txt|pid|log|plist)$/i;
const RATIONALE_LINE = /^(Because|Not):/;
const CODE_SPAN = /`[^`]*`/g;
// A terminator, with any closing quote or bracket after it, ends a sentence only
// before the end of the text or before a word that can open one, so "e.g. the"
// stays inside its sentence and `says "Stop." Then` ends one.
const SENTENCE_END = /[.?!]["'\u201D)\]]*(?=\s+[A-Z`"'\u201C([]|\s*$)/g;
const MAX_BODY_WORDS = 100;
const MAX_SENTENCE_WORDS = 35;
const TOKEN_EDGE = /^[("'[]+|[)"'\],.;:!?]+$/g;

// Historical records and frozen benchmark inputs keep the wording they were
// written or measured with.
const UNCITING_ROOTS = [
  "private/docs/plans/archive/",
  "private/docs/research/",
  "private/docs/audits/",
  "private/docs/qa/",
  "docs/research/",
  "bench/findings/",
  "bench/ab-persona/fixtures/",
  "bench/chat-ab/tasks/",
  "tests/fixtures/output-seam-corpus/",
];

interface Statement {
  file: string;
  line: number;
}

function readLines(repoRoot: string, file: string): string[] {
  return fs.readFileSync(path.join(repoRoot, file), "utf8").split("\n");
}

function corpusFiles(files: readonly string[], dir: string): string[] {
  return files.filter((file) => path.posix.dirname(file) === dir && file.endsWith(".md"));
}

/** The format rule for one line of a corpus domain file, or null when the line
 *  is not statement-shaped. */
function formatProblem(file: string, line: string): string | null {
  if (file === UPDATES_FILE) {
    if (UPDATE_LIKE.test(line) && !UPDATE_BULLET.test(line)) return "expected - `UPD-<NNN>`: <statement>";
    return null;
  }
  if (!line.startsWith("## ")) return null;
  if (file.startsWith(`${ARCHITECTURE_DIR}/`)) {
    return ARCHITECTURE_HEADING.test(line) ? null : "expected ## ARCH-<DOMAIN>-<NNN>: <title>";
  }
  return PRODUCT_HEADING.test(line) ? null : "expected ## PI-<DOMAIN>-<NNN>: <title>";
}

/** `repoPaths` holds every listed file and each of its parent directories, so
 *  an extensionless repository path such as a launcher script is caught while
 *  prose such as "and/or" passes. */
function pathLike(token: string, repoPaths: ReadonlySet<string>): boolean {
  if (FILE_EXTENSION.test(token) && /\w\.\w/.test(token)) return true;
  if (!token.includes("/")) return false;
  if (repoPaths.has(token.replace(/\/$/, ""))) return true;
  return /^(?:\.{1,2}|~)?\//.test(token) || token.endsWith("/") || token.split("/").length > 2;
}

function grainProblem(line: string, repoPaths: ReadonlySet<string>): string | null {
  if (INLINE_CODE.test(line)) return "inline code span";
  for (const raw of line.split(/\s+/)) {
    const token = raw.replace(TOKEN_EDGE, "");
    if (token.length > 0 && pathLike(token, repoPaths)) return `path-like token '${token}'`;
  }
  return null;
}

/** The sentences of `text`, with each code span reduced to one word. Text after
 *  the last terminator is a final sentence, so every word of the text is counted. */
function sentences(text: string): string[] {
  const plain = text.replace(CODE_SPAN, "`c`");
  const out: string[] = [];
  let start = 0;
  for (const end of plain.matchAll(SENTENCE_END)) {
    out.push(plain.slice(start, end.index + end[0].length).trim());
    start = end.index + end[0].length;
  }
  const rest = plain.slice(start).trim();
  if (rest.length > 0) out.push(rest);
  return out;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/** The length rule for the statement whose heading is `lines[index]`: a body
 *  of 1 to 100 words, every sentence of at most 35 words, and for architecture
 *  at most one single-sentence `Because:` and `Not:` line each. Product
 *  statements carry no rationale. */
function lengthProblems(lines: readonly string[], index: number, architecture: boolean): string[] {
  const out: string[] = [];
  const next = lines.findIndex((candidate, at) => at > index && candidate.startsWith("## "));
  const body = lines.slice(index + 1, next === -1 ? undefined : next).map((line) => line.trim()).filter((line) => line.length > 0);
  const rule = sentences(body.filter((line) => !RATIONALE_LINE.test(line)).join(" "));
  const words = wordCount(rule.join(" "));
  if (words < 1 || words > MAX_BODY_WORDS) out.push(`body has ${words} words; expected 1 to ${MAX_BODY_WORDS}`);
  for (const sentence of rule) {
    const count = wordCount(sentence);
    if (count > MAX_SENTENCE_WORDS) out.push(`sentence of ${count} words; expected at most ${MAX_SENTENCE_WORDS}: "${sentence.slice(0, 40)}"`);
  }
  for (const label of ["Because", "Not"]) {
    const labeled = body.filter((line) => line.startsWith(`${label}:`));
    if (!architecture) {
      if (labeled.length > 0) out.push(`has ${labeled.length} ${label}: lines; product statements carry no rationale`);
      continue;
    }
    if (labeled.length > 1) out.push(`has ${labeled.length} ${label}: lines; expected at most 1`);
    for (const line of labeled) {
      const parts = sentences(line.slice(label.length + 1));
      if (parts.length !== 1) out.push(`${label}: line has ${parts.length} sentences; expected 1`);
      const count = wordCount(parts.join(" "));
      if (count > MAX_SENTENCE_WORDS) out.push(`${label}: line has ${count} words; expected at most ${MAX_SENTENCE_WORDS}`);
    }
  }
  return out;
}

function repositoryPaths(files: readonly string[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    for (let at = file.length; at > 0; at = file.lastIndexOf("/", at - 1)) paths.add(file.slice(0, at));
  }
  return paths;
}

function checkCorpus(repoRoot: string, files: readonly string[], dir: string, statements: Map<string, Statement>, repoPaths: ReadonlySet<string>): IntentViolation[] {
  const out: IntentViolation[] = [];
  const domainFiles = corpusFiles(files, dir).filter((file) => path.posix.basename(file) !== README);
  const readme = `${dir}/${README}`;
  const linked = new Set<string>();
  if (files.includes(readme)) {
    for (const [index, text] of readLines(repoRoot, readme).entries()) {
      for (const match of text.matchAll(DOMAIN_LINK)) {
        const target = `${dir}/${match[1] ?? ""}`;
        linked.add(target);
        if (!domainFiles.includes(target)) {
          out.push({ file: readme, line: index + 1, rule: "domain-link", detail: `linked domain file ${target} does not exist` });
        }
      }
    }
  } else {
    out.push({ file: readme, line: 1, rule: "domain-link", detail: "corpus README is missing" });
  }
  const architecture = dir === ARCHITECTURE_DIR;
  for (const file of domainFiles) {
    if (!linked.has(file)) out.push({ file, line: 1, rule: "domain-link", detail: `domain file is not linked from ${readme}` });
    const lines = readLines(repoRoot, file);
    for (const [index, text] of lines.entries()) {
      const line = index + 1;
      const format = formatProblem(file, text);
      if (format !== null) out.push({ file, line, rule: "statement-format", detail: format });
      const statementHeading = format === null && file !== UPDATES_FILE && text.startsWith("## ");
      for (const detail of statementHeading ? lengthProblems(lines, index, architecture) : []) out.push({ file, line, rule: "length", detail });
      const id = format === null ? STATEMENT_ID.exec(text)?.[1] : undefined;
      if (id !== undefined) {
        const first = statements.get(id);
        if (first === undefined) statements.set(id, { file, line });
        else out.push({ file, line, rule: "duplicate-id", detail: `${id} is already stated at ${first.file}:${first.line}` });
      }
      const grain = architecture ? grainProblem(text, repoPaths) : null;
      if (grain !== null) out.push({ file, line, rule: "grain", detail: grain });
    }
  }
  return out;
}

function inCitingScope(file: string): boolean {
  return !UNCITING_ROOTS.some((root) => file.startsWith(root));
}

function checkCitations(repoRoot: string, files: readonly string[], statements: ReadonlyMap<string, Statement>): IntentViolation[] {
  const out: IntentViolation[] = [];
  for (const file of files.filter(inCitingScope)) {
    const bytes = fs.readFileSync(path.join(repoRoot, file));
    if (bytes.includes(0)) continue;
    const checkAdr = !GENERIC_ADR_PATH_FILES.has(file);
    for (const [index, text] of bytes.toString("utf8").split("\n").entries()) {
      for (const [id] of text.matchAll(CITED_ID)) {
        if (!statements.has(id)) out.push({ file, line: index + 1, rule: "dangling-id", detail: `${id} resolves to no statement` });
      }
      if (!checkAdr) continue;
      for (const [reference] of text.matchAll(ADR_REFERENCE)) {
        out.push({ file, line: index + 1, rule: "adr-reference", detail: `cites retired record '${reference}'` });
      }
    }
  }
  return out;
}

/** Checks both intent corpora and every citation of them.
 *
 *  `files` is the repository's file list as repository-relative POSIX paths;
 *  each must exist under `repoRoot`. Returns every violation, corpus rules
 *  first, in file and line order; an empty list means the corpora and their
 *  citations are coherent. Reads files only. */
export function checkIntentCorpora(repoRoot: string, files: readonly string[]): IntentViolation[] {
  const statements = new Map<string, Statement>();
  const repoPaths = repositoryPaths(files);
  return [
    ...checkCorpus(repoRoot, files, ARCHITECTURE_DIR, statements, repoPaths),
    ...checkCorpus(repoRoot, files, PRODUCT_DIR, statements, repoPaths),
    ...checkCitations(repoRoot, files, statements),
  ];
}

function repositoryFiles(repoRoot: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (proc.exitCode !== 0) throw new Error(`intent: git ls-files failed: ${proc.stderr.toString()}`);
  // A tracked file deleted in the working tree is still listed until the deletion is staged.
  return proc.stdout.toString().split("\n").filter((file) => file.length > 0 && fs.existsSync(path.join(repoRoot, file)));
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const violations = checkIntentCorpora(repoRoot, repositoryFiles(repoRoot));
  for (const v of violations) process.stderr.write(`intent: ${v.file}:${v.line} ${v.rule}: ${v.detail}\n`);
  if (violations.length > 0) process.exit(1);
}
