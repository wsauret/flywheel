import { Result, Schema } from "effect";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { ContainedDirectory } from "../../../../../infra/platform/files/descriptor-directory/descriptor-directory-contract.js";
import { openExistingContainedDirectory } from "../../../../../infra/platform/files/descriptor-directory.js";
import type { OwnedCommandRunner } from "../../../../../infra/owned-command.js";
import { containsSecret } from "../../../../../infra/redact-secrets.js";
import { describeOutputIssues, schemaIssues } from "../../../../../workflows/output-contract/accept.js";
import { compileOutput } from "../../../../../workflows/output-contract/compile.js";
import { decodeOutputObject } from "../../../../../workflows/output-contract/grammar.js";
import planContract from "../../../../../workflows/workflows/contracts/implementation-plan.json" with { type: "json" };
import { bytesIdentity, directoryIdentity, structuredIdentity } from "../campaign/content-identity.js";
import { containedPath, realDirectoryUnder, realFileUnder } from "../campaign/paths.js";
import {
  initSandboxRepository,
  requireCompleteSandboxOutput,
  requireSandboxSuccess,
  runCheckedSandboxCommand,
  runSandboxCommand,
  SANDBOX_HOME_DIR,
  type CellEvidence,
  type SandboxCommandOptions,
} from "../sandbox-command.js";
import { objectValue, parseImplementSandbox, parseManifestPoints, parseNativePath, stringValue, type ImplementManifest, type ImplementSandboxSpec, type ImplementTaskObject } from "../tasks/task-schema.js";
import { retainImplementStore, retainNativeGradeFailure } from "../execution/implement-evidence.js";
import { materializeCommitSnapshot } from "../execution/snapshot-workspace.js";
import { gradeChecks, parseCheckTags, type CheckGrade, type CheckTag } from "./check-grade.js";
import { parseJUnitReport } from "./junit-report.js";

/** The direct persona harness names this gitignored plan file in its prompt. */
export const PLAN_FILE = ".bench-plan.json";
const BASELINE_REF = "refs/flywheel/benchmark-baseline";
const MAX_HARNESS_FILE_BYTES = 1_000_000;


/** Shared identity and reporting metadata for implementation tasks. */
interface ImplementTaskBase {
  mode: "implement";
  id: string;
  stratum: string;
  /** Per-task cell timeout override; production-scale tasks need more than the default. */
  timeoutMs?: number;
  taskDir: string;
  manifest: ImplementManifest;
  contentIdentity: string;
  /** The part of the task that a candidate's change answers: its prompt, starting source, and limits. A recorded
   *  cell stays comparable only while this matches. */
  candidateIdentity: string;
  /** The part of the task that grades a change, its check tags included. A grader change regrades stored diffs
   *  instead of rerunning candidates (regrade.ts). */
  graderIdentity: string;
}

interface PlanImplementTaskSpec extends ImplementTaskBase {
  kind?: "plan";
  /** The tag of each hidden acceptance test, from the task's `checks.json` (ARCH-DIRECTORIES-024). Every implementer
   *  task has one (catalog.ts); a chat coding task that shares this loader grades with its own acceptance baseline. */
  checks?: ReadonlyMap<string, CheckTag>;
  plan: ImplementTaskObject;
  sandbox: ImplementSandboxSpec;
  acceptanceDir: string;
}

interface NativeImplementTaskSpec extends ImplementTaskBase {
  kind: "native";
  /** The tag of each new hidden check, from the task's `checks.json` (ARCH-DIRECTORIES-024). */
  checks: ReadonlyMap<string, CheckTag>;
  /** Exact UTF-8 text from the contained task.json.instruction file.
   * A .gz suffix means gunzip before strict decoding; BOM and line endings remain intact. */
  instruction: string;
  /** Optional task-contained UTF-8 appendix from task.json.environment.
   * Keeps neutral path and tooling mappings separate from the original request. */
  environment?: string;
  family: string;
  split: "development" | "evaluation";
  /** Runtime, contained script, and optional fixed arguments. The runner appends
   * prepare, taskDir, workspace; or grade, taskDir, workspace, patch, report.
   * Prepare supplies source and dependencies without Git history. Grade rebuilds
   * original source and grading in its fresh workspace, not the candidate tree. */
  native: { command: readonly string[]; timeoutMs: number; path?: readonly string[] };
}

