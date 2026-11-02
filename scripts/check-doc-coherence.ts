import * as fs from "node:fs";
import * as path from "node:path";

// Documentation entrypoints are executable architecture: agents and humans
// follow them as ground truth. Check both their references and the small set of
// architectural statements whose drift previously reintroduced deleted
// persistence/process designs.

export interface Violation {
  doc: string;
  ref: string;
  reason: string;
}

// Matches a backtick-quoted relative path ending in a known extension, with
// an optional `:line` or `:line-line` citation. Deliberately excludes glob
// patterns (`*`) and bare symbol calls (`invokePooled()`) by requiring the
// span to end in an extension, not a paren.
const PATH_REF = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|md|toml|yaml|yml|json))(?::(\d+)(?:-(\d+))?)?`/g;

const DOCS_TO_CHECK = ["AGENTS.md"];
// AGENTS.md imports the maintainer instructions from the maintainer's private
// companion checkout. A clone without that checkout has no such file to check.
const PRIVATE_DOCS_TO_CHECK = ["private/AGENTS.maintainer.md"];
const REQUIRED_STATEMENTS: readonly RequiredStatement[] = [
  {
    doc: "docs/architecture-intent/substrate.md",
    statement: "Every agent transcript is derived at read time from its session's conversation and execution facts",
  },
  {
    doc: "docs/architecture-intent/sessions.md",
    statement: "The session directory holds only an ephemeral process lock and disposable scratch",
  },
  {
    doc: "docs/architecture-intent/structure.md",
    statement: "maps errors to tagged types at its boundary",
  },
  {
    doc: "docs/elegance.md",
    statement: "600-code-line backstop",
  },
  {
    doc: "docs/architecture-intent/providers.md",
    statement: "One admitted request owns the ordered walk over its candidates and every retry and failover inside the request",
  },
  {
    doc: "docs/architecture-intent/providers.md",
    statement: "Tokenizer identity belongs to the model catalog, not to the access provider",
  },
  {
    doc: "docs/architecture-intent/providers.md",
    statement: "Provider affordability is an optional contribution",
  },
  {
    doc: "docs/product-intent/model-access.md",
    statement: "Unknown affordability remains the provider's decision",
  },
  {
    doc: "docs/architecture-intent/providers.md",
    statement: "After work starts, only the named failover class advances the walk",
  },
  {
    doc: "docs/terminology.md",
    statement: "protocol-v6",
  },
  {
    doc: "docs/architecture-intent/providers.md",
    statement: "A notification presents a condition that another owner decides, such as auth attention, unsafe auth storage",
  },
  {
    doc: "docs/architecture.md",
    statement: "No rendered-output cache facts are written.",
  },
];

export interface RequiredStatement {
  readonly doc: string;
  readonly statement: string;
}

function resolveCandidate(repoRoot: string, ref: string): string | null {
  const candidates = [
    path.join(repoRoot, ref),
    path.join(repoRoot, "src", ref),
    path.join(repoRoot, "docs", ref),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Prose shorthand often cites just a basename or a suffix of the real path
// (`session/pid-lock.ts` for `src/orchestration/session/pid-lock.ts`).
// Resolve by matching the reference against the tail of every candidate
// path under root, rather than demanding the full path agents.md would need
// to spell out for every nested module.
function resolveByPathSuffix(root: string, ref: string): string[] {
  const matches: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      // A reference is written with POSIX separators, so the candidate is
      // compared in that form while the native path is what callers receive.
      const comparable = full.replaceAll(path.sep, "/");
      if (comparable === ref || comparable.endsWith(`/${ref}`)) matches.push(full);
    }
  };
  walk(root);
  return matches;
}

export function checkDoc(repoRoot: string, docRelPath: string): Violation[] {
  const docPath = path.join(repoRoot, docRelPath);
  const text = fs.readFileSync(docPath, "utf-8");
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(PATH_REF)) {
    const [full, ref, startLine, endLine] = match;
    if (!ref || seen.has(full)) continue;
    seen.add(full);

    const exact = resolveCandidate(repoRoot, ref);
    const resolved = exact
      ? [exact]
      : [...resolveByPathSuffix(path.join(repoRoot, "src"), ref), ...resolveByPathSuffix(path.join(repoRoot, "docs"), ref)];

    if (resolved.length === 0) {
      violations.push({ doc: docRelPath, ref, reason: "no file matches this reference under src/ or docs/" });
      continue;
    }

    const line = endLine ?? startLine;
    if (line !== undefined && resolved.length === 1) {
      // SAFETY: resolved.length === 1 was just checked.
      const target = resolved[0]!;
      const lineCount = fs.readFileSync(target, "utf-8").split("\n").length;
      if (Number(line) > lineCount) {
        violations.push({ doc: docRelPath, ref: full, reason: `cites line ${line} but ${path.relative(repoRoot, target)} has only ${lineCount} lines` });
      }
    }
  }

  return violations;
}

function existsWithExactCase(repoRoot: string, relPath: string): boolean {
  let current = repoRoot;
  for (const segment of relPath.split("/")) {
    if (!fs.readdirSync(current).includes(segment)) return false;
    current = path.join(current, segment);
  }
  return fs.existsSync(current) && fs.statSync(current).isFile();
}

export function checkDocs(repoRoot: string, docs: readonly string[]): Violation[] {
  return docs.flatMap((doc) =>
    existsWithExactCase(repoRoot, doc)
      ? checkDoc(repoRoot, doc)
      : [{ doc, ref: doc, reason: "document does not exist with this exact path" }],
  );
}

export function checkRequiredStatements(
  repoRoot: string,
  requirements: readonly RequiredStatement[],
): Violation[] {
  return requirements.flatMap(({ doc, statement }) => {
    if (!existsWithExactCase(repoRoot, doc)) {
      return [{ doc, ref: doc, reason: "document does not exist with this exact path" }];
    }
    return fs.readFileSync(path.join(repoRoot, doc), "utf-8").includes(statement)
      ? []
      : [{ doc, ref: statement, reason: "required architectural statement is missing" }];
  });
}

const isCli = import.meta.main;
if (isCli) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const violations = [
    ...checkDocs(repoRoot, [...DOCS_TO_CHECK, ...PRIVATE_DOCS_TO_CHECK.filter((doc) => fs.existsSync(path.join(repoRoot, doc)))]),
    ...checkRequiredStatements(repoRoot, REQUIRED_STATEMENTS),
  ];
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`doc-coherence: ${v.doc} references \`${v.ref}\` -- ${v.reason}\n`);
    }
    process.exit(1);
  }
}
