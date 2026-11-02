import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { findOversizedFiles, SRC_MAX_LINES } from "./check-file-sizes.ts";

// The web client is a separate TypeScript project (its own tsconfig, a browser
// target, Solid's JSX), so the root lint steps do not reach it. This step binds
// webview/ to the same gates the rest of the repository runs, plus the one gate
// that is its own: the stylesheet rules. A component stylesheet may name a
// colour, a font size, a z-index, or a layout threshold only through the token
// vocabulary in tokens.css and the container-width ladder, so the client stays
// themeable by a host and legible on every host.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const webviewRoot = path.join(repoRoot, "webview");
const sourceRoots = ["webview/src", "webview/local", "webview/editor", "webview/phone", "webview/test-support"];
const tokensFile = path.join(webviewRoot, "src", "styles", "tokens.css");

const nonSourceDirs = new Set(["node_modules", "out", "dist"]);

/** The container-width ladder. A threshold outside it is a new rung, which is a
 *  design decision recorded in tokens.css, not a number in a component. */
const CONTAINER_WIDTHS = new Set(["40rem", "60rem"]);

interface Violation {
  file: string;
  line: number;
  reason: string;
}

const emDash = /\u2014/u;
const emoji = /\p{Extended_Pictographic}|\uFE0F/u;

function listFiles(dirPath: string, extensions: RegExp, out: string[]): void {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (nonSourceDirs.has(entry.name)) continue;
      listFiles(full, extensions, out);
      continue;
    }
    if (entry.isFile() && extensions.test(entry.name)) out.push(full);
  }
}

function findStyleViolations(): Violation[] {
  const files: string[] = [];
  listFiles(webviewRoot, /\.(ts|tsx|md|json|css)$/, files);
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (emDash.test(line)) violations.push({ file, line: i + 1, reason: "em-dash (use a single dash or restructure the sentence)" });
      if (emoji.test(line)) violations.push({ file, line: i + 1, reason: "emoji" });
    }
  }
  return violations;
}