export type ImplementTaskSpec = PlanImplementTaskSpec | NativeImplementTaskSpec;

interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
}

export interface CapturedImplementation {
  diff: string;
  diffStats: DiffStats;
  grade: CheckGrade;
  /** Exact adapter result bytes, including the unchanged original grader evidence. */
  nativeGrade?: string;
}


const decodedPlanContract = decodeOutputObject(planContract);
if (Result.isFailure(decodedPlanContract)) throw new Error(`implementation-plan.json is not a valid output contract:\n${decodedPlanContract.failure.join("\n")}`);
const decodePlan = Schema.decodeUnknownResult(compileOutput(decodedPlanContract.success).schema, { errors: "all" });

/** A task's plan is the payload the spec agents would hand to implement, so it
 *  decodes against the same contract at load. A plan that drifts from the
 *  contract fails here, before any cell starts. */
function requireImplementationPlan(plan: ImplementTaskObject, label: string): void {
  const decoded = decodePlan(plan);
  if (Result.isFailure(decoded)) {
    throw new Error(`${label} does not match the implementation plan contract:\n${describeOutputIssues(schemaIssues(decoded.failure.issue)).join("\n")}`);
  }
}

function planDocument(plan: ImplementTaskObject): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** The task's check tags and the exact bytes they decode from, which grader identity covers. */
async function loadCheckTags(taskDir: string, label: string): Promise<{ checks: ReadonlyMap<string, CheckTag>; bytes: Uint8Array }> {
  const path = await realFileUnder(taskDir, join(taskDir, "checks.json"), `${label}/checks.json`);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return { checks: parseCheckTags(JSON.parse(new TextDecoder().decode(bytes)), `${label}/checks.json`), bytes };
}

/** A plan task's check tags and grader identity. Without `checks.json` the grader is its acceptance tests alone, so a
 *  chat coding task keeps the identity that its qualification records. */
async function loadPlanGrader(taskDir: string, label: string, acceptanceDir: string): Promise<{ checks?: ReadonlyMap<string, CheckTag>; graderIdentity: string }> {
  const acceptance = await directoryIdentity(acceptanceDir);
  if (!await Bun.file(join(taskDir, "checks.json")).exists()) return { graderIdentity: acceptance };
  const { checks, bytes } = await loadCheckTags(taskDir, label);
  return { checks, graderIdentity: structuredIdentity({ acceptance, checks: bytesIdentity(bytes) }) };
}

