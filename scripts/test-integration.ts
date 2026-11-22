/** The integration suite, run inside the validation lane in one of five modes:
 *
 *  - `no-api`: every file under tests/integration except the providers
 *    directory. It needs no credentials and costs nothing, so it is the gate
 *    before a commit and in release readiness.
 *  - `api`: tests/integration/providers, which serve real requests on the
 *    auth profile that `FLYWHEEL_LIVE_AUTH_PROFILE` names through production
 *    routing, so a subscription or an API key pays for them. It fails when
 *    the setting is unset or that profile cannot serve the live model. Its
 *    Claude engine tier runs on the Claude login of the same profile, from
 *    included usage only, and fails without that login.
 *  - `claude-engine`: that Claude engine tier alone, which is what readiness
 *    owes on an engine bump. It needs only the Claude login, so it runs on a
 *    host's release login home, which holds no other credential.
 *  - `antigravity-engine`: the Antigravity CLI's fake-host tier alone, which
 *    `no-api` also runs. Readiness runs it in a Linux container on an agy bump.
 *  - `all`: `no-api` and `api`, in that order.
 *
 *  The suite is the directory, not a list of files, so a new integration file
 *  runs without a registration step and no file can fall out of every gate.
 *  The guardian test runs in its own `bun test` process because it owns the
 *  process tree it verifies and must not share a run with siblings that spawn
 *  their own. Every process gets a private TMPDIR and fails on leftovers.
 *
 *  Integration tests outside the providers directory run the real pinned
 *  Antigravity CLI against a fake host, from the checkout's verified copy. So
 *  the modes that run them first prepare that copy for this host. The lane
 *  admits the run first, because preparation hashes the executable and a
 *  first preparation downloads it. */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildPlatformArch } from "../src/infra/native-assets.js";
import { prepareAntigravityEngine } from "./antigravity-engine-asset.js";
import { createTestTempGuard, formatTempLeaks, type TempLeak } from "./test-temp-guard.js";
import { enterValidationLane } from "./validation-lane.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const coverageDir = process.env.FLYWHEEL_COVERAGE_DIR;
const API_SUITE = "tests/integration/providers";
const GUARDIAN = "tests/integration/local/owned-subprocess-guardian.test.ts";
const ANTIGRAVITY_SUITE = "tests/integration/orchestration/modules/provider-google-antigravity";
type Run = readonly [label: string, args: readonly string[]];
const NO_API_RUNS: readonly Run[] = [
  ["suite", ["tests/integration", `--path-ignore-patterns=${API_SUITE}/**`, `--path-ignore-patterns=${GUARDIAN}`]],
  ["guardian", [GUARDIAN]],
];
const API_RUNS: readonly Run[] = [["api", [API_SUITE]]];
const ANTIGRAVITY_MODES: ReadonlySet<string> = new Set(["no-api", "antigravity-engine", "all"]);
const MODES: ReadonlyMap<string, readonly Run[]> = new Map([
  ["no-api", NO_API_RUNS],
  ["api", API_RUNS],
  ["claude-engine", [["claude-engine", [`${API_SUITE}/claude-sdk-subscription-real.test.ts`]]]],
  ["antigravity-engine", [["antigravity-engine", [ANTIGRAVITY_SUITE]]]],
  ["all", [...NO_API_RUNS, ...API_RUNS]],
]);

const mode = process.argv[2] ?? "";
const runs = MODES.get(mode);
if (!runs) {
  process.stderr.write(`usage: bun run scripts/test-integration.ts <${[...MODES.keys()].join("|")}>\n`);
  process.exit(2);
}

/** Whether this host's pinned Antigravity CLI is ready. A failure is reported with the command that repeats it. */
async function antigravityEnginePrepared(): Promise<boolean> {
  try {
    await prepareAntigravityEngine(repoRoot, buildPlatformArch());
    return true;
  } catch (error) {
    process.stderr.write(`The pinned Antigravity CLI could not be prepared: ${error instanceof Error ? error.message : String(error)}\nRun bun run engine:antigravity:prepare, then run this suite again.\n`);
    return false;
  }
}

const leave = await enterValidationLane(`integration:${mode}`);
const tempGuard = createTestTempGuard();
const tempLeaks: TempLeak[] = [];
let child: Bun.Subprocess | undefined;
let interrupted: NodeJS.Signals | undefined;
const cancel = (signal: NodeJS.Signals) => {
  interrupted = signal;
  child?.kill("SIGKILL");
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  if (ANTIGRAVITY_MODES.has(mode) && !(await antigravityEnginePrepared())) process.exitCode = 1;
  for (const [label, args] of process.exitCode ? [] : runs) {
    if (interrupted) break;
    const proc = Bun.spawn(["bun", "test", ...(coverageDir ? ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${join(coverageDir, label)}`] : []), ...args], {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...tempGuard.env(label) },
      windowsHide: true,
    });
    child = proc;
    const exitCode = await proc.exited;
    child = undefined;
    if (interrupted) break;
    const leak = tempGuard.collect(label);
    if (leak) tempLeaks.push(leak);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      break;
    }
  }
  // A leaked temporary entry fails the suite even when every case passed,
  // because it costs the developer's TMPDIR on every later run.
  if (tempLeaks.length > 0) {
    process.stdout.write(formatTempLeaks(tempLeaks));
    process.exitCode ||= 1;
  }
} finally {
  if (child) { child.kill("SIGKILL"); await child.exited; }
  tempGuard.dispose();
  leave();
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
}
