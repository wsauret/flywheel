/** Local release performance gate.
 *
 *  Runs on the operator machine so no GitHub Actions minutes are spent:
 *  install the candidate host-platform archive the way a user installs it
 *  (its own HOME, so nothing touches the operator's real install), fetch the
 *  release the public repository serves as `latest` and install it the same
 *  way, then drive both through the release performance suite. Absolute
 *  ceilings always apply; relative tolerances apply when the baseline exists,
 *  and both binaries are measured by the same process on the same machine so
 *  machine variance cancels. Only a proven "no published release" runs the
 *  gate absolute-only; a baseline fetch that merely failed fails the gate.
 *
 *  Usage:
 *    bun run test:perf                      # everyday startup gate; builds the host archive first
 *    bun run test:perf:release              # the full scenario set a release must pass
 *    bun run test:perf --archive <tar.gz>   # gates an already-built archive
 *
 *  `test:perf` runs the startup set: the local startup scenarios and the remote
 *  first attach, a terminal that opens a paired machine's project through a
 *  relay on loopback, whose 20 percent regression rule is the everyday
 *  contract for any change that can affect startup. `test:perf:release` adds
 *  the absolute-ceiling scenarios (modal, runner reconciliation, scroll,
 *  account service); `bun run release` runs it with --archive so the archive
 *  that passes the gate is byte-identical to the archive it publishes.
 *  The pinned pre-D workflow comparison is a one-time design acceptance, not
 *  a release prerequisite. Set FLYWHEEL_RELEASE_BASELINE_DRIVER to its verified
 *  manifest to enable it. Published reconciliation drivers are materialized
 *  from the local release tag and cached with the archive; fetch missing tags
 *  with `git fetch --tags`. FLYWHEEL_RELEASE_PUBLISHED_DRIVER overrides that cache.
 *
 *  The published baseline for one tag never changes, so its install is kept
 *  under the gate directory and reused across gate runs; only the measurement
 *  is repeated, in the same run as the candidate, so the A/B stays fair.
 *
 *  Everything the gate makes lives under ~/.cache/flywheel/perf-gate, never
 *  under the system temp directory: Bun walks a process's working directory
 *  ancestors at startup, and a temp directory that has collected hundreds of
 *  thousands of entries adds 200 to 700 ms to every process boot. Startup is
 *  a chain of process boots, so a workspace under such a directory measured
 *  twice the real startup time. The gate keeps one run; the previous run's
 *  installs and evidence are removed when the next one starts.
 *
 *  Every process the gate starts, its installs and the suite runner included,
 *  carries the release harness marker in its environment, and every process
 *  those start inherits it, down to an account service a client relaunched
 *  into a process group of its own. Each one also names the run directory or
 *  the baseline cache in its environment or command line, because it runs a
 *  binary installed there or with a home there. The sweep matches a process
 *  only by both, from the live process table (tests/helpers/
 *  real-process-fixture.ts `stopHarnessProcesses`), so it never matches the
 *  operator's own services and still finds a process whose run directory is
 *  gone. The gate sweeps its run at exit, whatever the path (a pass, a
 *  failure, or an interrupt), and sweeps the whole gate directory when it
 *  starts, for a gate that was killed before its exit ran. The gate exits 1
 *  when a process survives a sweep.
 *
 *  Exit code 1 on any budget violation or scenario failure. Evidence lands in
 *  the run directory the script prints.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { enterValidationLane } from "./validation-lane.js";

import { createTimeline, type TimelineEntry } from "../tests/release/lib/timeline.js";
import { tarExecutable } from "./readiness-package-smoke.js";
import { downloadReleaseAsset, latestReleaseTag } from "./release-repo.js";
import { RELEASE_HARNESS_ENVIRONMENT, stopHarnessProcesses, type TaggedProcess } from "../tests/helpers/real-process-fixture.js";
import { readRevisionDriver } from "../tests/release/lib/revision-driver.js";
import { ACCOUNT_WINDOWS_TASK } from "../src/orchestration/app-service/account-service-registration.js";

/** Selects comparison families and validates an explicitly supplied pinned driver. */
export function comparisonPlan(manifestPath?: string) {
  return {
    comparisons: manifestPath ? ["published", "workflow"] as const : ["published"] as const,
    driver: manifestPath ? readRevisionDriver(manifestPath) : undefined,
  };
}