async function loadImplementTask(taskDir: string, entryName: string, config: ImplementTaskObject): Promise<ImplementTaskSpec> {
  const id = stringValue(config.id, `${entryName}/task.json.id`);
  if (id !== entryName) throw new Error(`${entryName}/task.json.id must equal its directory name`);
  const stratum = stringValue(config.stratum, `${entryName}/task.json.stratum`);
  const timeoutMinutes = config.timeoutMinutes;
  if (timeoutMinutes !== undefined && (typeof timeoutMinutes !== "number" || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)) {
    throw new Error(`${entryName}/task.json.timeoutMinutes must be a positive number`);
  }
  if (config.kind === "native") return loadNativeTask(taskDir, id, stratum, config, typeof timeoutMinutes === "number" ? Math.round(timeoutMinutes * 60_000) : undefined);
  if (config.kind !== undefined && config.kind !== "plan") throw new Error(`${entryName}/task.json.kind is unsupported`);
  const planPath = await realFileUnder(taskDir, join(taskDir, "plan.json"), `${entryName}/plan.json`);
  const sandbox = config.sandbox !== undefined
    ? parseImplementSandbox(config.sandbox, `${entryName}/task.json.sandbox`)
    : { fixtureRepo: "project" };
  const acceptanceDir = await realDirectoryUnder(taskDir, join(taskDir, "acceptance"), `${entryName}/acceptance`);
  const manifestPath = await realFileUnder(taskDir, join(taskDir, "manifest.json"), `${entryName}/manifest.json`);
  const manifestObject = objectValue(JSON.parse(await Bun.file(manifestPath).text()), `${entryName}/manifest.json`);
  const plan = objectValue(JSON.parse(await Bun.file(planPath).text()), `${entryName}/plan.json`);
  requireImplementationPlan(plan, `${entryName}/plan.json`);
  const manifest = {
    traps: parseManifestPoints(manifestObject.traps, `${entryName}/manifest.json.traps`),
    judgment: parseManifestPoints(manifestObject.judgment, `${entryName}/manifest.json.judgment`),
  };
  const patch = sandbox.patch
    ? await realFileUnder(taskDir, join(taskDir, sandbox.patch), `${entryName}/${sandbox.patch}`)
    : undefined;
  const source = {
    ...("commit" in sandbox
      ? { kind: "commit", commit: sandbox.commit, paths: sandbox.paths }
      : {
        kind: "fixture",
        path: sandbox.fixtureRepo,
        identity: await directoryIdentity(await realDirectoryUnder(taskDir, join(taskDir, sandbox.fixtureRepo), `${entryName}/${sandbox.fixtureRepo}`)),
      }),
    ...(sandbox.setup ? { setup: sandbox.setup } : {}),
    ...(patch ? {
      patch: {
        path: sandbox.patch,
        identity: bytesIdentity(new Uint8Array(await Bun.file(patch).arrayBuffer())),
      },
    } : {}),
  };
  const timeoutMs = typeof timeoutMinutes === "number" ? Math.round(timeoutMinutes * 60_000) : undefined;
  const candidateContent = {
    id,
    stratum,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    source,
    plan: bytesIdentity(planDocument(plan)),
    manifest,
  };
  const { checks, graderIdentity } = await loadPlanGrader(taskDir, entryName, acceptanceDir);
  const contentIdentity = structuredIdentity({ ...candidateContent, acceptance: graderIdentity });
  return {
    mode: "implement",
    id,
    stratum,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    taskDir,
    plan,
    sandbox,
    acceptanceDir,
    manifest,
    contentIdentity,
    candidateIdentity: structuredIdentity(candidateContent),
    graderIdentity,
    ...(checks ? { checks } : {}),
  };
}

async function loadNativeTask(taskDir: string, id: string, stratum: string, config: ImplementTaskObject, timeoutMsOverride?: number): Promise<NativeImplementTaskSpec> {
  const family = stringValue(config.family, `${id}/task.json.family`);
  const split = config.split;
  if (split !== "development" && split !== "evaluation") throw new Error(`${id}/task.json.split must be development or evaluation`);
  const instructionPath = await realFileUnder(taskDir, containedPath(taskDir, stringValue(config.instruction, `${id}/task.json.instruction`)), "native instruction");
  const instructionBytes = new Uint8Array(await Bun.file(instructionPath).arrayBuffer());
  const instruction = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    instructionPath.endsWith(".gz") ? Bun.gunzipSync(instructionBytes) : instructionBytes,
  );
  const environmentPath = config.environment === undefined ? undefined
    : await realFileUnder(taskDir, containedPath(taskDir, stringValue(config.environment, `${id}/task.json.environment`)), "native environment");
  const environment = environmentPath === undefined ? undefined
    : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await Bun.file(environmentPath).arrayBuffer());
  const native = objectValue(config.native, `${id}/task.json.native`);
  const path = native.path === undefined ? undefined : parseNativePath(native.path, `${id}/task.json.native.path`);
  const command = native.command;
  if (!Array.isArray(command) || command.length < 2 || !command.every(word => typeof word === "string" && word.length > 0)) {
    throw new Error(`${id}/task.json.native.command must name a runtime and a task-contained script`);
  }
  const script = await realFileUnder(taskDir, containedPath(taskDir, command[1]), "native adapter");
  const timeoutMs = native.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`${id}/task.json.native.timeoutMs must be a positive integer`);
  if (config.sandbox !== undefined) throw new Error(`${id}/task.json.sandbox is not supported: the native adapter owns source and runtime preparation`);
  // The adapter both prepares the source and grades, so every task file can grade. The candidate answers its
  // instruction, environment, and limits; the grade applies a stored diff to freshly rebuilt source, so a source
  // change that the diff no longer fits fails the regrade instead of scoring it.
  const graderIdentity = await directoryIdentity(taskDir);
  const { checks } = await loadCheckTags(taskDir, id);
  return {
    mode: "implement", kind: "native", id, stratum, family, split, instruction, taskDir,
    ...(environment === undefined ? {} : { environment }),
    ...(timeoutMsOverride === undefined ? {} : { timeoutMs: timeoutMsOverride }),
    native: { command: [command[0], script, ...command.slice(2)], timeoutMs, ...(path === undefined ? {} : { path }) },
    manifest: { traps: [], judgment: [] },
    contentIdentity: structuredIdentity({ kind: "native", task: graderIdentity }),
    candidateIdentity: structuredIdentity({
      kind: "native", id, stratum, instruction,
      ...(environment === undefined ? {} : { environment }),
      ...(timeoutMsOverride === undefined ? {} : { timeoutMs: timeoutMsOverride }),
      ...(path === undefined ? {} : { path }),
    }),
    graderIdentity,
    checks,
  };
}