/** Strips comments so a rule quoted in prose does not trip the gate. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;
// `(?![\\w-])` keeps `white-space` and `currentColor` from reading as colours.
const NAMED_COLOR = /(?:^|[\s:,(])(white|black|red|green|blue|yellow|orange|purple|gray|grey)(?![\w-])/;
// `(?!\\s)` pins the lookahead to the value: without it the greedy `\\s*` backtracks
// to zero spaces and the lookahead inspects the space instead of the value.
const FONT_SIZE = /^\s*font-size\s*:\s*(?!\s)(?!var\(--fw-)(?!inherit|max\(|min\(|clamp\(|0\.?\d*em\b)/;
const Z_INDEX = /^\s*z-index\s*:\s*(?!\s)(?!var\(--fw-)/;
const CONTAINER_QUERY = /@container\s+[\w-]*\s*\((?:min|max)-width\s*:\s*([^)]+)\)/g;

function findTokenViolations(): Violation[] {
  const files: string[] = [];
  listFiles(path.join(webviewRoot, "src"), /\.css$/, files);
  const violations: Violation[] = [];
  for (const file of files) {
    const isTokens = file === tokensFile;
    const css = stripComments(fs.readFileSync(file, "utf8"));
    const lines = css.split("\n");
    const selectors = new Map<string, number>();
    let depth = 0;
    // A selector list can span lines before its `{`; the rule is keyed on the
    // whole list so a group and a lone selector are two different rules.
    let selectorLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNumber = i + 1;
      if (!isTokens) {
        // A literal colour anywhere outside tokens.css. `transparent`,
        // `currentColor`, and `inherit` are structural, not palette.
        if (HEX_COLOR.test(line)) violations.push({ file, line: lineNumber, reason: "hex colour; use a --fw-* token" });
        if (COLOR_FUNCTION.test(line) && !/color-mix\(/.test(line)) violations.push({ file, line: lineNumber, reason: "colour function; use a --fw-* token" });
        if (NAMED_COLOR.test(line)) violations.push({ file, line: lineNumber, reason: "named colour; use a --fw-* token" });
        if (FONT_SIZE.test(line)) violations.push({ file, line: lineNumber, reason: "font-size literal; use a --fw-text-* token" });
        if (Z_INDEX.test(line)) violations.push({ file, line: lineNumber, reason: "z-index literal; use a --fw-z-* token" });
      }
      for (const match of line.matchAll(CONTAINER_QUERY)) {
        const width = (match[1] ?? "").trim();
        if (!CONTAINER_WIDTHS.has(width)) violations.push({ file, line: lineNumber, reason: `container width ${width} is off the ladder (${[...CONTAINER_WIDTHS].join(", ")})` });
      }
      // Duplicate top-level selectors: two rule blocks for one selector list in
      // one file is a later block silently overriding an earlier one.
      if (depth === 0) {
        const open = line.indexOf("{");
        if (open < 0) {
          if (line.trim().length > 0) selectorLines.push(line.trim());
        } else {
          const selector = [...selectorLines, line.slice(0, open)].join(" ").trim().replace(/\s+/g, " ");
          selectorLines = [];
          if (selector.length > 0 && !selector.startsWith("@")) {
            const first = selectors.get(selector);
            if (first !== undefined) violations.push({ file, line: lineNumber, reason: `selector "${selector}" already declared at line ${first}` });
            else selectors.set(selector, lineNumber);
          }
        }
      }
      for (const char of line) {
        if (char === "{") depth += 1;
        else if (char === "}") depth = Math.max(0, depth - 1);
      }
    }
  }
  return violations;
}

interface StepResult {
  name: string;
  output: string;
  failed: boolean;
}

async function runCommand(name: string, command: string[], env?: { [key: string]: string | undefined }): Promise<StepResult> {
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { name, output: stdout + stderr, failed: exitCode !== 0 };
}

function report(name: string, violations: Violation[]): StepResult {
  return {
    name,
    output: violations.map((v) => `${path.relative(repoRoot, v.file)}:${v.line}: ${v.reason}\n`).join(""),
    failed: violations.length > 0,
  };
}

async function main(): Promise<void> {
  const [typecheck, oxlint] = await Promise.all([
    runCommand("tsc (webview project)", ["bunx", "--bun", "tsc", "-p", "webview/tsconfig.json"]),
    runCommand("oxlint (webview)", ["bunx", "--bun", "oxlint", "--deny-warnings", "--config", "oxlint.config.ts", ...sourceRoots.filter((root) => fs.existsSync(path.join(repoRoot, root)))], {
      NAPI_RS_NATIVE_LIBRARY_PATH: "",
    }),
  ]);

  const oversized = sourceRoots.flatMap((root) => (fs.existsSync(path.join(repoRoot, root)) ? findOversizedFiles(path.join(repoRoot, root), SRC_MAX_LINES) : []));
  const fileSize: StepResult = {
    name: "file-size (webview)",
    output: oversized.map((v) => `${path.relative(repoRoot, v.file)} has ${v.lines} lines of code (max ${v.max}; blank/comment lines don't count)\n`).join(""),
    failed: oversized.length > 0,
  };

  const steps = [typecheck, oxlint, fileSize, report("style (webview)", findStyleViolations()), report("tokens (webview styles)", findTokenViolations())];
  let anyFailed = false;
  for (const step of steps) {
    if (!step.failed) continue;
    anyFailed = true;
    process.stdout.write(`--- ${step.name} ---\n`);
    process.stdout.write(step.output.endsWith("\n") || step.output === "" ? step.output : `${step.output}\n`);
  }
  if (!anyFailed) process.stdout.write("webview lint passed.\n");
  process.exit(anyFailed ? 1 : 0);
}

await main();