/** Resolves the published manifest override or its persistent per-tag cache path. */
export function publishedDriverPath(cache: string, override?: string): string {
  return override ?? join(cache, "driver", "published-driver.json");
}

function fail(reason: string): never {
  console.error(`perf-gate: ${reason}`);
  process.exit(1);
}

function listed(processes: readonly TaggedProcess[]): string {
  return processes.map(({ pid, command }) => `\n  ${pid} ${command}`).join("");
}

/** The environment of every process the gate starts: the release harness
 *  marker, which the gate's sweeps match, over the gate's own environment.
 *  An inherited FLYWHEEL_AUTH_PROFILE is dropped: every process runs in an
 *  isolated account home that holds no auth profiles, so an operator's
 *  profile cannot exist there and would fail every measured launch. */
function gateEnvironment(env: { readonly [name: string]: string } = {}) {
  const { FLYWHEEL_AUTH_PROFILE: _operatorProfile, ...inherited } = process.env;
  return { ...inherited, ...RELEASE_HARNESS_ENVIRONMENT, ...env };
}

function run(command: string[], env?: { [name: string]: string }, cwd?: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit", env: gateEnvironment(env), windowsHide: true });
  if (result.exitCode !== 0) fail(`\`${command.join(" ")}\` failed with exit code ${result.exitCode}`);
}

/** A command the gate runs only to read the machine's state. */
export type StateQuery = (command: readonly string[]) => { readonly exitCode: number; readonly stdout: string };

const queryState: StateQuery = (command) => {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe", env: gateEnvironment(), windowsHide: true });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
};

const repository = join(import.meta.dir, "..");
const ACCOUNT_TASK_QUERY = ["schtasks", "/Query", "/TN", ACCOUNT_WINDOWS_TASK, "/XML"];
/** Every task the user can read, one CSV row each with the task's full path first. */
const TASK_LIST_QUERY = ["schtasks", "/Query", "/FO", "CSV", "/NH"];

/** The account task's definition, or nothing when Task Scheduler holds no
 *  task. A failed query states its cause in the display language, so only a
 *  task list that does not name the task proves it absent; any other answer
 *  throws, because a guard that cannot read the task cannot tell a change. */
function accountTaskDefinition(query: StateQuery): string | undefined {
  const definition = query(ACCOUNT_TASK_QUERY);
  if (definition.exitCode === 0) return definition.stdout.trim();
  const list = query(TASK_LIST_QUERY);
  const row = `"\\${ACCOUNT_WINDOWS_TASK}",`.toLowerCase();
  if (list.exitCode === 0 && !list.stdout.split(/\r?\n/).some((line) => line.trim().toLowerCase().startsWith(row))) return undefined;
  throw new Error(`cannot read the "${ACCOUNT_WINDOWS_TASK}" scheduled task: \`${ACCOUNT_TASK_QUERY.join(" ")}\` exited ${definition.exitCode} and the task list does not prove the task absent`);
}

const taskCommand = (definition: string | undefined): string =>
  definition === undefined ? "(no task)" : /<Command>([^<]*)<\/Command>/.exec(definition)?.[1] ?? "(no <Command> element)";

/** Reads the account's "Flywheel Serve" task before the gate installs
 *  anything, and returns the check that reads it again when the gate exits.
 *  The task belongs to the operator's own installation, and a baseline
 *  installer or client that takes an isolated home for the login home
 *  registers or starts it from the gate's directory. The check states the
 *  change and the operator's repair; the gate never changes the task itself.
 *  Only Windows has the task, so another platform reads nothing. */
