import { Result, Schema } from "effect";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ContainedDirectory } from "../../../../infra/descriptor-directory.js";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../infra/owned-command.js";
import { containsSecret } from "../../../../infra/redact-secrets.js";
import { describeOutputIssues, schemaIssues } from "../../../../workflows/output-contract/accept.js";
import { compileOutput } from "../../../../workflows/output-contract/compile.js";
import { decodeOutputObject } from "../../../../workflows/output-contract/grammar.js";
import planContract from "../../../../workflows/workflows/contracts/implementation-plan.json" with { type: "json" };
import { bytesIdentity, directoryIdentity, structuredIdentity } from "./content-identity.js";
import { containedPath, realDirectoryUnder, realFileUnder } from "./paths.js";
import {
  requireCompleteSandboxOutput,
  runCheckedSandboxCommand,
  runSandboxCommand,
  SANDBOX_HOME_DIR,
} from "./sandbox-command.js";
import { objectValue, parseImplementSandbox, parseManifestPoints, parseNativePath, stringValue, type ImplementManifest, type ImplementSandboxSpec, type ImplementTaskObject } from "./task-schema.js";
import { retainImplementStore, retainNativeGradeFailure, type ImplementEvidence } from "./implement-evidence.js";
import { materializeCommitSnapshot } from "./snapshot-workspace.js";

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
}

interface PlanImplementTaskSpec extends ImplementTaskBase {
  kind?: "plan";
  plan: ImplementTaskObject;
  sandbox: ImplementSandboxSpec;
  acceptanceDir: string;
}

