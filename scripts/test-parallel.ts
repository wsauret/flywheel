import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bandWeight, finishedFileDurations, readDurationRecord, recordDurations, writeDurationRecord } from "./test-durations.js";
import { createTestTempGuard, formatTempLeaks, type TempLeak } from "./test-temp-guard.js";
import { enterValidationLane } from "./validation-lane.js";

const testFileSuffixes = [".test.ts", ".test.tsx"] as const;

// Options that consume the next token as their value. Modelling them is what
// keeps a value such as `-t renders.test.ts` from being read as a requested
// test path. The equals form carries its own value, so it never consumes a
// token; flags with an optional value (`--bail`, `--inspect`) are left out
// because their separated token belongs to Bun, not to this list.
const valueTakingOptions = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "-t",
  "--test-name-pattern",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "-r",
  "--preload",
  "--require",
  "--import",
  "--conditions",
  "--env-file",
  "--cwd",
  "-c",
  "--config",
]);

export interface ClassifiedArg {
  arg: string;
  /** `positional` tokens are Bun's test path or filter arguments. */
  kind: "option" | "positional";
}

/**
 * Split `bun test` arguments into option and positional tokens, in the original
 * order. `--` ends option parsing, so every token after it is positional; the
 * value of a value-taking option is reported as an option token so no caller
 * mistakes it for a path.
 */
export function classifyBunTestArgs(args: readonly string[]): ClassifiedArg[] {
  const classified: ClassifiedArg[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      classified.push({ arg, kind: "positional" });
      continue;
    }
    classified.push({ arg, kind: "option" });
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.includes("=") || !valueTakingOptions.has(arg)) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) continue;
    classified.push({ arg: value, kind: "option" });
    i++;
  }
  return classified;
}

export interface RequestedTests {
  /** Absolute paths of existing focused test files. */
  files: string[];
  /** Absolute paths of existing directories to collect test files from. */
  dirs: string[];
  /** Tokens handed to Bun unchanged: options, their values, and name filters. */
  passThrough: string[];
  /** Requested test paths, as written, that do not exist. */
  missing: string[];
}

/**
 * Resolve command line arguments against `repoRoot` into the test files and
 * directories to run. A positional that names a test file or a path-like
 * request but does not exist is reported in `missing`; plain name filters pass
 * through to Bun. Empty `files` and `dirs` means the caller runs its full
 * default suite.
 */
function isRequestedTestPath(arg: string): boolean {
  return testFileSuffixes.some((suffix) => arg.endsWith(suffix)) || arg.includes("/") || arg.startsWith(".");
}

export function planRequestedTests(args: readonly string[], repoRoot: string): RequestedTests {
  const plan: RequestedTests = { files: [], dirs: [], passThrough: [], missing: [] };
  for (const { arg, kind } of classifyBunTestArgs(args)) {
    if (kind === "option") {
      plan.passThrough.push(arg);
      continue;
    }
    const fullPath = resolve(repoRoot, arg);
    const looksLikeTestFile = testFileSuffixes.some((suffix) => arg.endsWith(suffix));
    if (!existsSync(fullPath)) {
      if (isRequestedTestPath(arg)) plan.missing.push(arg);
      else plan.passThrough.push(arg);
      continue;
    }
    const stat = statSync(fullPath);
    if (stat.isDirectory()) plan.dirs.push(fullPath);
    else if (stat.isFile() && looksLikeTestFile) plan.files.push(fullPath);
    else plan.passThrough.push(arg);
  }
  return plan;
}

function collectTestFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectTestFiles(full, out);
      continue;
    }
    if (testFileSuffixes.some((suffix) => name.endsWith(suffix))) out.push(full);
  }
}

interface ShardResult {
  index: number;
  exitCode: number;
  passCount: number;
  failCount: number;
  elapsedMs: number;
}

/** Largest accepted `TEST_SHARDS` override. Each worker owns at most one
 *  `bun test` process at a time. Counts far above the core count add contention,
 *  and the ceiling rejects unbounded worker allocation. */
export const maxShardCount = 64;

/**
 * Resolve the shard count from the `TEST_SHARDS` override. An unset or empty
 * variable means no override, so `fallback` applies. Any other value must be a
 * decimal integer from 1 to `maxShardCount`; `null` reports an override the
 * caller must reject instead of clamping, because a silently clamped shard
 * count changes which tests share a process.
 */
