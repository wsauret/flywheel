import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { findOversizedFiles, SRC_MAX_LINES } from "./check-file-sizes.ts";

// The relay workspace is two deployables in one TypeScript project: the Worker
// and the hosted phone page. Neither is reached by the root lint steps, so this step
// binds relay/ to the same gates: the project typecheck, oxlint with the
// repository config, the file-size cap, and the prose bans (em-dashes and
// emoji in source and docs).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const relayRoot = path.join(repoRoot, "relay");
const sourceRoots = ["relay/worker/src", "relay/worker/test", "relay/app/bootstrap.ts", "relay/app/bootstrap-css.test.ts", "relay/app/client-choice.ts", "relay/app/client-choice.test.ts", "relay/app/device-store.ts", "relay/app/device-store.test.ts", "relay/app/page-start.ts", "relay/app/page-start.test.ts", "relay/app/sw", "relay/app/build.ts", "relay/app/serve.ts"];

const nonSourceDirs = new Set(["node_modules", "dist", ".wrangler"]);

interface StyleViolation {
  file: string;
  line: number;
  reason: string;
}

const emDash = /—/u;
const emoji = /\p{Extended_Pictographic}|️/u;

function listFiles(dirPath: string, out: string[]): void {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (nonSourceDirs.has(entry.name)) continue;
      listFiles(full, out);
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx|md|json|jsonc|html|css|webmanifest)$/.test(entry.name)) out.push(full);
  }
}

function findStyleViolations(): StyleViolation[] {
  const files: string[] = [];
  listFiles(relayRoot, files);
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
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { name, output: stdout + stderr, failed: exitCode !== 0 };
}

async function main(): Promise<void> {
  const existingRoots = sourceRoots.filter((root) => fs.existsSync(path.join(repoRoot, root)));
  const [workerTypes, appTypes, workerScriptTypes, oxlint] = await Promise.all([
    runCommand("tsc (relay worker)", ["bunx", "--bun", "tsc", "-p", "relay/worker/tsconfig.json"]),
    runCommand("tsc (relay app)", ["bunx", "--bun", "tsc", "-p", "relay/app/tsconfig.json"]),
    runCommand("tsc (relay service worker)", ["bunx", "--bun", "tsc", "-p", "relay/app/sw/tsconfig.json"]),
    runCommand("oxlint (relay)", ["bunx", "--bun", "oxlint", "--deny-warnings", "--config", "oxlint.config.ts", ...existingRoots], { NAPI_RS_NATIVE_LIBRARY_PATH: "" }),
  ]);
  const oversized = existingRoots.filter((root) => fs.statSync(path.join(repoRoot, root)).isDirectory()).flatMap((root) => findOversizedFiles(path.join(repoRoot, root), SRC_MAX_LINES));
  const fileSize: StepResult = {
    name: "file-size (relay)",
    output: oversized.map((v) => `${path.relative(repoRoot, v.file)} has ${v.lines} lines of code (max ${v.max}; blank/comment lines don't count)\n`).join(""),
    failed: oversized.length > 0,
  };
  const style = findStyleViolations();
  const steps = [workerTypes, appTypes, workerScriptTypes, oxlint, fileSize, { name: "style (relay)", output: style.map((v) => `${path.relative(repoRoot, v.file)}:${v.line}: ${v.reason}\n`).join(""), failed: style.length > 0 }];
  let anyFailed = false;
  for (const step of steps) {
    if (!step.failed) continue;
    anyFailed = true;
    process.stdout.write(`--- ${step.name} ---\n`);
    process.stdout.write(step.output.endsWith("\n") || step.output === "" ? step.output : `${step.output}\n`);
  }
  if (!anyFailed) process.stdout.write("relay lint passed.\n");
  process.exit(anyFailed ? 1 : 0);
}

await main();