export function watchAccountTask(platform: NodeJS.Platform, query: StateQuery): () => string | undefined {
  if (platform !== "win32") return () => undefined;
  const before = accountTaskDefinition(query);
  return () => {
    let after: string | undefined;
    try {
      after = accountTaskDefinition(query);
    } catch (error) {
      return `${error instanceof Error ? error.message : String(error)}, so the gate cannot prove that it left the task unchanged`;
    }
    if (after === before) return undefined;
    const repair = before === undefined ? `schtasks /Delete /F /TN "${ACCOUNT_WINDOWS_TASK}"` : "flywheel serve install";
    return `this run changed the "${ACCOUNT_WINDOWS_TASK}" scheduled task, which starts this account's own Flywheel service.\n  <Command> before: ${taskCommand(before)}\n  <Command> after:  ${taskCommand(after)}\nThe gate does not change the task back. Repair it from this account's own installation: ${repair}`;
  };
}

/** The first commit whose installer and client find the Windows login home in
 *  the account database. An earlier build reads it from
 *  `HKCU\Volatile Environment`, which only an interactive desktop logon
 *  creates, and takes a failed read for "this home is the login home". */
const WINDOWS_LOGIN_HOME_FIX = "461a3fa056";

/** Why the gate must not install or run the baseline at `revision`, or nothing.
 *  Temporary: remove this check once the latest published release contains
 *  461a3fa056 (review by 2026-12-31). A baseline without the fix, on a machine
 *  where no person is logged on to the desktop, overwrites the operator's own
 *  account task with one that runs the gate's copy. A revision git cannot
 *  place counts as one without the fix. */
export function baselineLoginHomeRefusal(platform: NodeJS.Platform, revision: string, query: StateQuery): string | undefined {
  if (platform !== "win32") return undefined;
  if (query(["git", "-C", repository, "merge-base", "--is-ancestor", WINDOWS_LOGIN_HOME_FIX, revision]).exitCode === 0) return undefined;
  const profile = query(["reg", "query", String.raw`HKCU\Volatile Environment`, "/v", "USERPROFILE"]);
  if (profile.exitCode === 0 && /USERPROFILE\s+REG_\w+\s+\S/.test(profile.stdout)) return undefined;
  return `the baseline at ${revision} lacks ${WINDOWS_LOGIN_HOME_FIX} and finds the login home in HKCU\\Volatile Environment, which no desktop logon created on this machine, so its installer would overwrite this account's "${ACCOUNT_WINDOWS_TASK}" scheduled task. Run the Windows performance gate while a person is logged on to the desktop (a locked session counts), or from a desktop session.`;
}

/** The release suite's launch. The candidate, the evidence directory, and the
 *  work directory lie under the run directory, so its command line names the
 *  run, and its environment carries the harness marker: a sweep of the run
 *  ends the suite runner of a gate that was interrupted or killed. The work
 *  directory sits directly below the run, because each workspace below it
 *  holds an account socket whose path must stay within the unix limit. */
export function suiteLaunch(input: {
  readonly candidate: { readonly binary: string; readonly home: string };
  readonly baseline: { readonly binary: string; readonly home: string } | undefined;
  readonly set: string;
  readonly evidence: string;
  readonly work: string;
  readonly comparison?: "published" | "workflow";
}) {
  return {
    command: ["bun", "run", "tests/release/run.ts", "--binary", input.candidate.binary, "--binary-home", input.candidate.home, ...(input.baseline ? ["--baseline", input.baseline.binary, "--baseline-home", input.baseline.home] : []), "--set", input.set, "--out", input.evidence, "--work", input.work, ...(input.comparison ? ["--comparison", input.comparison] : [])],
    env: gateEnvironment(),
  };
}

const platformArch = `${process.platform}-${process.arch}`;
const archive = `flywheel-${platformArch}.tar.gz`;
const isWindows = process.platform === "win32";
const installedName = isWindows ? "flywheel.exe" : "flywheel";
const gateHome = process.env.FLYWHEEL_PERF_GATE_HOME ?? join(homedir(), ".cache", "flywheel", "perf-gate");
const baselines = join(gateHome, "baselines");
/** Every gate phase is timed here; the suite's own entries join it at the end. */
const timeline = createTimeline(console.log, "gate");