export function parseShardCount(raw: string | undefined, fallback: number): number | null {
  return parseCountOverride(raw, fallback, maxShardCount);
}

/** The hang guard ends a run whose test execution passes this many seconds. */
export const defaultHangGuardSeconds = 90;

/** Largest accepted `TEST_HANG_GUARD_SECONDS` override: one hour. A run that
 *  needs more than that is hung on any machine. */
export const maxHangGuardSeconds = 3_600;

/**
 * Resolve the hang guard from the `TEST_HANG_GUARD_SECONDS` override, with the
 * same rules as `parseShardCount`. The default suits a development machine. A
 * machine with fewer or slower cores, such as a hosted CI runner, runs every
 * band for longer, and only this override lets it finish.
 */
export function parseHangGuardSeconds(raw: string | undefined): number | null {
  return parseCountOverride(raw, defaultHangGuardSeconds, maxHangGuardSeconds);
}

function parseCountOverride(raw: string | undefined, fallback: number, max: number): number | null {
  const override = raw?.trim() ?? "";
  if (override === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(override)) return null;
  const count = Number(override);
  return count <= max ? count : null;
}

/** Balance sorted, unique paths across one process per worker. Small contiguous
 *  chunks retain module locality, while longest-first placement spreads a slow
 *  domain across every worker instead of leaving one process with the tail.
 *  One process per worker also avoids paying Bun startup and module loading in
 *  a second wave. A single worker retains original-order execution semantics.
 *
 *  A band must also `fit`: Windows caps the length of a command line, and a
 *  band's files are its arguments. Until every band fits, the plan adds one
 *  band for each worker, so each worker still runs the same number of bands
 *  and the extra wave costs each worker one Bun startup, never a tail on one
 *  worker. A single worker's bands stay contiguous and in order. */
export function planTestBands(files: readonly string[], workerCount: number, weight: (file: string) => number = () => 1, fits: (band: readonly string[]) => boolean = () => true): string[][] {
  if (files.length === 0) return [];
  for (let waves = 1; ; waves++) {
    const bands = workerCount === 1 ? contiguousBands(files, waves) : balancedBands(files, Math.min(workerCount * waves, files.length), weight);
    if (bands.length === files.length || bands.every(fits)) return bands;
  }
}

function contiguousBands(files: readonly string[], count: number): string[][] {
  const size = Math.ceil(files.length / count);
  return Array.from({ length: Math.ceil(files.length / size) }, (_, index) => files.slice(index * size, (index + 1) * size));
}

function balancedBands(files: readonly string[], processCount: number, weight: (file: string) => number): string[][] {
  const chunkSize = Math.max(1, Math.ceil(files.length / (processCount * 32)));
  type TestChunk = { readonly start: number; readonly files: readonly string[]; readonly weight: number };
  interface PlannedProcess { index: number; weight: number; chunks: TestChunk[] }
  const chunks: TestChunk[] = [];
  for (let start = 0; start < files.length; start += chunkSize) {
    const chunkFiles = files.slice(start, start + chunkSize);
    chunks.push({
      start,
      files: chunkFiles,
      weight: chunkFiles.reduce((total, file) => total + Math.max(1, weight(file)), 0),
    });
  }
  const processes: PlannedProcess[] = Array.from({ length: processCount }, (_, index) => ({ index, weight: 0, chunks: [] }));
  for (const chunk of chunks.toSorted((left, right) => right.weight - left.weight || left.start - right.start)) {
    const process = processes.reduce((lightest, candidate) =>
      candidate.weight < lightest.weight || (candidate.weight === lightest.weight && candidate.index < lightest.index)
        ? candidate
        : lightest);
    process.chunks.push(chunk);
    process.weight += chunk.weight;
  }
  return processes.map((process) => process.chunks.toSorted((left, right) => left.start - right.start).flatMap((chunk) => chunk.files));
}

export interface RunOutcome {
  readonly failed: boolean;
  readonly overBudget: boolean;
  readonly budgetAdvisory: boolean;
  readonly leaked: boolean;
}

