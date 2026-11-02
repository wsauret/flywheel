import * as fs from "node:fs";
import * as path from "node:path";

export interface TerminalIoViolation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const INTENTIONAL_STDOUT_WRITE_ALLOWLIST = new Set([
  "src/infra/desktop-notify.ts",
  "src/tui/components/error-boundary.tsx",
  "src/tui/utils/clipboard.ts",
]);

const DIRECT_OUTPUT_FILE_ALLOWLIST = new Set([
  "src/infra/log.ts",
  // The sink under log.ts: when the diagnostics stream itself fails, stderr is
  // the only channel left, and routing through Log would be circular.
  "src/infra/debug-log.ts",
  "src/orchestration/headless/run-headless-task.ts",
  // This executable role runs inside a captured command. Its fixed refusal
  // belongs to that command's stderr, not the host renderer or diagnostics.
  "src/orchestration/agent-runtime/tools/bash-git-main.ts",
]);

/** The supervisor of one owned command hands the launcher's own stream handles
 *  to the payload. Inheriting is the point: it keeps every payload byte out of
 *  this process. It renders nothing of its own. */
const INHERITED_STDIO_FILE_ALLOWLIST = new Set([
  "src/infra/owned-command-supervisor.ts",
  // Delegated children retain the payload's existing container and handles.
  // This runner does not emit host UI output.
  "src/infra/inherited-command.ts",
  // The successor a terminal becomes where no process image can be replaced:
  // it owns the terminal from its first frame, and the terminal that started
  // it has suspended its renderer and only waits for its status.
  "src/infra/foreground-successor.ts",
]);

const INHERITED_STDIO_LINE_RE = /\b(?:stdout|stderr)\s*:\s*["'`]inherit["'`]/;
const INHERITED_STDIO_BLOCK_RE = /\bstdio\s*:\s*\[[\s\S]*?["'`]inherit["'`]/g;
const BUN_SPAWN_RE = /\bBun\.spawn(?:Sync)?\s*\(/g;
const EXPLICIT_STDERR_RE = /\b(?:stderr|stdio)\s*:/;
const TERMINAL_OUTPUT_RE = /\b(process\.(stdout|stderr)\.write|console\.(?:log|error|warn|info|debug))\s*\(/;

export function findTerminalIoViolations(repoRoot: string): TerminalIoViolation[] {
  const srcRoot = path.join(repoRoot, "src");
  if (!fs.existsSync(srcRoot)) return [];

  const violations: TerminalIoViolation[] = [];
  for (const file of listCodeFiles(srcRoot)) {
    const relFile = normalizeRel(repoRoot, file);
    const text = fs.readFileSync(file, "utf8");
    collectInheritedStdioViolations(violations, relFile, text);
    collectImplicitSpawnStderrViolations(violations, relFile, text);
    collectTerminalOutputViolations(violations, relFile, text);
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

function collectInheritedStdioViolations(violations: TerminalIoViolation[], file: string, text: string): void {
  if (INHERITED_STDIO_FILE_ALLOWLIST.has(file)) return;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isCommentLine(line) || !INHERITED_STDIO_LINE_RE.test(line)) continue;
    violations.push({ file, line: index + 1, rule: "no-inherited-stdio", snippet: line.trim() });
  }

  let match: RegExpExecArray | null;
  INHERITED_STDIO_BLOCK_RE.lastIndex = 0;
  while ((match = INHERITED_STDIO_BLOCK_RE.exec(text)) !== null) {
    const line = lineNumber(text, match.index);
    const sourceLine = lines[line - 1] ?? "";
    if (isCommentLine(sourceLine)) continue;
    violations.push({ file, line, rule: "no-inherited-stdio", snippet: sourceLine.trim() });
  }
}

function collectImplicitSpawnStderrViolations(violations: TerminalIoViolation[], file: string, text: string): void {
  const lines = text.split("\n");
  let match: RegExpExecArray | null;
  BUN_SPAWN_RE.lastIndex = 0;
  while ((match = BUN_SPAWN_RE.exec(text)) !== null) {
    const line = lineNumber(text, match.index);
    const sourceLine = lines[line - 1] ?? "";
    if (isCommentLine(sourceLine)) continue;
    const call = readCallExpression(text, match.index);
    if (!call || EXPLICIT_STDERR_RE.test(call)) continue;
    violations.push({ file, line, rule: "no-implicit-inherited-stderr", snippet: sourceLine.trim() });
  }
}

function collectTerminalOutputViolations(violations: TerminalIoViolation[], file: string, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isCommentLine(line)) continue;

    const match = TERMINAL_OUTPUT_RE.exec(line);
    if (!match) continue;
    const call = match[1] ?? "";
    if (isAllowedTerminalOutput(file, call)) continue;

    violations.push({ file, line: index + 1, rule: "no-terminal-output", snippet: line.trim() });
  }
}

/** A command-line verb is terminal output by definition, whether it lives in
 *  the composition root or in a module's `cli/` home (ARCH-STRUCTURE-022). */
const CLI_VERB_FILE = /^src\/(?:cli|orchestration\/modules\/[^/]+\/cli)\//;

function isAllowedTerminalOutput(file: string, call: string): boolean {
  if (CLI_VERB_FILE.test(file)) return true;
  if (DIRECT_OUTPUT_FILE_ALLOWLIST.has(file)) return true;
  return call === "process.stdout.write" && INTENTIONAL_STDOUT_WRITE_ALLOWLIST.has(file);
}

function listCodeFiles(dirPath: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listCodeFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    results.push(full);
  }
  return results;
}

function normalizeRel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function readCallExpression(text: string, start: number): string | null {
  const open = text.indexOf("(", start);
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = open; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function lineNumber(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const violations = findTerminalIoViolations(repoRoot);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(`terminal-io: ${violation.file}:${violation.line} ${violation.rule}: ${violation.snippet}\n`);
    }
    process.exit(1);
  }
}
