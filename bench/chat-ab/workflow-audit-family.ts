import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import type { HeadlessBenchmarkExecution } from "../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import type { CampaignFamily } from "./campaign-runner.js";
import type { CampaignSubjectKind } from "./campaign-subject.js";
import { ANSWER_TESTS, answerReference, COMPARISON_TASK, isAnswerTest, namesShippedSite, SHIPPED_SITES, TEST1_WORKFLOW, test1Message, authoredTestMessage } from "./workflow-audit-tests.js";
import { HARNESS_DIR, REPO_ROOT, TASKS_DIR } from "./harness-paths.js";
import { captureSandboxDiff, loadBenchTasks, provisionSandbox, type BenchTask } from "./tasks.js";
import { renderWorkflowAuditReport } from "./workflow-audit-report.js";
import { workflowAuditLedger, type WorkflowAuditCampaign, type WorkflowAuditOutcome } from "./workflow-audit-store.js";

const TEST_IDS = ["test1", "test2", "test3", "test6", ...ANSWER_TESTS] as const;
type WorkflowAuditTestId = typeof TEST_IDS[number];

interface WorkflowAuditTask {
  readonly id: WorkflowAuditTestId;
  readonly fixture: BenchTask;
  readonly contentIdentity: string;
  readonly message: string;
  /** An answer test's written reference answer, which the judge grades against. Null for a bug audit,
   *  which the shipped sites and the shipped fix grade. */
  readonly reference: string | null;
}
const workflowPath = (subject: CampaignSubjectKind) => subject === "flywheel" ? "review.workflow.yaml" : "review.workflow.js";
const taskIdentity = ({ id, contentIdentity }: WorkflowAuditTask) => ({ id, contentIdentity });
const AnswerSchema = Schema.StructWithRest(Schema.Struct({ summary: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)]);

/** The accepted handoff as one answer: its summary, then each other field that holds a value. A subject may put
 *  its findings in result fields beside a short summary, so a grade or a judge that read the summary alone would
 *  grade a part of the answer. Missing handoffs give no answer. */
export function workflowAuditAnswer(handoff: HeadlessBenchmarkExecution["handoff"]): string | null {
  if (handoff === undefined) return null;
  const { summary, ...fields } = Schema.decodeUnknownSync(AnswerSchema)(handoff);
  const filled = Object.entries(fields).filter(([, value]) => !(value === null || value === "" || (Array.isArray(value) && value.length === 0)));
  return [summary, ...filled.map(([key, value]) => `${key}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`)].join("\n\n");
}

/** Site naming is an absolute grade, not a claim that the finding is correct. */
export function workflowAuditGrade(handoff: HeadlessBenchmarkExecution["handoff"]): { readonly [site: string]: boolean } {
  const answer = workflowAuditAnswer(handoff);
  return Object.fromEntries(SHIPPED_SITES.map((site) => [`${site.path}:${site.lines[0]}-${site.lines[1]}`, answer !== null && namesShippedSite(answer, site)]));
}

/** An answer test records no site grade (null), not a grade of zero: it asks for no bug hunt. */
export function workflowAuditSites(task: WorkflowAuditTask, handoff: HeadlessBenchmarkExecution["handoff"]): WorkflowAuditOutcome["sites"] {
  return task.reference === null ? workflowAuditGrade(handoff) : null;
}

/** Every audit test shares the frozen fixture. A bug audit's identity includes both prepared workflows, the
 *  request, and the shipped sites; an answer test's identity includes its request and its reference answer. */
export async function loadWorkflowAuditTasks(ids: readonly string[]): Promise<WorkflowAuditTask[]> {
  const [fixture] = await loadBenchTasks(TASKS_DIR, [COMPARISON_TASK]);
  const authored = ["test2", "test3", "test6", ...ANSWER_TESTS] as const;
  const messages = Object.fromEntries(await Promise.all(authored.map(async (id) => [id, await authoredTestMessage(id)] as const)));
  const references = Object.fromEntries(await Promise.all(ANSWER_TESTS.map(async (id) => [id, await answerReference(id)] as const)));
  const workflows = await Promise.all(Object.values(TEST1_WORKFLOW).map((path) => readFile(path, "utf8")));
  const why = await readFile(join(fixture!.taskDir, "WHY.md"), "utf8");
  return ids.map((id) => {
    if (!isTestId(id)) throw new Error(`Unknown workflow audit test: ${id}`);
    if (isAnswerTest(id)) {
      const message = messages[id]!;
      const reference = references[id]!;
      return { id, fixture: fixture!, message, reference, contentIdentity: structuredIdentity({ id, fixture: fixture!.contentIdentity, why, message, reference }) };
    }
    // Test 1 keeps the test 2 request in its identity, as campaigns recorded before test 3 existed.
    const message = messages[id === "test1" ? "test2" : id]!;
    return { id, fixture: fixture!, message, reference: null, contentIdentity: structuredIdentity({ id, fixture: fixture!.contentIdentity, why, message, workflows, sites: SHIPPED_SITES }) };
  });
}

function isTestId(id: string): id is WorkflowAuditTestId {
  return TEST_IDS.some((known) => known === id);
}

/** Test 1 places the subject's own prepared file in its project, never in a private session directory. */
export async function prepareWorkflowAuditProject(task: WorkflowAuditTask, directory: string, subject: CampaignSubjectKind): Promise<void> {
  if (task.id === "test1") await copyFile(subject === "flywheel" ? TEST1_WORKFLOW.flywheel : TEST1_WORKFLOW.claudeCode, join(directory, workflowPath(subject)));
}

export const workflowAuditFamily: CampaignFamily<WorkflowAuditTask, Pick<WorkflowAuditOutcome, "sites">, WorkflowAuditCampaign, WorkflowAuditOutcome> = {
  kind: "workflow-audit", hiddenTaskDirs: [TASKS_DIR, join(HARNESS_DIR, "workflow-audit")],
  ledger: workflowAuditLedger, requireWritable: () => {},
  loadTasks: loadWorkflowAuditTasks, taskIdentity, qualify: async () => {},
  manifest: (fields, tasks) => ({ ...fields, kind: "workflow-audit", tasks: tasks.map(taskIdentity) }),
  async provision(task, run, root, _treatment, subject) {
    const sandbox = await provisionSandbox(REPO_ROOT, task.fixture, run, root);
    try {
      await prepareWorkflowAuditProject(task, sandbox.dir, subject);
      return sandbox;
    } catch (error) {
      await sandbox.dispose();
      throw error;
    }
  },
  message: (task, _treatment, subject) => task.id === "test1" ? test1Message(workflowPath(subject)) : task.message,
  emptyCapture: () => ({ sites: null }),
  async capture(task, sandbox, run, handoff) {
    const captured = await captureSandboxDiff(sandbox, run, ["review.workflow.yaml", "review.workflow.js"]);
    return { grade: { sites: workflowAuditSites(task, handoff) }, diff: captured.diff };
  },
  report: renderWorkflowAuditReport,
};