/** Whether a finished run exits non-zero. A failed or crashed shard and a
 *  leaked temporary entry always fail it; the duration budget fails it unless
 *  `TEST_BUDGET=advisory` made the budget a report only. */
export function runFails(outcome: RunOutcome): boolean {
  return outcome.failed || (outcome.overBudget && !outcome.budgetAdvisory) || outcome.leaked;
}

/** The band's files as `bun test` arguments: repo-relative paths, which the
 *  band process resolves against its `cwd` of `repoRoot`. Windows caps a
 *  command line at 32,767 characters, and absolute paths repeat the
 *  checkout's path once for every file. The leading `./` makes Bun read each
 *  argument as a path, never as a name filter that also matches longer names. */
export function bandFileArguments(files: readonly string[], repoRoot: string): string[] {
  return files.map((file) => `.${sep}${relative(repoRoot, file)}`);
}

/** Windows refuses to start a process whose command line, with its
 *  terminating null, is longer than this many characters. */
const windowsCommandLineLimit = 32_767;

/** Whether Windows can start `argv`. The command line joins the arguments
 *  with spaces and quotes an argument that is empty or holds a space, a tab,
 *  or a quote. A quoted argument with a quote or a backslash also gets
 *  escapes, which are counted at their most: one for each character. */
export function fitsWindowsCommandLine(argv: readonly string[]): boolean {
  const length = argv.reduce((total, arg) => {
    if (arg !== "" && !/[ \t"]/.test(arg)) return total + arg.length + 1;
    return total + (/["\\]/.test(arg) ? 2 * arg.length : arg.length) + 3;
  }, 0);
  return length <= windowsCommandLineLimit;
}

/** Run each band once under a fixed process limit. Completion releases the
 *  worker for the next band; results retain input order, regardless of timing. */
export async function runTestBands<T>(
  bands: readonly string[][],
  workerCount: number,
  run: (files: readonly string[], bandIndex: number, workerIndex: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  let nextBand = 0;
  await Promise.all(Array.from({ length: Math.min(workerCount, bands.length) }, async (_, workerIndex) => {
    while (nextBand < bands.length) {
      const bandIndex = nextBand++;
      results[bandIndex] = await run(bands[bandIndex]!, bandIndex, workerIndex);
    }
  }));
  return results;
}

interface TestFileTiming {
  readonly file: string;
  readonly elapsedMs: number;
  readonly running: boolean;
}

/** Reads Bun's file headings as stderr arrives, so a timed-out shard still
 *  reports its current file. These are wall times, including file loading. */
export function createShardProgress(now: () => number = performance.now.bind(performance)) {
  const finished: TestFileTiming[] = [];
  let current: { file: string; started: number } | undefined;
  let pending = "";
  function finishCurrent(): void {
    if (current) finished.push({ file: current.file, elapsedMs: now() - current.started, running: false });
    current = undefined;
  }
  return {
    append(chunk: string): void {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const file = /^(.+\.test\.tsx?):\s*$/.exec(line)?.[1];
        if (!file) continue;
        finishCurrent();
        current = { file, started: now() };
      }
    },
    finish(output: string): void {
      if (/^Ran \d+ tests? across \d+ files?\./m.test(output)) finishCurrent();
    },
    snapshot(): readonly TestFileTiming[] {
      return current ? [...finished, { file: current.file, elapsedMs: now() - current.started, running: true }] : [...finished];
    },
  };
}

/** Waits for killed shards to exit and returns those that have not settled. */
export async function waitForShardExits<T extends { readonly exited: Promise<number> }>(processes: readonly T[], timeoutMs: number): Promise<T[]> {
  const pending = new Set(processes);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(processes.map(async (proc) => {
        try { await proc.exited; } finally { pending.delete(proc); }
      })),
      new Promise<void>((done) => { deadline = setTimeout(done, timeoutMs); }),
    ]);
    return [...pending];
  } finally {
    clearTimeout(deadline);
  }
}

async function readShardOutput(stream: ReadableStream<Uint8Array>, progress?: ReturnType<typeof createShardProgress>): Promise<string> {
  if (!progress) return await new Response(stream).text();
  const decoder = new TextDecoder();
  let output = "";
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true });
    output += chunk;
    progress.append(chunk);
  }
  output += decoder.decode();
  return output;
}