/** Install one archive's staging directory into its own HOME under `parent`
 *  so the embedded absolute paths of two installs never fight over `current`.
 *  The macOS and Linux installers, and the Windows installer from 461a3fa056
 *  on, read the login home from the account database and so register no
 *  account service under an isolated HOME. An earlier Windows installer reads
 *  it from `HKCU\Volatile Environment` and, where no desktop logon created
 *  that key, registers the gate's copy as the account's own task:
 *  `baselineLoginHomeRefusal` refuses that baseline before any install, and
 *  `watchAccountTask` proves the task unchanged at exit. The Windows
 *  installer is also told to leave the account PATH alone, so a gate install
 *  stays invisible to the operator's own installation. */
function install(stagingDir: string, parent: string, name: string) {
  const home = join(parent, `${name}-home`);
  const bin = join(parent, `${name}-bin`);
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (isWindows) run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(stagingDir, "install.ps1")], { HOME: home, FLYWHEEL_INSTALL_DIR: bin, FLYWHEEL_NO_MODIFY_PATH: "1" });
  else run(["bash", join(stagingDir, "install.sh")], { HOME: home, FLYWHEEL_INSTALL_DIR: bin });
  return { binary: join(bin, installedName), home };
}

/** The published baseline installed once per tag. The install embeds its own
 *  absolute paths, so it stays where it was installed; a marker written after
 *  the install completes tells a finished install from one a killed gate left
 *  behind, which is removed and redone. */
async function installedBaseline(tag: string): Promise<{ binary: string; home: string }> {
  const cache = join(baselines, `${tag}-${platformArch}`);
  const marker = join(cache, "installed");
  const binary = join(cache, "baseline-bin", installedName);
  const home = join(cache, "baseline-home");
  if (existsSync(marker)) {
    console.log(`perf-gate: reusing the installed ${tag} baseline at ${cache}`);
    return { binary, home };
  }
  rmSync(cache, { recursive: true, force: true });
  const archiveDir = join(cache, "archive");
  mkdirSync(archiveDir, { recursive: true });
  await timeline.time("download-baseline", () => downloadReleaseAsset(tag, archive, join(archiveDir, archive)));
  await timeline.time("extract-baseline", () => run([tarExecutable(), "-xzf", join(archiveDir, archive), "-C", archiveDir]));
  await timeline.time("install-baseline", () => install(join(archiveDir, `flywheel-${platformArch}`), cache, "baseline"));
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return { binary, home };
}

/** Resolves a cached driver or materializes it beside the installed archive.
 * Explicit overrides remain caller-owned and are validated by the suite. */
export function resolvePublishedDriver(
  tag: string,
  cache = join(baselines, `${tag}-${platformArch}`),
  materialize = materializePublishedDriver,
): string {
  const override = process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER;
  const manifest = publishedDriverPath(cache, override);
  if (override !== undefined) return manifest;
  if (existsSync(manifest)) {
    try {
      const driver = readRevisionDriver(manifest, tag);
      const outputRoot = resolve(cache, "driver");
      // Legacy hashes cover selected files, not the checkout's dependency closure.
      if (driver.sourceRoot !== outputRoot || driver.entrypoint !== join(outputRoot, "published-driver.js")) {
        throw new Error("cached published driver is not an owned bundle");
      }
      return manifest;
    } catch {
      console.log(`perf-gate: cached ${tag} driver failed validation; rematerializing at ${cache}`);
    }
  }
  materialize(tag, cache);
  readRevisionDriver(manifest, tag);
  return manifest;
}

/** The manifest is written last, so interrupted setup can resume. */
function materializePublishedDriver(tag: string, cache: string): void {
  const tagRef = `refs/tags/${tag}`;
  const identity = Bun.spawnSync(["git", "rev-parse", "--verify", `${tagRef}^{commit}`], {
    cwd: repository, env: gateEnvironment(), stdout: "inherit", stderr: "inherit", windowsHide: true,
  });
  if (identity.exitCode !== 0) fail(`published release tag ${tag} is not present locally; run \`git fetch --tags\` before retrying`);
  const source = join(cache, "source");
  if (!existsSync(source)) run(["git", "worktree", "add", "--detach", source, tagRef], undefined, repository);
  run(["bun", "install", "--frozen-lockfile"], undefined, source);
  run(["bun", "run", join(import.meta.dir, "../tests/release/lib/materialize-revision-driver.ts"),
    "--source", source, "--archive", join(cache, "archive", archive), "--out", join(cache, "driver"), "--tag", tag], undefined, repository);
}

