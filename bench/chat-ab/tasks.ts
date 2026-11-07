import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { containsSecret } from "../../src/infra/redact-secrets.js";
import { bytesIdentity, directoryIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { objectValue, parseImplementSandbox, stringValue, type ImplementSandboxSpec } from "../../src/orchestration/modules/development/benchmark/task-schema.js";
import { parseAcceptanceBaseline, parseJUnitReport, type AcceptanceBaseline, type TestOutcome } from "./acceptance.js";

/** The task contract (one directory per task under bench/chat-ab/tasks/<id>/):
 *  task.json (id, stratum, timeoutMinutes, sandbox: the shared sandbox spec of
 *  task-schema.ts, whose source is a commit with its paths, a task folder named
 *  by fixtureRepo, or the empty tree with no paths, plus optional patch and
 *  setup; a top-level `patch` is also accepted; acceptanceBaseline,
 *  which check-task.ts --write-baseline computes from the unfixed sandbox),
 *  message.md (the original chat message), optional design.md (the design-given
 *  variant), optional challenge.md (a second-turn challenge with
 *  task.json challenge.truth set to hold or change), acceptance/*.test.ts (run
 *  from the sandbox root with `bun test ./acceptance` after the diff is
 *  captured), WHY.md, and reference.patch (a known fix, which the judge reads
 *  as a statement of intent). When the pinned source loads the local tokenizer,
 *  sandbox.paths names crates/tokenizer/tokenizer-prebuilt.json and
 *  crates/tokenizer/flywheel-tokenizer.wasm.zst; without them every test
 *  that loads the tokenizer fails, so the agent cannot verify its change.
 *
 *  Nothing in a provisioned sandbox names the harness. The project directory
 *  is `flywheel-<random>`, the home directory of harness commands lives
 *  outside it, the baseline is an ordinary root commit with a neutral author,
 *  and no harness file or ignore entry is written into the tree. */

const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const SANDBOX_COMMAND_TIMEOUT_MS = 20 * 60_000;
const ACCEPTANCE_TIMEOUT_MS = 5 * 60_000;
const BASELINE_AUTHOR = ["-c", "user.name=Flywheel Developer", "-c", "user.email=dev@flywheel.local"] as const;
const CAPTURE_EXCLUDES = [".flywheel", "acceptance"] as const;

interface DiffStats {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesTouched: number;
}

export interface CapturedCell extends DiffStats {
  readonly diff: string;
  /** The outcome of each acceptance test, or null when the run timed out or wrote no report. */
  readonly acceptance: ReadonlyMap<string, TestOutcome> | null;
}

/** One provisioned sandbox. `dispose` removes the project and its command home. */
export interface Sandbox {
  readonly dir: string;
  readonly home: string;
  readonly baseline: string;
  dispose(): Promise<void>;
}

export interface DraftTask {
  readonly id: string;
  readonly stratum: string;
  readonly taskDir: string;
  /** The selected chat message, trimmed. */
  readonly message: string;
  readonly challenge?: { readonly text: string; readonly truth: "hold" | "change" };
  readonly timeoutMs: number;
  /** What the pairwise judge reads as the request the diffs answer. */
  readonly judgeContext: string;
  readonly contentIdentity: string;
  readonly sandbox: ImplementSandboxSpec;
  readonly acceptanceDir: string;
  /** Absent only on a draft task that check-task.ts has not scored yet. */
  readonly acceptanceBaseline: AcceptanceBaseline | undefined;
}

/** A task with the complete contract, its acceptance baseline included. */
export interface BenchTask extends DraftTask {
  readonly acceptanceBaseline: AcceptanceBaseline;
}

/** What provisioning a sandbox reads from a task. */
type SandboxTask = Pick<DraftTask, "id" | "taskDir" | "sandbox">;

/** A task directory that does not yet hold the complete contract. */
export interface IncompleteTask {
  readonly id: string;
  readonly missing: readonly string[];
}

const REQUIRED_ENTRIES = ["task.json", "message.md", "acceptance", "WHY.md", "reference.patch"] as const;
const MISSING_BASELINE = "task.json acceptanceBaseline";

/** Whether task.json names an acceptance baseline. Another author may still be
 *  writing the file, so unreadable JSON counts as no baseline, not an error. */
async function declaresBaseline(path: string): Promise<boolean> {
  try {
    const config: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof config === "object" && config !== null && "acceptanceBaseline" in config;
  } catch {
    return false;
  }
}

async function missingEntries(taskDir: string, message?: "design"): Promise<string[]> {
  const missing: string[] = REQUIRED_ENTRIES.filter((name) => !existsSync(join(taskDir, name)));
  if (message && !existsSync(join(taskDir, `${message}.md`))) missing.push(`${message}.md`);
  if (!missing.includes("task.json") && !await declaresBaseline(join(taskDir, "task.json"))) missing.push(MISSING_BASELINE);
  if (!missing.includes("acceptance")) {
    const tests = (await readdir(join(taskDir, "acceptance"))).filter((name) => name.endsWith(".test.ts"));
    if (tests.length === 0) missing.push("acceptance/*.test.ts");
  }
  for (const forbidden of ["plan.json", "manifest.json"]) {
    if (existsSync(join(taskDir, forbidden))) missing.push(`no ${forbidden} (present)`);
  }
  return missing;
}

/** Resolves a task-relative path and refuses one that leaves the task directory. */
export function taskPath(taskDir: string, value: string, context: string): string {
  if (isAbsolute(value)) throw new Error(`${context} must be relative to its task directory`);
  const path = join(taskDir, value);
  if (relative(taskDir, path).startsWith("..")) throw new Error(`${context} escapes its task directory`);
  return path;
}

async function loadTask(tasksDir: string, id: string, variant?: "design", challengeMode = false): Promise<DraftTask> {
  const taskDir = join(tasksDir, id);
  const config = objectValue(JSON.parse(await readFile(join(taskDir, "task.json"), "utf8")), `${id}/task.json`);
  if (stringValue(config.id, `${id}/task.json.id`) !== id) throw new Error(`${id}/task.json.id must equal its directory name`);
  const stratum = stringValue(config.stratum, `${id}/task.json.stratum`);
  const timeoutMinutes = config.timeoutMinutes;
  if (timeoutMinutes !== undefined && (typeof timeoutMinutes !== "number" || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)) {
    throw new Error(`${id}/task.json.timeoutMinutes must be a positive number`);
  }
  const parsed = parseImplementSandbox(config.sandbox, `${id}/task.json.sandbox`);
  const topLevelPatch = config.patch === undefined ? undefined : stringValue(config.patch, `${id}/task.json.patch`);
  if (topLevelPatch && parsed.patch) throw new Error(`${id}/task.json names a patch twice`);
  const patch = topLevelPatch ?? parsed.patch;
  const sandbox: ImplementSandboxSpec = { ...parsed, ...(patch ? { patch } : {}) };
  const fixtureIdentity = "fixtureRepo" in sandbox ? await directoryIdentity(taskPath(taskDir, sandbox.fixtureRepo, `${id}/fixtureRepo`)) : null;
  const messageFile = `${variant ?? "message"}.md`;
  const message = (await readFile(join(taskDir, messageFile), "utf8")).trim();
  if (!message) throw new Error(`${id}/${messageFile} is empty`);
  let challenge: DraftTask["challenge"];
  if (challengeMode) {
    if (!existsSync(join(taskDir, "challenge.md"))) throw new Error(`${id}/challenge.md is required in challenge mode`);
    const text = (await readFile(join(taskDir, "challenge.md"), "utf8")).trim();
    if (!text) throw new Error(`${id}/challenge.md is empty`);
    const declaration = objectValue(config.challenge, `${id}/task.json.challenge`);
    const truth = declaration.truth;
    if (truth !== "hold" && truth !== "change") throw new Error(`${id}/task.json.challenge.truth must be hold or change`);
    challenge = { text, truth };
  }
  const acceptanceDir = join(taskDir, "acceptance");
  const timeoutMs = typeof timeoutMinutes === "number" ? Math.round(timeoutMinutes * 60_000) : DEFAULT_TIMEOUT_MS;
  const patchIdentity = patch ? bytesIdentity(new Uint8Array(await Bun.file(taskPath(taskDir, patch, `${id}/patch`)).arrayBuffer())) : undefined;
  const referencePath = join(taskDir, "reference.patch");
  const referenceIdentity = existsSync(referencePath) ? bytesIdentity(new Uint8Array(await Bun.file(referencePath).arrayBuffer())) : null;
  const acceptanceBaseline = config.acceptanceBaseline === undefined ? undefined : parseAcceptanceBaseline(config.acceptanceBaseline, `${id}/task.json.acceptanceBaseline`);
  return {
    id,
    stratum,
    taskDir,
    message,
    ...(challenge ? { challenge } : {}),
    timeoutMs,
    judgeContext: message,
    // A changed baseline changes the identity, so results scored against an
    // older baseline never pair with new ones.
    contentIdentity: structuredIdentity({ id, stratum, timeoutMs, sandbox, ...(fixtureIdentity === null ? {} : { fixture: fixtureIdentity }), patch: patchIdentity ?? null, ...(referenceIdentity === null ? {} : { reference: referenceIdentity }), message, ...(challenge ? { challenge } : {}), acceptance: await directoryIdentity(acceptanceDir), acceptanceBaseline: acceptanceBaseline ?? null }),
    sandbox,
    acceptanceDir,
    acceptanceBaseline,
  };
}

/** Lists the task directories. A directory still missing part of the contract
 *  (another author may be writing it) is returned as incomplete, not loaded. */
export async function listBenchTasks(tasksDir: string): Promise<{ complete: string[]; incomplete: IncompleteTask[] }> {
  const entries = (await readdir(tasksDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const complete: string[] = [];
  const incomplete: IncompleteTask[] = [];
  for (const id of entries) {
    const missing = await missingEntries(join(tasksDir, id));
    if (missing.length === 0) complete.push(id);
    else incomplete.push({ id, missing });
  }
  return { complete, incomplete };
}

async function loadChecked(tasksDir: string, id: string, optional: readonly string[], message?: "design", challenge = false): Promise<DraftTask> {
  const taskDir = join(tasksDir, id);
  if (!existsSync(taskDir)) throw new Error(`Unknown task ${id}`);
  const missing = (await missingEntries(taskDir, message)).filter((entry) => !optional.includes(entry));
  if (missing.length > 0) throw new Error(`Task ${id} is incomplete: ${missing.join(", ")}`);
  return await loadTask(tasksDir, id, message, challenge);
}

/** Loads complete tasks with the selected message and matching judge context.
 * Refuses a task that lacks the selected variant or challenge. Omission selects message.md and excludes challenge data. */
export async function loadBenchTasks(tasksDir: string, ids: readonly string[], message?: "design", challenge = false): Promise<BenchTask[]> {
  const tasks: BenchTask[] = [];
  for (const id of ids) {
    const { acceptanceBaseline, ...task } = await loadChecked(tasksDir, id, [], message, challenge);
    if (!acceptanceBaseline) throw new Error(`Task ${id} has no acceptance baseline`);
    tasks.push({ ...task, acceptanceBaseline });
  }
  return tasks;
}

/** Loads one task that its author is still validating: its WHY.md, its
 *  reference.patch, and its acceptance baseline may be missing. */
export async function loadDraftTask(tasksDir: string, id: string): Promise<DraftTask> {
  return await loadChecked(tasksDir, id, ["WHY.md", "reference.patch", MISSING_BASELINE]);
}

/** The whole environment of a harness command (archive, setup, acceptance).
 *  It is built rather than inherited, so no provider key or account home
 *  reaches fixture code, and HOME is the sandbox's own command home. */
async function commandEnv(home: string): Promise<{ readonly [name: string]: string }> {
  const temp = join(home, "tmp");
  await mkdir(temp, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temp,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_SYSTEM: join(home, "gitconfig-system"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runIn(run: OwnedCommandRunner, home: string, command: readonly string[], cwd: string, options: { stdin?: string; timeoutMs?: number } = {}): Promise<OwnedCommandResult> {
  return await run(command, {
    cwd,
    env: await commandEnv(home),
    timeoutMs: options.timeoutMs ?? SANDBOX_COMMAND_TIMEOUT_MS,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
}

/** Runs a command and requires success. The error carries exit metadata only:
 *  fixture output is untrusted and can hold secrets. */
async function runChecked(run: OwnedCommandRunner, home: string, command: readonly string[], cwd: string, options: { stdin?: string } = {}): Promise<string> {
  const result = await runIn(run, home, command, cwd, options);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${command.slice(0, 2).join(" ")} failed in ${cwd}: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}`);
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`${command.slice(0, 2).join(" ")} output was truncated`);
  return result.stdout;
}

/** A sandbox source must hold only directories and regular files. */
async function rejectLinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await rejectLinks(path);
    else if (!entry.isFile()) throw new Error(`Sandbox source contains a symlink or special entry at ${path}`);
  }
}

/** Provisions the task's source (the pinned archive or the task's fixture
 * directory) in its own repository, applies the task patch, and runs setup
 * before committing the subject's clean baseline. */
export async function provisionSandbox(repoRoot: string, task: SandboxTask, run: OwnedCommandRunner, root: string = tmpdir()): Promise<Sandbox> {
  const dir = await mkdtemp(join(root, "flywheel-"));
  const home = await mkdtemp(join(root, "home-"));
  const dispose = async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  };
  try {
    if ("commit" in task.sandbox) {
      const archive = join(home, "source.tar");
      await runChecked(run, home, ["git", "-C", repoRoot, "archive", "--format=tar", `--output=${archive}`, task.sandbox.commit, "--", ...task.sandbox.paths], repoRoot);
      await runChecked(run, home, ["tar", "-xf", archive, "-C", dir], dir);
      await rm(archive, { force: true });
    } else {
      await cp(taskPath(task.taskDir, task.sandbox.fixtureRepo, `${task.id}/fixtureRepo`), dir, { recursive: true });
    }
    await rejectLinks(dir);
    await runChecked(run, home, ["git", "init", "-q", "-b", "main"], dir);
    if (task.sandbox.patch) {
      const patch = await readFile(taskPath(task.taskDir, task.sandbox.patch, `${task.id}/patch`), "utf8");
      await runChecked(run, home, ["git", "apply", "--whitespace=nowarn"], dir, { stdin: patch });
    }
    // The project store lives in the project; an ignore entry for it is what
    // any Flywheel user's repository carries.
    const ignorePath = join(dir, ".gitignore");
    const ignore = existsSync(ignorePath) ? await readFile(ignorePath, "utf8") : "";
    if (!/^\/?\.flywheel\/?$/m.test(ignore)) await Bun.write(ignorePath, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.flywheel/\n`);
    // Setup runs before the baseline commit, so the agent starts on a clean
    // worktree and whatever setup writes outside the ignore rules (a refreshed
    // lockfile) is part of the baseline, not of the captured diff.
    for (const command of task.sandbox.setup ?? []) {
      if (!command[0]) throw new Error(`Empty setup command for ${task.id}`);
      // Each cell has a fresh HOME, so `bun install` starts with an empty
      // package cache. Three of them in parallel failed once in validation
      // (2026-10-05) and passed alone, so one retry absorbs a registry flake.
      await runChecked(run, home, command, dir).catch(async () => await runChecked(run, home, command, dir));
    }
    await runChecked(run, home, ["git", "add", "-A"], dir);
    await runChecked(run, home, ["git", ...BASELINE_AUTHOR, "commit", "-qm", "Import source"], dir);
    const baseline = (await runChecked(run, home, ["git", "rev-parse", "HEAD"], dir)).trim();
    return { dir, home, baseline, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function parseNumstat(output: string): DiffStats {
  let linesAdded = 0;
  let linesRemoved = 0;
  let filesTouched = 0;
  for (const line of output.split("\n")) {
    const [added, removed, file] = line.split("\t");
    if (added === undefined || removed === undefined || file === undefined) continue;
    linesAdded += added === "-" ? 0 : Number(added);
    linesRemoved += removed === "-" ? 0 : Number(removed);
    filesTouched++;
  }
  return { linesAdded, linesRemoved, filesTouched };
}

/** What a capture leaves out of the diff and which tests it runs. Coding callers (coding-task.ts) name more
 *  excludes, such as an agent's own workflow files, and the declared test files of a bench/tasks coding task. */
interface CaptureOptions {
  /** Paths left out of the diff beside `.flywheel` and `acceptance`. */
  readonly excludes?: readonly string[];
  /** The test paths `bun test` runs, relative to the sandbox root. */
  readonly tests?: readonly string[];
}

/** Capture the subject's changes against the sandbox baseline, excluding harness and retained state. Refuse credential bytes. */
export async function captureSandboxDiff(sandbox: Sandbox, run: OwnedCommandRunner, extraExcludes: readonly string[] = []): Promise<DiffStats & { diff: string }> {
  const excludes = [...CAPTURE_EXCLUDES, ...extraExcludes];
  const pathspec = ["--", ".", ...excludes.map((path) => `:(exclude,glob)${path}`)];
  await runChecked(run, sandbox.home, ["git", "add", "-A"], sandbox.dir);
  await runChecked(run, sandbox.home, ["git", "reset", "--quiet", "HEAD", "--", ...excludes.map((path) => `:(glob)${path}`)], sandbox.dir);
  const diff = await runChecked(run, sandbox.home, ["git", "diff", "--cached", sandbox.baseline, ...pathspec], sandbox.dir);
  if (containsSecret(diff)) throw new Error("captured diff contains recognized credential bytes");
  const stats = parseNumstat(await runChecked(run, sandbox.home, ["git", "diff", "--cached", sandbox.baseline, "--numstat", ...pathspec], sandbox.dir));
  return { diff, ...stats };
}

/** Capture changes and run the task's frozen acceptance tests outside the subject's execution. */
export async function captureSandbox(task: SandboxTask & Pick<DraftTask, "acceptanceDir">, sandbox: Sandbox, run: OwnedCommandRunner, options: CaptureOptions = {}): Promise<CapturedCell> {
  const captured = await captureSandboxDiff(sandbox, run, options.excludes);
  const acceptanceDir = join(sandbox.dir, "acceptance");
  await rm(acceptanceDir, { recursive: true, force: true });
  await cp(task.acceptanceDir, acceptanceDir, { recursive: true });
  for (const name of await readdir(acceptanceDir)) {
    if ((await lstat(join(acceptanceDir, name))).isSymbolicLink()) throw new Error(`${task.id}/acceptance/${name} is a symlink`);
  }
  const reportPath = join(sandbox.home, "acceptance.xml");
  await rm(reportPath, { force: true });
  const result = await runIn(run, sandbox.home, ["bun", "test", ...(options.tests ?? ["./acceptance"]), "--reporter=junit", `--reporter-outfile=${reportPath}`], sandbox.dir, { timeoutMs: ACCEPTANCE_TIMEOUT_MS });
  const report = result.timedOut ? undefined : await readFile(reportPath, "utf8").catch(() => undefined);
  return { ...captured, acceptance: report === undefined ? null : parseJUnitReport(report) };
}