function printShardProgress(index: number, progress: ReturnType<typeof createShardProgress> | undefined): void {
  if (!progress) return;
  const timings = progress.snapshot();
  const current = timings.find((entry) => entry.running);
  if (current) process.stdout.write(`shard ${index + 1} current: ${current.file} (${(current.elapsedMs / 1000).toFixed(2)}s)\n`);
  for (const timing of timings.filter((entry) => !entry.running).toSorted((left, right) => right.elapsedMs - left.elapsedMs).slice(0, 3)) {
    process.stdout.write(`shard ${index + 1} slow file: ${(timing.elapsedMs / 1000).toFixed(2)}s ${timing.file}\n`);
  }
}

const FILE_HEADING = /^.+\.test\.tsx?:\s*$/;
const PASSING_RESULT = /^\((?:pass|skip|todo)\) /;

/** The output of a band as `--only-failures` would print it: a band that
 *  reads its file headings runs without that flag, so its passing, skipped,
 *  and todo results and the headings of files without a failure are left
 *  out. Everything else, such as an error, a log line, or the summary, is
 *  kept. */
export function failureOutput(output: string): string {
  const kept: string[] = [];
  for (const line of output.split("\n").filter((candidate) => !PASSING_RESULT.test(candidate))) {
    const previous = kept.at(-1);
    if (previous !== undefined && FILE_HEADING.test(previous) && (line.trim() === "" || FILE_HEADING.test(line))) {
      kept.pop();
      if (kept.at(-1)?.trim() === "") kept.pop();
    }
    kept.push(line);
  }
  return kept.join("\n");
}

