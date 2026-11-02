import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enterValidationLane } from "./validation-lane.js";

// A URL keeps its own separators and its leading slash, so `pathname` reads
// `/C:/repo` on Windows and every `join` below it builds the invalid `\C:\repo`.
// `fileURLToPath` returns a native path on all platforms, and it decodes the
// percent-escapes that a directory name with spaces carries.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(join(repoRoot, "node_modules/.cache"), { recursive: true });

// Each step is declared as a `lint:*` script in package.json so its commands
// and dependencies stay visible to knip's dependency analysis.
const stepNames = ["tsc", "test-types", "bench", "model-catalog", "provider-model-literals", "oxlint", "knip", "knip-production", "files", "filenames", "terminal-io", "safety", "owned-processes", "worker-ownership", "generated-docs", "doc-coherence", "doc-src-paths", "terminology", "intent", "diagnostics", "fact-retention", "module-containment", "projections", "skills", "vscode", "webview", "relay", "licenses"] as const;

// The maintainer's private companion checkout adds its check that the public
// tree names no other coding-agent harness. A checkout without private/ has no
// such step.
const harnessNames = join(repoRoot, "private/scripts/check-harness-names.ts");
const steps = [
  ...stepNames.map((name) => ({ name, command: ["bun", "run", `lint:${name}`] })),
  ...(existsSync(harnessNames) ? [{ name: "harness-names", command: ["bun", "run", harnessNames] }] : []),
];

// Every step starts at once by default. Together they need about 10 GB, so a
// machine with less memory, such as a hosted CI runner, sets LINT_CONCURRENCY
// to run at most that many steps at a time.
const concurrencyOverride = process.env.LINT_CONCURRENCY?.trim() ?? "";
if (concurrencyOverride !== "" && !/^[1-9][0-9]*$/.test(concurrencyOverride)) {
  process.stderr.write(`lint-parallel: LINT_CONCURRENCY must be a positive integer, got "${concurrencyOverride}"\n`);
  process.exit(1);
}
const concurrency = concurrencyOverride === "" ? steps.length : Number(concurrencyOverride);

const leaveLane = await enterValidationLane("lint");
const start = performance.now();
const pending = [...steps];
const results: { name: string; output: string; exitCode: number; elapsed: number }[] = [];
await Promise.all(Array.from({ length: Math.min(concurrency, steps.length) }, async () => {
  for (let step = pending.shift(); step !== undefined; step = pending.shift()) results.push(await runStep(step));
}));

async function runStep({ name, command }: (typeof steps)[number]) {
  const stepStart = performance.now();
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    name,
    output: stdout + stderr,
    exitCode,
    elapsed: (performance.now() - stepStart) / 1000,
  };
}

const totalElapsed = (performance.now() - start) / 1000;
leaveLane();

results.sort((a, b) => a.elapsed - b.elapsed);

let anyFailed = false;
for (const r of results) {
  const status = r.exitCode === 0 ? "ok  " : "FAIL";
  process.stdout.write(`[${status}] ${r.name.padEnd(7)} ${r.elapsed.toFixed(2)}s\n`);
  if (r.exitCode !== 0) anyFailed = true;
}

if (anyFailed) {
  for (const r of results) {
    if (r.exitCode === 0) continue;
    process.stdout.write(`\n--- ${r.name} ---\n`);
    process.stdout.write(r.output);
  }
}

process.stdout.write(`\n${anyFailed ? "Lint failed" : "Lint passed"} in ${totalElapsed.toFixed(2)}s\n`);
process.exit(anyFailed ? 1 : 0);