/** The suite's timings.json entries re-based onto the gate clock and nested
 *  under the suite phase, so one file accounts for the whole gate run. */
function suiteEntries(evidence: string): TimelineEntry[] {
  const suite = timeline.entries().find((entry) => entry.label === "gate/suite");
  const file = join(evidence, "timings.json");
  if (suite === undefined || !existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) fail(`${file} is not a timings array`);
  return parsed.map((entry: TimelineEntry) => ({ ...entry, label: `gate/suite/${entry.label}`, startedAtMs: suite.startedAtMs + entry.startedAtMs }));
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Runs the gate. Tests import its comparison planning and launch contracts. */
async function runGate(): Promise<void> {
  // The suite drives the binary through tmux: the real one on macOS and Linux,
  // and psmux on Windows, which installs as `tmux` and answers the same commands.
  if (Bun.which("tmux") === null) fail(process.platform === "win32" ? "tmux is not installed; install psmux, which provides tmux on Windows" : "tmux is not installed");

  const givenArchive = argument("--archive");
  const set = argument("--set") ?? "startup";
  if (set !== "startup" && set !== "release") fail(`--set must be startup or release, got ${set}`);
  // The gate measures startup, so it needs the machine to itself: it takes the
  // validation lane the same way lint and the test suites do.
  await enterValidationLane("perf");

  // Another gate owns the gate directory until it leaves the lane, so the
  // previous runs' processes and files are removed only once this gate holds it.
  // The sweep reads the process table for the harness marker under the gate
  // directory, so it also ends a process whose run directory an earlier gate,
  // from this worktree or another, already removed.
  mkdirSync(gateHome, { recursive: true });
  const staleRuns = readdirSync(gateHome).filter((entry) => entry.startsWith("run-")).map((entry) => join(gateHome, entry));
  const staleSurvivors = stopHarnessProcesses([gateHome]);
  if (staleSurvivors.length > 0) fail(`processes a previous gate run started are still running:${listed(staleSurvivors)}`);
  for (const stale of staleRuns) rmSync(stale, { recursive: true, force: true });

  // Both Windows account-task guards run before anything installs. A cached
  // baseline is checked too: its client still starts the account task.
  const latest = await timeline.time("latest-release", () => latestReleaseTag());
  const refusal = latest === undefined ? undefined : baselineLoginHomeRefusal(process.platform, `refs/tags/${latest}`, queryState);
  if (refusal !== undefined) fail(refusal);
  let accountTaskChange: () => string | undefined;
  try {
    accountTaskChange = watchAccountTask(process.platform, queryState);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const root = mkdtempSync(join(gateHome, "run-"));
  // Ahead of the lane's own exit hook, so the next gate is admitted only once
  // this sweep has run; a signal exits through the same hook. The task is
  // read after the sweep, once no process of this run can change it.
  process.prependListener("exit", () => {
    const survivors = stopHarnessProcesses([root, baselines]);
    if (survivors.length > 0) {
      console.error(`perf-gate: processes this run started are still running:${listed(survivors)}`);
      process.exitCode = 1;
    }
    const taskChange = accountTaskChange();
    if (taskChange === undefined) return;
    console.error(`perf-gate: ${taskChange}`);
    process.exitCode = 1;
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) process.on(signal, () => process.exit(code));

  let candidateStaging: string;
  if (givenArchive === undefined) {
    console.log("perf-gate: building the candidate archive...");
    await timeline.time("build", () => run(["bun", "run", "build:binary"]));
    candidateStaging = join(import.meta.dir, "..", "dist", `flywheel-${platformArch}`);
  } else {
    const stagingRoot = join(root, "candidate-archive");
    mkdirSync(stagingRoot, { recursive: true });
    await timeline.time("extract-candidate", () => run([tarExecutable(), "-xzf", givenArchive, "-C", stagingRoot]));
    candidateStaging = join(stagingRoot, `flywheel-${platformArch}`);
  }
  const candidate = await timeline.time("install-candidate", () => install(candidateStaging, root, "candidate"));
  const manifestPath = process.env.FLYWHEEL_RELEASE_BASELINE_DRIVER;
  const plan = comparisonPlan(manifestPath);
  const driver = plan.driver;
  let pinned: { binary: string; home: string } | undefined;
  if (driver) {
    const pinnedStaging = join(root, "pre-d-archive");
    mkdirSync(pinnedStaging, { recursive: true });
    run([tarExecutable(), "-xzf", driver.archivePath, "-C", pinnedStaging]);
    pinned = install(join(pinnedStaging, `flywheel-${platformArch}`), root, "pre-d");
  } else console.log("perf-gate: skipping the pinned pre-D workflow comparison; set FLYWHEEL_RELEASE_BASELINE_DRIVER to a verified manifest to enable it");

  if (latest === undefined) console.log("perf-gate: the public repository serves no release; the gate runs absolute-only");
  const baseline = latest === undefined ? undefined : await installedBaseline(latest);
  if (set === "release" && latest !== undefined) {
    const publishedManifest = await timeline.time("published-driver", () => resolvePublishedDriver(latest));
    const verifiedDriver = readRevisionDriver(publishedManifest, latest);
    const publishedArchive = join(baselines, `${latest}-${platformArch}`, "archive", archive);
    if (createHash("sha256").update(readFileSync(publishedArchive)).digest("hex") !== verifiedDriver.archiveSha256) fail("published driver archive differs from the installed release");
    process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER = publishedManifest;
    process.env.FLYWHEEL_RELEASE_PUBLISHED_TAG = latest;
  }

  const evidence = join(root, "perf-evidence");
  mkdirSync(evidence, { recursive: true });
  const candidateArchive = givenArchive ?? join(import.meta.dir, "..", "dist", archive);
  writeFileSync(join(evidence, "artifacts.json"), `${JSON.stringify({
    candidate: {
      archive: candidateArchive,
      archiveSha256: createHash("sha256").update(readFileSync(candidateArchive)).digest("hex"),
      build: JSON.parse(readFileSync(join(candidateStaging, "build", "build.json"), "utf8")),
    },
    preD: driver ? { manifestPath, ...driver } : undefined,
    published: latest === undefined ? undefined : {
      tag: latest,
      archiveSha256: createHash("sha256").update(readFileSync(join(baselines, `${latest}-${platformArch}`, "archive", archive))).digest("hex"),
      driverManifest: process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER,
    },
  }, null, 2)}\n`);
  console.log(`perf-gate: running the ${set} performance set; evidence lands in ${evidence}`);
  // Spawned without blocking so an interrupt reaches the gate's exit hook while
  // the suite runs.
  let exitCode = 0;
  for (const comparison of plan.comparisons) {
    const workflow = comparison === "workflow";
    const suite = suiteLaunch({ candidate, baseline: workflow ? pinned : baseline, set,
      evidence: workflow ? join(evidence, "workflow") : evidence, work: join(root, workflow ? "wf" : "w"), comparison });
    const code = await timeline.time(workflow ? "workflow-suite" : "suite",
      () => Bun.spawn(suite.command, { env: suite.env, stdout: "inherit", stderr: "inherit", windowsHide: true }).exited);
    exitCode ||= code;
  }
  // The suite already printed its own breakdown; the gate adds the phases the
  // suite cannot see and writes the whole run to one file.
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "timings.json"), `${JSON.stringify([...timeline.entries(), ...suiteEntries(evidence)], null, 2)}\n`);
  console.log(`\nwhere the gate's time went:\n${timeline.summary()}`);
  console.log(`perf-gate: evidence: ${evidence}`);
  process.exit(exitCode);
}

if (import.meta.main) await runGate();
