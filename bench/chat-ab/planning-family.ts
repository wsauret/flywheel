import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { containsSecret } from "../../src/infra/redact-secrets.js";
import { bytesIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { readJsonFile, writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { campaignArtifactReference } from "./campaign-artifacts.js";
import type { CampaignDesign, CampaignFamily } from "./campaign-runner.js";
import type { CampaignTreatment } from "./campaign-subject.js";
import { REPO_ROOT } from "./harness-paths.js";
import { loadPlanningTasks, PLANNING_TASKS_DIR, qualifyPlanningTask, type PlanningTask } from "./planning-task.js";
import { planningLedger, type PlanningCampaign, type PlanningOutcome } from "./planning-store.js";
import { renderPlanningReport } from "./planning-report.js";
import { captureSandboxDiff, provisionSandbox, type Sandbox } from "./tasks.js";

type PlanningCapture = Pick<PlanningOutcome, "plan" | "planMissing" | "otherChanges">;

const PLAN_FILE = "PLAN.md";
const PLAN_ARTIFACT = "plan.md";

/** The plan that the Chat left at the sandbox root, or why there is none. A link is refused: it can point outside the
 *  sandbox. */
async function readPlan(sandbox: Sandbox): Promise<{ text: string } | { missing: string }> {
  const path = join(sandbox.dir, PLAN_FILE);
  const stat = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return { missing: `The run wrote no ${PLAN_FILE}` };
  if (!stat.isFile()) return { missing: `${PLAN_FILE} is not a regular file` };
  const text = await readFile(path, "utf8");
  if (containsSecret(text)) throw new Error(`${PLAN_FILE} contains recognized credential bytes`);
  return { text };
}

/** v1 compares Flywheel source treatments only. */
export function planningFamily(design: CampaignDesign, tasksDir = PLANNING_TASKS_DIR): CampaignFamily<PlanningTask, PlanningCapture, PlanningCampaign, PlanningOutcome> {
  const settings = (id: string): CampaignTreatment => {
    const value = design.treatments[id]!;
    return typeof value === "string" ? { revision: value } : value;
  };
  for (const id of Object.keys(design.treatments)) {
    if (!("revision" in settings(id))) throw new Error("Planning compares Flywheel source treatments only");
  }
  const taskIdentity = ({ id, stratum, contentIdentity, timeoutMs }: PlanningTask) => ({ id, stratum, contentIdentity, timeoutMs });
  const empty = (planMissing: string): PlanningCapture => ({ plan: null, planMissing, otherChanges: null });
  return {
    kind: "planning", hiddenTaskDirs: [tasksDir],
    ledger: planningLedger, requireWritable: () => {},
    loadTasks: (ids) => loadPlanningTasks(tasksDir, ids),
    taskIdentity, qualify: qualifyPlanningTask,
    manifest: (fields, tasks) => ({
      ...fields, kind: "planning", tasks: tasks.map(taskIdentity),
      treatments: fields.treatments.map((treatment) => {
        const value = settings(treatment.id);
        if (!("revision" in treatment) || !("revision" in value)) throw new Error("Planning requires Flywheel");
        return { ...treatment, model: value.model ?? design.model, effort: value.effort ?? design.effort, authProfile: value.authProfile ?? design.authProfile };
      }),
    }),
    provision: (task, run, root) => provisionSandbox(REPO_ROOT, task, run, root),
    message: (task) => task.message,
    emptyCapture: () => empty("No plan was captured"),
    async recoverCapture(directory, artifactRoot) {
      const path = join(artifactRoot, PLAN_ARTIFACT);
      const text = await readJsonFile(path);
      if (text === undefined) return empty("No plan was captured");
      return { plan: { path: campaignArtifactReference(directory, path), sha256: bytesIdentity(text) }, planMissing: null, otherChanges: null };
    },
    async capture(_task, sandbox, run, _handoff, { artifactRoot, directory }) {
      const plan = await readPlan(sandbox);
      const changes = await captureSandboxDiff(sandbox, run, [PLAN_FILE]);
      const otherChanges = { linesAdded: changes.linesAdded, linesRemoved: changes.linesRemoved, filesTouched: changes.filesTouched };
      if ("missing" in plan) return { grade: { ...empty(plan.missing), otherChanges }, diff: changes.diff };
      const path = join(artifactRoot, PLAN_ARTIFACT);
      await writeArtifactFile(path, plan.text);
      return { grade: { plan: { path: campaignArtifactReference(directory, path), sha256: bytesIdentity(plan.text) }, planMissing: null, otherChanges }, diff: changes.diff };
    },
    report: renderPlanningReport,
  };
}
