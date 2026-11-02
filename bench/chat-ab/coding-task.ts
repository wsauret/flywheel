// The coding tasks of the shared campaign runner. A coding task is a benchmark task of
// bench/tasks/coding-development (tuned on) or
// bench/tasks/coding-evaluation (reserved: run at the end only).
//
// Both arms get one request in the same words: the bug from the task's
// plan.json `summary` and its `context.constraints`, and the shape of the
// workflow to author. A plan with one milestone states one bug, and the
// request asks for implement, review by two independent reviewers, fix, and
// verify. A plan with several milestones states independent problems, and the
// request asks for one agent for each problem, each fixing and checking its
// own, and a report of which ones are fixed. The plan's milestones are left
// out, because they state the fix. Each
// arm's working copy is provisioned from the task's commit, patch, and setup
// alike (tasks.ts, provisionSandbox), and the hidden acceptance tests are
// copied in only after the run (tasks.ts, captureSandbox). No cell reads the
// task folders (`HIDDEN_TASK_DIRS`). The task's qualification (its reference
// and alternative patches pass, its broken controls fail) runs once per task
// identity and Bun version before any cell, through bench/tasks/qualify.ts,
// and a task that does not qualify is refused.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { loadImplementTasks } from "../../src/orchestration/modules/development/benchmark/implement-task.js";
import type { OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { parseQualification } from "../tasks/qualify.js";
import { REPO_ROOT, RESULTS_ROOT, TASKS_DIR } from "./harness-paths.js";
import { captureSandbox, type Sandbox } from "./tasks.js";

type CodingRole = "development" | "reserved-evaluation";

const BENCH_TASKS_DIR = join(REPO_ROOT, "bench", "tasks");
const CODING_TASK_DIRS: readonly { readonly role: CodingRole; readonly dir: string }[] = [
  { role: "development", dir: join(BENCH_TASKS_DIR, "coding-development") },
  { role: "reserved-evaluation", dir: join(BENCH_TASKS_DIR, "coding-evaluation") },
];

/** The folders that hold a coding task's hidden tests, answer patches, and provenance, and the older chat-ab tasks
 *  that describe the same fixes. No cell of either arm reads them. */
export const HIDDEN_TASK_DIRS: readonly string[] = [...CODING_TASK_DIRS.map(({ dir }) => dir), TASKS_DIR];

export interface CodingTask {
  readonly id: string;
  readonly role: CodingRole;
  readonly tasksDir: string;
  readonly taskDir: string;
  readonly acceptanceDir: string;
  readonly sandbox: { readonly commit: string; readonly paths: readonly string[]; readonly setup?: readonly (readonly string[])[]; readonly patch?: string };
  readonly timeoutMs: number;
  readonly summary: string;
  readonly constraints: readonly string[];
  /** The shape of the workflow that the request asks for. */
  readonly workflow: "review" | "fan-out";
  /** Every test id the qualification declares, as `<file> > <name>`: the hidden acceptance tests and any visible test
   *  of the fixture. */
  readonly testIds: readonly string[];
  readonly contentIdentity: string;
  readonly qualificationIdentity: string;
  /** The text of the task's reference patch, which the judge reads as the reference fix. */
  readonly referencePatch: string;
}

const DEFAULT_TIMEOUT_MS = 45 * 60_000;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The coding task `id`, or undefined when no coding task folder holds it. */
export async function findCodingTask(id: string): Promise<CodingTask | undefined> {
  for (const { role, dir } of CODING_TASK_DIRS) {
    if (!existsSync(join(dir, id, "task.json"))) continue;
    const spec = (await loadImplementTasks(dir)).find((task) => task.id === id);
    if (!spec) continue;
    if (spec.kind === "native" || !("commit" in spec.sandbox)) throw new Error(`${id}: a coding task must pin a commit sandbox`);
    const qualificationText = await readFile(join(spec.taskDir, "qualification.json"), "utf8");
    const qualification = parseQualification(JSON.parse(qualificationText), spec.contentIdentity);
    if (qualification.role !== role) throw new Error(`${id}: qualification.json names the role ${qualification.role}, and the task lies in the ${role} folder`);
    const reference = qualification.cases.find((control) => control.id === "reference");
    if (!reference || reference.patches.length !== 1) throw new Error(`${id}: qualification.json names no single-patch reference case`);
    const context = spec.plan["context"];
    const summary = spec.plan["summary"];
    if (typeof summary !== "string" || !summary.trim()) throw new Error(`${id}/plan.json has no summary`);
    const milestones = spec.plan["milestones"];
    return {
      id,
      role,
      tasksDir: dir,
      taskDir: spec.taskDir,
      acceptanceDir: spec.acceptanceDir,
      sandbox: spec.sandbox,
      timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      summary: summary.trim(),
      constraints: stringList(isRecord(context) ? context["constraints"] : undefined),
      workflow: Array.isArray(milestones) && milestones.length > 1 ? "fan-out" : "review",
      testIds: qualification.testIds,
      contentIdentity: spec.contentIdentity,
      qualificationIdentity: structuredIdentity(qualification),
      referencePatch: await readFile(join(spec.taskDir, reference.patches[0]!), "utf8"),
    };
  }
  return undefined;
}

/** The request both arms get, in the same words. */
export function codingMessage(task: Pick<CodingTask, "summary" | "constraints" | "workflow">): string {
  return [
    task.summary,
    "",
    ...(task.constraints.length === 0 ? [] : ["Constraints:", ...task.constraints.map((constraint) => `- ${constraint}`), ""]),
    ...(task.workflow === "fan-out" ? fanOutRequest() : reviewRequest(task.constraints)),
  ].join("\n");
}

function fanOutRequest(): readonly string[] {
  return [
    "Do this work with one workflow that fixes the problems in parallel:",
    "1. Fix: one lane for each independent problem. Each lane fixes its problem in the source code, runs the existing tests that cover the file it changed, and returns `file`, `fixed` (true or false), `change`, and each command that it ran with its result.",
    "2. Report: after every lane finishes, report which problems are fixed and which are not, with the evidence of each lane.",
    "",
    "When the workflow completes, reply with a short report: each problem, its cause, the change, and the test results.",
  ];
}

function reviewRequest(constraints: readonly string[]): readonly string[] {
  return [
    "Do this work with one workflow that has these steps, in this order:",
    // A task that forbids test changes gets no test request, so the request never contradicts its constraints.
    constraints.some((constraint) => /do not change tests/i.test(constraint))
      ? "1. Implement: fix the bug in the source code. Prove the fix with a test outside the repository, and say where it is."
      : "1. Implement: fix the bug in the source code, and add or update a focused test that fails without the fix and passes with it.",
    "2. Review: two independent reviewers each review the change. Each reviewer returns `findings`, a list in which each finding has `site` (file:line) and `description`. A reviewer that finds no problem returns an empty list.",
    "3. Fix: address each confirmed finding. Return `findings`, with one entry for each review finding: `site`, `confirmed` (true or false), and `change` (what you changed, or why you changed nothing).",
    "4. Verify: run the relevant tests. Return each command that you ran and its result.",
    "",
    "When the workflow completes, reply with a short report: the cause of the bug, the change, the test, each review finding and what was done about it, and the final test results.",
  ];
}

/** The qualification report that bench/tasks/qualify.ts writes, reduced to what the harness reads. */
const QualificationReportSchema = Schema.Struct({
  qualified: Schema.Boolean,
  cases: Schema.Array(Schema.Struct({
    id: Schema.String,
    qualified: Schema.Boolean,
    reasons: Schema.Array(Schema.String),
    actualFailures: Schema.optional(Schema.Array(Schema.String)),
  })),
});
type QualificationReport = typeof QualificationReportSchema.Type;
const decodeQualificationReport = Schema.decodeUnknownSync(QualificationReportSchema);

/** Runs the task's qualification once per task identity, qualification identity, and Bun version, and refuses a task
 *  that does not qualify. The report is kept under the results root and reused by later campaigns. */
export async function requireQualified(task: CodingTask, run: OwnedCommandRunner): Promise<{ readonly path: string; readonly report: QualificationReport; readonly reused: boolean }> {
  const folder = join(RESULTS_ROOT, "qualification");
  await mkdir(folder, { recursive: true });
  const key = structuredIdentity({ content: task.contentIdentity, qualification: task.qualificationIdentity, bun: Bun.version }).slice(0, 16);
  const path = join(folder, `${task.id}-${key}.json`);
  const stored = await readFile(path, "utf8").then((text) => decodeQualificationReport(JSON.parse(text)), () => undefined);
  if (stored?.qualified) return { path, report: stored, reused: true };
  await rm(path, { force: true });
  const { exitCode, stdout, stderr } = await run(
    [process.execPath, "run", join(BENCH_TASKS_DIR, "qualify.ts"), "--task", task.id, "--tasks-dir", task.tasksDir, "--output", path],
    { cwd: REPO_ROOT, timeoutMs: 600_000 },
  );
  await writeFile(`${path}.log`, stdout);
  const report = await readFile(path, "utf8").then((text) => decodeQualificationReport(JSON.parse(text)), () => undefined);
  if (!report) throw new Error(`${task.id}: the qualification wrote no report (exit code ${exitCode}): ${stderr.slice(-1000)}`);
  if (!report.qualified || exitCode !== 0) {
    const failed = report.cases.filter((control) => !control.qualified).map((control) => `${control.id}: ${control.reasons.join("; ")}`);
    throw new Error(`${task.id} does not qualify, so no cell runs it (report ${path}):\n${failed.join("\n")}`);
  }
  return { path, report, reused: false };
}

/** The test paths each run's acceptance runs: every file that a declared test id names. */
export function acceptanceTestPaths(testIds: readonly string[]): string[] {
  return [...new Set(testIds.map((id) => `./${id.split(" > ")[0]!}`))];
}

/** What a capture leaves out of each arm's diff: each arm's own workflow files, which are not part of the change. The
 *  Flywheel session store (`.flywheel`) and `acceptance` are left out by every capture. */
const AGENT_WORKFLOW_EXCLUDES = [".claude", "**/*.workflow.js", "**/*.workflow.yaml", "**/*.workflow.yml"] as const;

interface AcceptanceOutcome {
  /** Each declared test id's outcome; `missing` when the run reported no result for it. */
  readonly tests: { readonly [id: string]: "pass" | "fail" | "missing" };
  readonly passed: number;
  readonly total: number;
  readonly allPass: boolean;
}

export interface CodingCapture {
  readonly diff: string;
  /** Null when the acceptance run timed out or wrote no report. */
  readonly acceptance: AcceptanceOutcome | null;
}

/** Captures one arm's final tree: its diff against the baseline, then the declared tests with the hidden acceptance
 *  tests copied in. */
export async function captureCodingCell(task: CodingTask, sandbox: Sandbox, run: OwnedCommandRunner): Promise<CodingCapture> {
  const captured = await captureSandbox({ id: task.id, taskDir: task.taskDir, sandbox: task.sandbox, acceptanceDir: task.acceptanceDir }, sandbox, run, { excludes: AGENT_WORKFLOW_EXCLUDES, tests: acceptanceTestPaths(task.testIds) });
  const results = captured.acceptance;
  const tests = Object.fromEntries(task.testIds.map((id) => [id, results === null ? "missing" : results.get(id) ?? "missing"] as const));
  const passed = Object.values(tests).filter((outcome) => outcome === "pass").length;
  return {
    diff: captured.diff,
    acceptance: results === null ? null : { tests, passed, total: task.testIds.length, allPass: passed === task.testIds.length },
  };
}


type Json = { readonly [key: string]: unknown };
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