export async function loadImplementTasks(tasksDir: string): Promise<ImplementTaskSpec[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const tasks: ImplementTaskSpec[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const taskDir = await realDirectoryUnder(tasksDir, containedPath(tasksDir, entry.name), `${entry.name} task directory`);
    const configPath = await realFileUnder(tasksDir, join(taskDir, "task.json"), `${entry.name}/task.json`);
    tasks.push(await loadImplementTask(taskDir, entry.name, objectValue(JSON.parse(await Bun.file(configPath).text()), `${entry.name}/task.json`)));
  }
  if (tasks.length === 0) throw new Error(`No benchmark tasks found in ${tasksDir}`);
  return tasks;
}

type BenchmarkSandboxTask = {
  readonly id: string;
  readonly taskDir: string;
} & (
  | { readonly kind: "native"; readonly sandbox?: never; readonly native: NativeImplementTaskSpec["native"]; readonly plan?: never }
  | { readonly kind?: "plan"; readonly sandbox: ImplementSandboxSpec; readonly plan?: ImplementTaskObject }
);

function openSandboxAuthority(dir: string): ContainedDirectory {
  const authority = openExistingContainedDirectory(dir, [], { noFollowBase: true });
  if (!authority) throw new Error(`Benchmark sandbox is unavailable: ${dir}`);
  return authority;
}

async function materializeSandboxSource(projectRoot: string, task: BenchmarkSandboxTask, dir: string, run: OwnedCommandRunner, evidence: CellEvidence | undefined): Promise<ContainedDirectory> {
  if (task.kind === "native") return openSandboxAuthority(dir);
  const sandbox = task.sandbox;
  if (!("commit" in sandbox)) {
    await cp(await realDirectoryUnder(task.taskDir, join(task.taskDir, sandbox.fixtureRepo), "fixtureRepo"), dir, { recursive: true });
    return openSandboxAuthority(dir);
  }
  await materializeCommitSnapshot(projectRoot, sandbox, dir, run, evidence);
  return openSandboxAuthority(dir);
}