async function main(): Promise<void> {
  // A URL keeps its own separators and its leading slash, so `pathname` reads
  // `/C:/repo` on Windows and every `join` below it builds the invalid
  // `\C:\repo`. `fileURLToPath` returns a native path on all platforms, and it
  // decodes the percent-escapes that a directory name with spaces carries.
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const plan = planRequestedTests(process.argv.slice(2), repoRoot);
  if (plan.missing.length > 0) {
    for (const path of plan.missing) {
      process.stderr.write(`test-parallel: requested test path not found: ${path}\n`);
    }
    process.exit(1);
  }
  const files: string[] = [...plan.files];
  for (const dir of plan.dirs) collectTestFiles(dir, files);
  if (plan.files.length === 0 && plan.dirs.length === 0) {
    collectTestFiles(join(repoRoot, "tests/unit"), files);
    // The VS Code extension keeps its unit tests beside the code they cover;
    // they run in the same suite under the same unit rules.
    collectTestFiles(join(repoRoot, "vscode/src"), files);
    // The web client keeps its unit tests beside the code too; they compile
    // against the published client contract and run under the same rules.
    // The phone and local shells are hosts of that client and keep their
    // tests the same way.
    collectTestFiles(join(repoRoot, "webview/src"), files);
    collectTestFiles(join(repoRoot, "webview/phone"), files);
    collectTestFiles(join(repoRoot, "webview/local"), files);
    // The maintainer's private companion checkout tests its own scripts in the
    // same suite; a checkout without private/ has none.
    const privateScripts = join(repoRoot, "private/scripts");
    if (existsSync(privateScripts)) collectTestFiles(privateScripts, files);
  }
  files.sort();
  const uniqueFiles = [...new Set(files)];

  // Keep a core free for timing-sensitive tests and cap process contention.
  // TEST_SHARDS remains the explicit override for constrained or noisy machines.
  const defaultShardCount = Math.max(4, Math.min(10, navigator.hardwareConcurrency - 1));
  const shardCount = parseShardCount(process.env.TEST_SHARDS, defaultShardCount);
  if (shardCount === null) {
    process.stderr.write(`test-parallel: TEST_SHARDS must be a positive integer from 1 to ${maxShardCount}, got "${process.env.TEST_SHARDS}"\n`);
    process.exit(1);
  }
  const hangGuardSeconds = parseHangGuardSeconds(process.env.TEST_HANG_GUARD_SECONDS);
  if (hangGuardSeconds === null) {
    process.stderr.write(`test-parallel: TEST_HANG_GUARD_SECONDS must be a positive integer from 1 to ${maxHangGuardSeconds}, got "${process.env.TEST_HANG_GUARD_SECONDS}"\n`);
    process.exit(1);
  }
  // Bands are balanced by each file's measured wall time, and by size for a
  // file that has none yet (test-durations.ts). Only a full run of the default
  // suite measures: a focused run loads a file in other company, and coverage
  // slows every file, so neither describes an ordinary run. A measuring run
  // times each file from the heading Bun prints as it starts it, and Bun
  // prints headings only without `--only-failures`.
  const coverageDir = process.env.FLYWHEEL_COVERAGE_DIR;
  const measures = plan.files.length === 0 && plan.dirs.length === 0
    && coverageDir === undefined
    && !plan.passThrough.some((arg) => arg.startsWith("--reporter"));
  const traceTimings = process.env.TEST_SHARD_TIMINGS === "1";
  const readsHeadings = measures || traceTimings;

  // Cases that run a real shell are the slowest in the suite, and starting
  // powershell.exe costs far more than starting bash, so Windows gets a wider
  // default deadline than Bun's own. An explicit --timeout still wins, and POSIX
  // keeps the tighter default that catches a genuinely hung case.
  const defaultTimeout = process.platform === "win32"
    && !plan.passThrough.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="))
    ? ["--timeout", "20000"]
    : [];

  const bandLabel = (bandNumber: number): string => `band-${bandNumber}`;
  // --conditions=browser: solid-js must resolve to its browser runtime so
  // createEffect runs. Under the default "server" resolution effects are
  // inert, which would silently no-op any effect-based hook under test.
  const bandCommand = (bandFiles: readonly string[], tempLabel: string): string[] => ["bun", "--conditions=browser", "test", ...(coverageDir ? ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${join(coverageDir, tempLabel)}`] : []), ...(readsHeadings ? [] : ["--only-failures"]), ...defaultTimeout, ...plan.passThrough, ...bandFileArguments(bandFiles, repoRoot)];
  const durations = readDurationRecord();
  // A band's label never has more digits than the count of files.
  const fits = process.platform === "win32" ? (band: readonly string[]) => fitsWindowsCommandLine(bandCommand(band, bandLabel(uniqueFiles.length))) : undefined;
  const bands = planTestBands(uniqueFiles, shardCount, bandWeight(uniqueFiles, durations, repoRoot, (file) => statSync(file).size), fits);

  const leaveLane = await enterValidationLane("test");
  const start = performance.now();
  const tempGuard = createTestTempGuard();
  const tempLeaks: TempLeak[] = [];
  const measured = new Map<string, number>();
  const measure = (progress: ReturnType<typeof createShardProgress> | undefined): void => {
    if (progress === undefined) return;
    for (const [file, duration] of finishedFileDurations(progress.snapshot(), repoRoot)) measured.set(file, duration);
  };
  const storeDurations = (): void => {
    if (measures) writeDurationRecord(recordDurations(durations, measured, uniqueFiles, repoRoot));
  };

  // A detached or interrupted run must not leave shard subprocesses alive:
  // orphaned `bun test` shards saturate the CPU and starve later runs.
  const shardProcs = new Map<Bun.Subprocess, { index: number; bandIndex: number; files: readonly string[]; progress: ReturnType<typeof createShardProgress> | undefined }>();
  const pendingBands = new Set(bands.keys());
  let interrupted: NodeJS.Signals | undefined;
  let hung = false;
  const killShards = (signal: NodeJS.Signals): void => {
    interrupted = signal;
    for (const proc of shardProcs.keys()) proc.kill("SIGKILL");
  };
  process.on("SIGTERM", killShards);
  process.on("SIGINT", killShards);
  // The duration is a result, not a deadline. A run killed mid-flight reports
  // nothing, so one slow shard used to discard every pass and every failure the
  // suite had already found, and the only signal left was that it was slow. The
  // shards now run to completion and the elapsed time is asserted beside the
  // counts, so a suite that is both slow and broken says both.
  const commandBudgetMs = 60_000;
  // About double a healthy run: the suite takes about 42 seconds, a Windows
  // host about 50 with six shards, and a coverage run about 61. Bun's own
  // per-test timeout ends a hung test body, hook, or child wait, so a file
  // that never finishes loading, such as a top-level await that never
  // settles, reaches this guard. So does a run that is slow in every shard:
  // the first run after a fresh extract and install on Windows, which pays for
  // the first open of every file, or a run that shares the machine with
  // another gate. Planning cannot repair either one. A hang or a stall still
  // must not wedge the command or hold the shared validation lane, its work is
  // still named, and the files it finished are still measured. A machine
  // with fewer or slower cores, such as a hosted CI runner with four, runs
  // every band for longer than a hang would take here, so it sets
  // TEST_HANG_GUARD_SECONDS.
  const hangGuardMs = hangGuardSeconds * 1000;
  const hangGuard = setTimeout(() => { void (async () => {
    hung = true;
    process.stderr.write(`\nTest execution passed ${hangGuardSeconds} seconds, which only a hung or stalled shard can do on a development machine. On a machine with fewer or slower cores, set TEST_HANG_GUARD_SECONDS to allow more time. Unfinished shards:\n`);
    const killed = [...shardProcs];
    try {
      for (const [proc, shard] of killed) {
        printShardProgress(shard.index, shard.progress);
        process.stderr.write(`shard ${shard.index + 1}/${shardCount}, band ${shard.bandIndex + 1}/${bands.length}:\n${shard.files.join("\n")}\n`);
        proc.kill("SIGKILL");
      }
      for (const bandIndex of pendingBands) {
        process.stderr.write(`queued band ${bandIndex + 1}/${bands.length}:\n${bands[bandIndex]!.join("\n")}\n`);
      }
      // Windows releases a killed process's handles only after exit. A broken
      // exit notification must not keep the validation lane occupied.
      const unsettled = await waitForShardExits(killed.map(([proc]) => proc), 5_000);
      for (const proc of unsettled) {
        const shard = killed.find(([candidate]) => candidate === proc)![1];
        process.stderr.write(`test-parallel: shard ${shard.index + 1}, band ${shard.bandIndex + 1}, pid ${proc.pid} did not exit within 5s of SIGKILL\n`);
      }
    } catch (error) {
      process.stderr.write(`test-parallel: could not stop the killed shards: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      try {
        for (const [, shard] of killed) measure(shard.progress);
        storeDurations();
        tempGuard.dispose();
      } catch (error) {
        process.stderr.write(`test-parallel: could not finish cleanup of the killed shards: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        leaveLane();
        process.exit(1);
      }
    }
  })() }, hangGuardMs);

  const results = await runTestBands<ShardResult>(
    bands, shardCount, async (shardFiles, bandIndex, index) => {
      if (interrupted || hung) return { index: bandIndex, exitCode: 1, passCount: 0, failCount: 0, elapsedMs: 0 };
      pendingBands.delete(bandIndex);
      const shardStart = performance.now();
      const progress = readsHeadings ? createShardProgress() : undefined;
      const tempLabel = bandLabel(bandIndex + 1);
      const proc = Bun.spawn(bandCommand(shardFiles, tempLabel), {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        // Plain output: the pass and fail counts below are read from the
        // summary lines, and a colour-forcing terminal would wrap them in
        // escape codes the pattern does not see.
        //
        // A band lives for under a minute and runs thousands of different
        // functions a few times each, so JavaScriptCore's top (FTL) tier
        // compiles code that never runs long enough to repay the compile. The
        // compiles take about 15% of the suite's user CPU on helper threads that
        // compete with every band for the cores. The variable in the caller's
        // environment still wins.
        env: { BUN_JSC_useFTLJIT: "0", ...process.env, ...tempGuard.env(tempLabel), FORCE_COLOR: "0", NO_COLOR: "1" },
        windowsHide: true,
      });
      shardProcs.set(proc, { index, bandIndex, files: shardFiles, progress });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        readShardOutput(proc.stderr, progress),
        proc.exited.finally(() => shardProcs.delete(proc)),
      ]);
      // The hang guard owns a band it killed: it measures the files that band
      // finished, and a running file must not count as finished.
      if (hung) return { index: bandIndex, exitCode, passCount: 0, failCount: 0, elapsedMs: 0 };
      const output = stdout + stderr;
      progress?.finish(output);
      measure(progress);
      const tempLeak = tempGuard.collect(tempLabel);
      if (tempLeak) tempLeaks.push(tempLeak);
      const passMatch = output.match(/^\s*(\d+)\s+pass\s*$/m);
      const failMatch = output.match(/^\s*(\d+)\s+fail\s*$/m);
      const elapsedMs = performance.now() - shardStart;
      if (exitCode !== 0 || Number(failMatch?.[1] ?? 0) > 0) {
        process.stdout.write(`\n--- shard ${index + 1}/${shardCount}, band ${bandIndex + 1}/${bands.length} ---\n${traceTimings ? output : failureOutput(output)}`);
      }
      if (traceTimings) {
        process.stdout.write(`shard ${index + 1}, band ${bandIndex + 1}/${bands.length}: ${(elapsedMs / 1000).toFixed(2)}s, ${shardFiles.length} files, ${shardFiles[0]} .. ${shardFiles.at(-1)}\n`);
        printShardProgress(index, progress);
      }
      return {
        index: bandIndex,
        exitCode,
        passCount: passMatch ? Number(passMatch[1]) : 0,
        failCount: failMatch ? Number(failMatch[1]) : 0,
        elapsedMs,
      };
    },
  );
  if (hung) return;
  clearTimeout(hangGuard);
  tempGuard.dispose();
  if (!interrupted) storeDurations();
  leaveLane();
  if (interrupted) process.exit(interrupted === "SIGINT" ? 130 : 143);

  const elapsedMs = performance.now() - start;
  const elapsed = (elapsedMs / 1000).toFixed(2);

  let totalPass = 0;
  let totalFail = 0;
  let anyFailed = false;
  for (const r of results) {
    totalPass += r.passCount;
    totalFail += r.failCount;
    if (r.exitCode !== 0) anyFailed = true;
  }

  // A shard that ends non-zero while reporting no failures did not run its
  // tests: it crashed, and the tally above is missing everything it held. The
  // exit code already says so, but a bare "0 fail" reads like success, so the
  // count that is wrong is named rather than left to be inferred.
  const crashed = results.filter((r) => r.exitCode !== 0 && r.failCount === 0);

  process.stdout.write(`\n${totalPass} pass\n`);
  process.stdout.write(`${totalFail} fail\n`);
  for (const r of crashed) {
    process.stdout.write(`band ${r.index + 1}/${bands.length} exited ${r.exitCode} without reporting a failure: ${bands[r.index]?.length ?? 0} file(s) did not report\n`);
  }
  process.stdout.write(`Ran across ${shardCount} parallel shards in ${elapsed}s\n`);

  // Slow is a failure of its own, reported after the counts rather than instead
  // of them. The budget is spent on the longest band, so the longest ones are
  // named: shard count is the other lever, and `TEST_SHARDS` sets it.
  // The budget protects development speed, not the product, so a release sets
  // `TEST_BUDGET=advisory`: a release machine shares its load with other work,
  // and a slow run that found no failure must not stop the release.
  const overBudget = elapsedMs > commandBudgetMs;
  const budgetAdvisory = process.env.TEST_BUDGET === "advisory";
  if (overBudget) {
    process.stdout.write(`\ntest duration exceeded its ${(commandBudgetMs / 1000).toFixed(0)}s budget by ${((elapsedMs - commandBudgetMs) / 1000).toFixed(2)}s${budgetAdvisory ? " (advisory: TEST_BUDGET=advisory, so the run does not fail for it)" : ""}\n`);
    for (const slow of [...results].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 3)) {
      process.stdout.write(`  band ${slow.index + 1}/${bands.length} took ${(slow.elapsedMs / 1000).toFixed(2)}s across ${bands[slow.index]?.length ?? 0} file(s)\n`);
    }
    process.stdout.write(`  ${shardCount} shard(s) on ${navigator.hardwareConcurrency} logical processor(s); set TEST_SHARDS to change it\n`);
  }

  // A leaked temporary entry fails the run even when every case passed: the
  // cost lands in the developer's TMPDIR on every later run, where nothing
  // else would ever report it.
  if (tempLeaks.length > 0) process.stdout.write(formatTempLeaks(tempLeaks));

  process.exit(runFails({ failed: anyFailed, overBudget, budgetAdvisory, leaked: tempLeaks.length > 0 }) ? 1 : 0);
}

if (import.meta.main) await main();
