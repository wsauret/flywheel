import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { findOversizedFiles, SRC_MAX_LINES } from "./check-file-sizes.ts";

// The VS Code extension tree is a separate TypeScript project (its own
// tsconfig, its own host constraints), so the root lint steps do not reach it.
// This step binds vscode/ to the same gates the rest of the repository runs:
// the extension project typecheck, oxlint with the repository config, the
// file-size cap, and the prose bans that no compiler carries (em-dashes and
// emoji in source and docs).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vscodeRoot = path.join(repoRoot, "vscode");
const sourceRoots = ["vscode/src", "vscode/scripts"];

// Dependencies and build output, not first-party source.
const nonSourceDirs = new Set(["node_modules", "out", "dist", "assets"]);

interface StyleViolation {
  file: string;
  line: number;
  reason: string;
}

// The em-dash is banned in all prose (AGENTS.md section 6); the emoji test is
// Unicode's own emoji-shaped class, which leaves keyboard glyphs and arrows
// (command and shift symbols in the walkthroughs) alone.
const emDash = /\u2014/u;
const emoji = /\p{Extended_Pictographic}|\uFE0F/u;

function listProseAndSourceFiles(dirPath: string, out: string[]): void {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (nonSourceDirs.has(entry.name)) continue;
      listProseAndSourceFiles(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(ts|tsx|md|json)$/.test(entry.name)) out.push(full);
  }
}

function findStyleViolations(): StyleViolation[] {
  const files: string[] = [];
  listProseAndSourceFiles(vscodeRoot, files);
  const violations: StyleViolation[] = [];
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

async function main(): Promise<void> {
  const [typecheck, oxlint] = await Promise.all([
    runCommand("tsc (vscode project)", ["bunx", "--bun", "tsc", "-p", "vscode/tsconfig.json"]),
    // NAPI_RS_NATIVE_LIBRARY_PATH is cleared the same way lint:oxlint clears it,
    // so the js plugins load through the same resolution path.
    runCommand("oxlint (vscode)", ["bunx", "--bun", "oxlint", "--deny-warnings", "--config", "oxlint.config.ts", ...sourceRoots], {
      NAPI_RS_NATIVE_LIBRARY_PATH: "",
    }),
  ]);

  const oversized = sourceRoots.flatMap((root) => findOversizedFiles(path.join(repoRoot, root), SRC_MAX_LINES));
  const fileSize: StepResult = {
    name: "file-size (vscode)",
    output: oversized
      .map((v) => `${path.relative(repoRoot, v.file)} has ${v.lines} lines of code (max ${v.max}; blank/comment lines don't count)\n`)
      .join(""),
    failed: oversized.length > 0,
  };

  const styleViolations = findStyleViolations();
  const style: StepResult = {
    name: "style (vscode)",
    output: styleViolations.map((v) => `${path.relative(repoRoot, v.file)}:${v.line}: ${v.reason}\n`).join(""),
    failed: styleViolations.length > 0,
  };

  let anyFailed = false;
  for (const step of [typecheck, oxlint, fileSize, style]) {
    if (!step.failed) continue;
    anyFailed = true;
    process.stdout.write(`--- ${step.name} ---\n`);
    process.stdout.write(step.output.endsWith("\n") || step.output === "" ? step.output : `${step.output}\n`);
  }

  if (!anyFailed) process.stdout.write("vscode lint passed.\n");
  process.exit(anyFailed ? 1 : 0);
}

await main();