interface NativeImplementTaskSpec extends ImplementTaskBase {
  kind: "native";
  /** Exact UTF-8 text from the contained task.json.instruction file.
   * A .gz suffix means gunzip before strict decoding; BOM and line endings remain intact. */
  instruction: string;
  /** Optional task-contained UTF-8 appendix from task.json.environment.
   * Keeps neutral path and tooling mappings separate from the original request. */
  environment?: string;
  family: string;
  split: "development" | "evaluation";
  sandbox: "greenfield";
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

interface AcceptanceResult {
  passed: number;
  failed: number;
  total: number;
}

export interface CapturedImplementation {
  diff: string;
  diffStats: DiffStats;
  acceptance: AcceptanceResult;
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
  let source;
  if ("commit" in sandbox) {
    const patch = sandbox.patch
      ? await realFileUnder(taskDir, join(taskDir, sandbox.patch), `${entryName}/${sandbox.patch}`)
      : undefined;
    source = {
      kind: "commit",
      commit: sandbox.commit,
      paths: sandbox.paths,
      ...(sandbox.setup ? { setup: sandbox.setup } : {}),
      ...(patch ? {
        patch: {
          path: sandbox.patch,
          identity: bytesIdentity(new Uint8Array(await Bun.file(patch).arrayBuffer())),
        },
      } : {}),
    };
  } else {
    const projectDir = await realDirectoryUnder(taskDir, join(taskDir, sandbox.fixtureRepo), `${entryName}/${sandbox.fixtureRepo}`);
    source = {
      kind: "fixture",
      path: sandbox.fixtureRepo,
      identity: await directoryIdentity(projectDir),
    };
  }
  const timeoutMs = typeof timeoutMinutes === "number" ? Math.round(timeoutMinutes * 60_000) : undefined;
  const contentIdentity = structuredIdentity({
    id,
    stratum,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    source,
    plan: bytesIdentity(planDocument(plan)),
    manifest,
    acceptance: await directoryIdentity(acceptanceDir),
  });
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
  return {
    mode: "implement", kind: "native", id, stratum, family, split, instruction, taskDir, sandbox: "greenfield",
    ...(environment === undefined ? {} : { environment }),
    ...(timeoutMsOverride === undefined ? {} : { timeoutMs: timeoutMsOverride }),
    native: { command: [command[0], script, ...command.slice(2)], timeoutMs, ...(path === undefined ? {} : { path }) },
    manifest: { traps: [], judgment: [] },
    contentIdentity: structuredIdentity({ kind: "native", task: await directoryIdentity(taskDir) }),
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
  | { readonly kind: "native"; readonly sandbox: "greenfield"; readonly native: NativeImplementTaskSpec["native"]; readonly plan?: never }
  | { readonly kind?: "plan"; readonly sandbox: ImplementSandboxSpec; readonly plan?: ImplementTaskObject }
);

function openSandboxAuthority(dir: string): ContainedDirectory {
  const authority = ContainedDirectory.openExisting(dir, [], { noFollowBase: true });
  if (!authority) throw new Error(`Benchmark sandbox is unavailable: ${dir}`);
  return authority;
}

async function materializeSandboxSource(projectRoot: string, task: BenchmarkSandboxTask, dir: string, run: OwnedCommandRunner): Promise<ContainedDirectory> {
  if (task.sandbox === "greenfield") return openSandboxAuthority(dir);
  const sandbox = task.sandbox;
  if (!("commit" in sandbox)) {
    await cp(await realDirectoryUnder(task.taskDir, join(task.taskDir, sandbox.fixtureRepo), "fixtureRepo"), dir, { recursive: true });
    return openSandboxAuthority(dir);
  }
  await materializeCommitSnapshot(projectRoot, sandbox, dir, run);
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

async function commitBaseline(dir: string, run: OwnedCommandRunner): Promise<void> {
  await runCheckedSandboxCommand(run, ["git", "add", "-A"], { cwd: dir, sandboxDir: dir });
  await runCheckedSandboxCommand(run, ["git", "-c", "user.email=bench@flywheel.dev", "-c", "user.name=bench", "commit", "-qm", "fixture", "--allow-empty"], { cwd: dir, sandboxDir: dir });
  await runCheckedSandboxCommand(run, ["git", "update-ref", BASELINE_REF, "HEAD"], { cwd: dir, sandboxDir: dir });
}

async function runSetupCommands(task: BenchmarkSandboxTask, dir: string, run: OwnedCommandRunner): Promise<void> {
  if (typeof task.sandbox === "string" || !("commit" in task.sandbox)) return;
  for (const command of task.sandbox.setup ?? []) {
    if (!command[0]) throw new Error(`Empty setup command for ${task.id}`);
    await runCheckedSandboxCommand(run, command, { cwd: dir, sandboxDir: dir });
  }
}

/** Create a fresh sandbox and commit its baseline. Native adapters prepare before
 * the baseline; plan fixtures retain their post-baseline setup commands.
 * Failed preparation retains state when evidence is supplied, removes the workspace,
 * and throws. Evidence retention failures do not change the preparation outcome.
 * The workspace folder holds the sandbox; it defaults to the system temporary folder. */
export async function provisionTaskSandbox(projectRoot: string, task: BenchmarkSandboxTask, run: OwnedCommandRunner,
  options: { readonly evidence?: ImplementEvidence; readonly workspaceRoot?: string } = {}): Promise<string> {
  const { evidence, workspaceRoot = tmpdir() } = options;
  const dir = await mkdtemp(join(workspaceRoot, "flywheel-bench-"));
  try {
    const authority = await materializeSandboxSource(projectRoot, task, dir, run);
    try {
      if (task.kind === "native") {
        requireNativeAdapterSuccess("prepare", await runNativeAdapter(task, "prepare", dir, [], run));
        // The adapter owns source preparation, not Git history.
        if (await Bun.file(join(dir, ".git", "HEAD")).exists()) throw new Error("Native prepare must not create a Git baseline");
        const ignoreError = authority.writeFile(".gitignore", `${authority.readFile(".gitignore", MAX_HARNESS_FILE_BYTES)?.toString("utf8") ?? ""}\n.flywheel/\n${SANDBOX_HOME_DIR}/\n`);
        if (ignoreError) throw ignoreError;
      }
      // Before initialization, Git can discover an enclosing checkout and silently skip this sandbox's patch.
      await runCheckedSandboxCommand(run, ["git", "init", "-q"], { cwd: dir, sandboxDir: dir });
      if (typeof task.sandbox === "object" && "commit" in task.sandbox && task.sandbox.patch) {
        const patch = await realFileUnder(task.taskDir, join(task.taskDir, task.sandbox.patch), "patch");
        await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn"], { cwd: dir, sandboxDir: dir, stdin: await Bun.file(patch).text() });
      }
      if (task.kind !== "native") writeHarnessFiles(authority, task.plan);
      await commitBaseline(dir, run);
      if (task.kind !== "native") await runSetupCommands(task, dir, run);
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

function parseAcceptance(output: string, exitCode: number): AcceptanceResult {
  const passed = Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0);
  const reportedFailed = Number(output.match(/(\d+)\s+fail/)?.[1] ?? 0);
  const failed = reportedFailed || (exitCode === 0 ? 0 : 1);
  return { passed, failed, total: passed + failed };
}

/** Capture all candidate changes against the baseline, including candidate commits.
 * Plan fixtures run restored acceptance tests; native adapters grade the patch
 * in a separate fresh workspace. Infrastructure failures throw instead of scoring.
 * Optional evidence retains native command failures without changing their outcome. */
export async function captureImplementation(task: ImplementTaskSpec, sandboxDir: string, run: OwnedCommandRunner, evidence?: ImplementEvidence): Promise<CapturedImplementation> {
  const excludes = task.kind === "native" ? [".flywheel", SANDBOX_HOME_DIR] : [".flywheel", PLAN_FILE, SANDBOX_HOME_DIR, "acceptance"];
  const pathspec = [
    "--",
    ".",
    ...excludes.map(path => `:(exclude)${path}`),
  ];
  const sandbox = { cwd: sandboxDir, sandboxDir } as const;
  await runCheckedSandboxCommand(run, ["git", "add", "-A"], sandbox);
  await runCheckedSandboxCommand(run, [
    "git", "reset", "--quiet", "HEAD", "--",
    ...excludes,
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
  const acceptanceDir = join(sandboxDir, "acceptance");
  await rm(acceptanceDir, { recursive: true, force: true });
  await cp(await realDirectoryUnder(task.taskDir, task.acceptanceDir, `${task.id}/acceptance`), acceptanceDir, { recursive: true });
  const test = requireCompleteSandboxOutput(
    "sandbox test",
    await runSandboxCommand(run, ["bun", "test", "acceptance"], sandbox),
  );
  return { diff, diffStats, acceptance: parseAcceptance(`${test.stdout}\n${test.stderr}`, test.exitCode ?? 1) };
}

const NativeGradeSchema = Schema.Struct({
  passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThan(0)),
  evidence: Schema.Json,
});
const decodeNativeGrade = Schema.decodeUnknownSync(NativeGradeSchema, { onExcessProperty: "error" });

async function runNativeAdapter(task: Pick<NativeImplementTaskSpec, "taskDir" | "native">, action: "prepare" | "grade", workspace: string, artifacts: readonly string[], run: OwnedCommandRunner): Promise<OwnedCommandResult> {
  return runSandboxCommand(run, [...task.native.command, action, task.taskDir, workspace, ...artifacts], {
    cwd: task.taskDir, sandboxDir: workspace, timeoutMs: task.native.timeoutMs,
  });
}

function requireNativeAdapterSuccess(action: "prepare" | "grade", result: OwnedCommandResult, evidence?: ImplementEvidence): void {
  if (result.exitCode !== 0 || result.timedOut) {
    const location = evidence ? `; evidence: ${relative(evidence.resultsDir, evidence.directory)}` : "";
    throw new Error(`Native ${action} failed: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}${location}`);
  }
}

/** Run the trusted adapter in a fresh workspace. A semantic failure is a valid
 * grade; command failures and invalid reports throw and never become scores.
 * The adapter reconstructs pinned source and original tests from taskDir, then
 * applies captured.patch. It receives: grade, taskDir, workspace, patch, report. */
async function gradeNativeImplementation(task: NativeImplementTaskSpec, diff: string, run: OwnedCommandRunner, evidence?: ImplementEvidence): Promise<Pick<CapturedImplementation, "acceptance" | "nativeGrade">> {
  const workspace = await mkdtemp(join(tmpdir(), "flywheel-bench-grade-"));
  const artifacts = await mkdtemp(join(tmpdir(), "flywheel-bench-grade-artifacts-"));
  try {
    const patch = join(artifacts, "captured.patch");
    const report = join(artifacts, "result.json");
    await Bun.write(patch, diff);
    const grade = await runNativeAdapter(task, "grade", workspace, [patch, report], run);
    if (evidence && (grade.exitCode !== 0 || grade.timedOut)) {
      await retainNativeGradeFailure(evidence.directory, diff, grade);
    }
    requireNativeAdapterSuccess("grade", grade, evidence);
    const resultPath = await realFileUnder(artifacts, report, "native grade report");
    const nativeGrade = await Bun.file(resultPath).text();
    let result;
    try {
      result = decodeNativeGrade(JSON.parse(nativeGrade));
    } catch {
      throw new Error("Invalid native grade report");
    }
    if (result.passed + result.failed !== result.total) throw new Error("Invalid native grade report counts");
    return { acceptance: { passed: result.passed, failed: result.failed, total: result.total }, nativeGrade };
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
}