function writeHarnessFiles(directory: ContainedDirectory, plan: ImplementTaskObject | undefined): void {
  if (plan) {
    const planError = directory.writeFile(PLAN_FILE, planDocument(plan));
    if (planError) throw planError;
  }
  const existingIgnore = directory.readFile(".gitignore", MAX_HARNESS_FILE_BYTES);
  const current = existingIgnore?.toString("utf8") ?? "";
  const ignoreError = directory.writeFile(
    ".gitignore",
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}.flywheel/\n${SANDBOX_HOME_DIR}/\n${plan ? `${PLAN_FILE}\n` : ""}`,
  );
  if (ignoreError) throw ignoreError;
}

async function commitBaseline(sandbox: SandboxCommandOptions, run: OwnedCommandRunner): Promise<void> {
  const options = { ...sandbox, step: "Baseline commit" };
  await runCheckedSandboxCommand(run, ["git", "add", "-A"], options);
  await runCheckedSandboxCommand(run, ["git", "-c", "user.email=bench@flywheel.dev", "-c", "user.name=bench", "commit", "-qm", "fixture", "--allow-empty"], options);
  await runCheckedSandboxCommand(run, ["git", "update-ref", BASELINE_REF, "HEAD"], options);
}

async function runSetupCommands(task: BenchmarkSandboxTask, sandbox: SandboxCommandOptions, run: OwnedCommandRunner): Promise<void> {
  if (task.kind === "native") return;
  for (const command of task.sandbox.setup ?? []) {
    if (!command[0]) throw new Error(`Empty setup command for ${task.id}`);
    await runCheckedSandboxCommand(run, command, { ...sandbox, step: "Setup command" });
  }
}

/** Create a fresh sandbox and commit its baseline. Native adapters prepare before
 * the baseline; plan fixtures retain their post-baseline setup commands.
 * Failed preparation retains state and the failed command's output when evidence is supplied,
 * removes the workspace, and throws. Evidence retention failures do not change the preparation outcome.
 * The workspace folder holds the sandbox; it defaults to the system temporary folder. */
export async function provisionTaskSandbox(projectRoot: string, task: BenchmarkSandboxTask, run: OwnedCommandRunner,
  options: { readonly evidence?: CellEvidence; readonly workspaceRoot?: string } = {}): Promise<string> {
  const { evidence, workspaceRoot = tmpdir() } = options;
  const dir = await mkdtemp(join(workspaceRoot, "flywheel-bench-"));
  const sandbox: SandboxCommandOptions = { cwd: dir, sandboxDir: dir, evidence };
  try {
    const authority = await materializeSandboxSource(projectRoot, task, dir, run, evidence);
    try {
      if (task.kind === "native") {
        await runNativeAdapter(task, "prepare", dir, [], run, evidence);
        // The adapter owns source preparation, not Git history.
        if (await Bun.file(join(dir, ".git", "HEAD")).exists()) throw new Error("Native prepare must not create a Git baseline");
        const ignoreError = authority.writeFile(".gitignore", `${authority.readFile(".gitignore", MAX_HARNESS_FILE_BYTES)?.toString("utf8") ?? ""}\n.flywheel/\n${SANDBOX_HOME_DIR}/\n`);
        if (ignoreError) throw ignoreError;
      }
      // Before initialization, Git can discover an enclosing checkout and silently skip this sandbox's patch.
      await initSandboxRepository(run, { ...sandbox, step: "Sandbox repository" });
      if (task.kind !== "native" && task.sandbox.patch) {
        const patch = await realFileUnder(task.taskDir, join(task.taskDir, task.sandbox.patch), "patch");
        await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn"], { ...sandbox, step: "Fixture patch", stdin: await Bun.file(patch).text() });
      }
      if (task.kind !== "native") writeHarnessFiles(authority, task.plan);
      await commitBaseline(sandbox, run);
      if (task.kind !== "native") await runSetupCommands(task, sandbox, run);
    } finally {
      authority.close();
    }
    return dir;
  } catch (error) {
    if (evidence) await retainImplementStore(dir, evidence.directory);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function parseNumstat(output: string): DiffStats {
  let linesAdded = 0;
  let linesRemoved = 0;
  let filesTouched = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [added, removed, file] = line.split("\t");
    if (added === undefined || removed === undefined || file === undefined) continue;
    linesAdded += added === "-" ? 0 : Number(added);
    linesRemoved += removed === "-" ? 0 : Number(removed);
    filesTouched++;
  }
  return { linesAdded, linesRemoved, filesTouched };
}

/** A candidate that runs Python tests leaves bytecode caches beside the imported
 * modules, and a task source without its own ignore rules does not hide them.
 * They are not part of the candidate's change, and git refuses to apply their
 * binary diffs, which would fail the grade of a correct change. */
const PYTHON_BYTECODE_CACHES = "**/__pycache__/**";

/** The folders of the candidate tree that a build tool tagged as caches, such as the `target/` folder of cargo.
 * They leak for the same reason as bytecode caches. A tag file (https://bford.info/cachedir/) marks them precisely,
 * where a name rule would also drop a real source folder named `target`. Read after `git add -A`, the index
 * holds every tag that the candidate committed or left untracked, and none that its ignore rules hide. */
async function taggedCacheFolders(sandbox: SandboxCommandOptions, run: OwnedCommandRunner): Promise<string[]> {
  const tags = await runCheckedSandboxCommand(run, ["git", "ls-files", "-z", "--", ":(glob)**/CACHEDIR.TAG"], sandbox);
  return tags.split("\0").filter(Boolean).map(tag => posix.dirname(tag));
}

/** Capture all candidate changes against the baseline, including candidate commits.
 * Plan fixtures run restored acceptance tests; native adapters grade the patch
 * in a separate fresh workspace. Infrastructure failures throw instead of scoring.
 * Optional evidence retains the output of a failed command without changing its outcome. */
export async function captureImplementation(task: ImplementTaskSpec, sandboxDir: string, run: OwnedCommandRunner, evidence?: CellEvidence): Promise<CapturedImplementation> {
  const harnessPaths = task.kind === "native" ? [".flywheel", SANDBOX_HOME_DIR] : [".flywheel", PLAN_FILE, SANDBOX_HOME_DIR, "acceptance"];
  const sandbox: SandboxCommandOptions = { cwd: sandboxDir, sandboxDir, step: "Capture", evidence };
  await runCheckedSandboxCommand(run, ["git", "add", "-A"], sandbox);
  const excludes = [
    ...[...harnessPaths, PYTHON_BYTECODE_CACHES].map(path => ({ magic: "glob", path })),
    ...(await taggedCacheFolders(sandbox, run)).map(path => ({ magic: "literal", path })),
  ];
  const pathspec = ["--", ".", ...excludes.map(({ magic, path }) => `:(exclude,${magic})${path}`)];
  await runCheckedSandboxCommand(run, [
    "git", "reset", "--quiet", "HEAD", "--",
    ...excludes.map(({ magic, path }) => `:(${magic})${path}`),
  ], sandbox);
  const artifacts = await mkdtemp(join(tmpdir(), "flywheel-bench-capture-"));
  let diff: string;
  try {
    const patch = join(artifacts, "captured.patch");
    await runCheckedSandboxCommand(run, ["git", "diff", "--cached", BASELINE_REF, `--output=${patch}`, ...pathspec], sandbox);
    diff = await Bun.file(await realFileUnder(artifacts, patch, "captured implementation patch")).text();
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
  if (containsSecret(diff)) throw new Error("captured implementation diff contains recognized credential bytes");
  const diffStats = parseNumstat(await runCheckedSandboxCommand(run, ["git", "diff", "--cached", BASELINE_REF, "--numstat", ...pathspec], sandbox));
  if (task.kind === "native") return { diff, diffStats, ...await gradeNativeImplementation(task, diff, run, evidence) };
  return { diff, diffStats, grade: await gradePlanAcceptance(task, sandboxDir, run, sandbox) };
}

/** Run a plan task's hidden acceptance tests in the candidate tree and grade each test by its full JUnit name.
 *  A run that writes no report, or leaves a test out because its file did not load, fails those tests. Every hidden
 *  test of a plan task is one of its tagged checks, so a reported test that the tags do not name is a task error. */
async function gradePlanAcceptance(task: PlanImplementTaskSpec, sandboxDir: string, run: OwnedCommandRunner, sandbox: SandboxCommandOptions): Promise<CheckGrade> {
  const { checks } = task;
  if (!checks) throw new Error(`${task.id} has no checks.json, so its change cannot be graded`);
  const acceptanceDir = join(sandboxDir, "acceptance");
  await rm(acceptanceDir, { recursive: true, force: true });
  await cp(await realDirectoryUnder(task.taskDir, task.acceptanceDir, `${task.id}/acceptance`), acceptanceDir, { recursive: true });
  const artifacts = await mkdtemp(join(tmpdir(), "flywheel-bench-acceptance-"));
  try {
    const report = join(artifacts, "junit.xml");
    // A bare `acceptance` is a path-substring filter, which also runs candidate test files such as src/acceptance-x.test.ts.
    requireCompleteSandboxOutput("sandbox test", await runSandboxCommand(run, ["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, "./acceptance"], sandbox));
    const xml = await Bun.file(report).exists() ? await Bun.file(await realFileUnder(artifacts, report, "acceptance report")).text() : "";
    const results = new Map([...parseJUnitReport(xml)].map(([id, outcome]) => [id, outcome === "pass"]));
    const untagged = [...results.keys()].filter((id) => !checks.has(id));
    if (untagged.length > 0) throw new Error(`${task.id}/checks.json does not tag the acceptance tests ${untagged.join(", ")}`);
    return gradeChecks(checks, results);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
}

/** A native adapter's report: the outcome of each check it ran (true for a pass), keyed by the ids of the task's
 *  `checks.json` for new checks and by the original grader's ids for existing tests, with its evidence. A check that
 *  did not run, such as after a build failure, is left out and fails. */
const NativeGradeSchema = Schema.Struct({
  checks: Schema.Record(Schema.String, Schema.Boolean),
  evidence: Schema.Json,
});
const decodeNativeGrade = Schema.decodeUnknownSync(NativeGradeSchema, { onExcessProperty: "error" });

/** Run the trusted adapter and require it to succeed. Its output can exceed the retention bound, so unlike a
 * checked command it is not required to be complete. */
async function runNativeAdapter(task: Pick<NativeImplementTaskSpec, "taskDir" | "native">, action: "prepare" | "grade", workspace: string, artifacts: readonly string[], run: OwnedCommandRunner,
  evidence: CellEvidence | undefined): Promise<void> {
  const command = [...task.native.command, action, task.taskDir, workspace, ...artifacts];
  const result = await runSandboxCommand(run, command, { cwd: task.taskDir, sandboxDir: workspace, timeoutMs: task.native.timeoutMs });
  await requireSandboxSuccess(command, result, { step: `Native ${action}`, evidence });
}

/** Run the trusted adapter in a fresh workspace. A semantic failure is a valid
 * grade; command failures and invalid reports throw and never become scores.
 * The adapter reconstructs pinned source and original tests from taskDir, then
 * applies captured.patch. It receives: grade, taskDir, workspace, patch, report. */
export async function gradeNativeImplementation(task: NativeImplementTaskSpec, diff: string, run: OwnedCommandRunner, evidence?: CellEvidence): Promise<Pick<CapturedImplementation, "grade" | "nativeGrade">> {
  const workspace = await mkdtemp(join(tmpdir(), "flywheel-bench-grade-"));
  const artifacts = await mkdtemp(join(tmpdir(), "flywheel-bench-grade-artifacts-"));
  try {
    const patch = join(artifacts, "captured.patch");
    const report = join(artifacts, "result.json");
    await Bun.write(patch, diff);
    try {
      await runNativeAdapter(task, "grade", workspace, [patch, report], run, evidence);
    } catch (error) {
      if (evidence) await retainNativeGradeFailure(evidence.directory, diff);
      throw error;
    }
    const resultPath = await realFileUnder(artifacts, report, "native grade report");
    const nativeGrade = await Bun.file(resultPath).text();
    let result;
    try {
      result = decodeNativeGrade(JSON.parse(nativeGrade));
    } catch {
      throw new Error("Invalid native grade report");
    }
    return { grade: gradeChecks(task.checks, new Map(Object.entries(result.checks))), nativeGrade };
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
}
