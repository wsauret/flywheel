import { join } from "node:path";
import { Schema } from "effect";
import { operatorAccountHome } from "./isolation.js";
import { loadSkillDefinitions, skillStoreRoots } from "../../src/workflows/skills.js";
import { bytesIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { readJsonFile, writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import type { CampaignDesign, CampaignFamily } from "./campaign-runner.js";
import type { CampaignTreatment } from "./campaign-subject.js";
import { chatGrade } from "./chat-family.js";
import { REPO_ROOT, TASKS_DIR } from "./harness-paths.js";
import { captureSandbox, loadBenchTasks, provisionSandbox, taskReference, type BenchTask } from "./tasks.js";
import { captureWorkflowAuthorship, WorkflowAuthorshipMetricsSchema } from "./workflow-authorship-metrics.js";
import { campaignArtifactReference } from "./campaign-artifacts.js";
import { workflowAuthorshipLedger, type WorkflowAuthorshipCampaign, type WorkflowAuthorshipOutcome } from "./workflow-authorship-store.js";
import { renderWorkflowAuthorshipReport } from "./workflow-authorship-report.js";

/** Keep task messages identical. Only the reviewed treatment source patches change the authoring instruction. */

/** The arm follows from the authorship patch a treatment applies, never from its id. No patch is the unpatched product. */
type AuthorshipArm = { expectedWorkflowSource: "authored" | "frozen"; workflowLaunch: "chosen" | "required" };
const AUTHORSHIP_PATCHES = new Map<string, AuthorshipArm>([
  ["bench/chat-ab/workflow-authorship/patches/handcrafted.patch", { expectedWorkflowSource: "frozen", workflowLaunch: "chosen" }],
  ["bench/chat-ab/workflow-authorship/patches/handcrafted-forced.patch", { expectedWorkflowSource: "frozen", workflowLaunch: "required" }],
  ["bench/chat-ab/workflow-authorship/patches/authored-forced.patch", { expectedWorkflowSource: "authored", workflowLaunch: "required" }],
]);
function authorshipArm(patches: readonly string[]): AuthorshipArm {
  const arms = patches.flatMap((path) => AUTHORSHIP_PATCHES.get(path) ?? []);
  if (arms.length > 1) throw new Error("A workflow authorship treatment applies at most one authorship patch");
  return arms[0] ?? { expectedWorkflowSource: "authored", workflowLaunch: "chosen" };
}

export function workflowAuthorshipFamily(design: CampaignDesign, tasksDir = TASKS_DIR): CampaignFamily<BenchTask, Pick<WorkflowAuthorshipOutcome, "grade" | "workflow" | "workflowArtifact">, WorkflowAuthorshipCampaign, WorkflowAuthorshipOutcome> {
  if (Object.keys(design.treatments).length < 1 || Object.keys(design.treatments).length > 2) throw new Error("Workflow authorship requires one or two arms");
  for (const [id, treatment] of Object.entries(design.treatments)) {
    if (!/^(authored|handcrafted)(-forced)?$/.test(id)) throw new Error("Workflow authorship arms must be authored or handcrafted, optionally suffixed -forced");
    if (typeof treatment !== "string" && !("revision" in treatment)) throw new Error("Workflow authorship compares Flywheel source treatments only");
    const roles = typeof treatment === "string" ? design.roles : treatment.roles ?? design.roles;
    if (!roles?.["workflow-agent"]?.model || !roles["workflow-agent"].effort) throw new Error("Pin workflow-agent model and effort for every workflow authorship treatment");
  }
  const taskIdentity = ({ id, stratum, contentIdentity, timeoutMs }: BenchTask) => ({ id, stratum, contentIdentity, timeoutMs });
  return {
    kind: "workflow-authorship", workflowsMode: "on", hiddenTaskDirs: [tasksDir],
    ledger: workflowAuthorshipLedger, requireWritable: () => {},
    async environmentIdentity() {
      const accountHome = await operatorAccountHome();
      const external = loadSkillDefinitions({ roots: skillStoreRoots({ projectRoot: REPO_ROOT, accountHome, userDataRoot: join(accountHome, ".flywheel") })
        .filter(({ reach }) => reach === "global").map(({ dir, reach }) => ({ authority: "external", dir, reach })) });
      return structuredIdentity({
        skills: [...external.skills].map(([id, skill]) => ({ id, packageIdentity: skill.packageIdentity })).sort((a, b) => a.id.localeCompare(b.id)),
        unavailable: [...external.failedSelectionIds].sort(), unreadableRoots: external.unreadableRoots,
      });
    },
    async loadTasks(ids) {
      const tasks = await loadBenchTasks(tasksDir, ids, design.message);
      await Promise.all(tasks.map(taskReference));
      return tasks;
    },
    taskIdentity, qualify: async () => {},
    manifest: (fields, tasks) => ({
      ...fields, kind: "workflow-authorship", tasks: tasks.map(taskIdentity),
      treatments: fields.treatments.map((treatment) => {
        const value = design.treatments[treatment.id]!;
        const settings: CampaignTreatment = typeof value === "string" ? { revision: value } : value;
        if (!("revision" in treatment) || !("revision" in settings)) throw new Error("Workflow authorship requires Flywheel");
        return { ...treatment, workflowsMode: "on" as const, model: settings.model ?? design.model, effort: settings.effort ?? design.effort,
          authProfile: settings.authProfile ?? design.authProfile, ...authorshipArm(settings.patches ?? []) };
      }),
    }),
    provision: (task, run, root) => provisionSandbox(REPO_ROOT, task, run, root),
    message: (task) => task.message,
    emptyCapture: () => ({ grade: null, workflow: { kind: "unavailable", reason: "No workflow evidence captured" }, workflowArtifact: null }),
    async recoverCapture(directory, artifactRoot) {
      const path = join(artifactRoot, "workflow-metrics.json");
      const text = await readJsonFile(path);
      if (text === undefined) return { grade: null, workflow: { kind: "unavailable", reason: "No workflow evidence captured" }, workflowArtifact: null };
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { grade: null, workflow: { kind: "unavailable", reason: "Workflow metrics capture was interrupted" }, workflowArtifact: null };
      }
      const workflow = Schema.decodeUnknownSync(WorkflowAuthorshipMetricsSchema, { onExcessProperty: "error" })(parsed);
      return { grade: null, workflow, workflowArtifact: { path: campaignArtifactReference(directory, path), sha256: bytesIdentity(text) } };
    },
    settle: (outcome) => outcome,
    async capture(task, sandbox, run, _handoff, { executions, artifactRoot, directory, searchEvents }) {
      const last = executions.at(-1)!;
      const workflow = await captureWorkflowAuthorship(last, artifactRoot, searchEvents!);
      const path = join(artifactRoot, "workflow-metrics.json");
      const text = JSON.stringify(workflow);
      await writeArtifactFile(path, text);
      const workflowArtifact = { path: campaignArtifactReference(directory, path), sha256: bytesIdentity(text) };
      if (last.outcome === "failed") return { grade: { grade: null, workflow, workflowArtifact }, diff: "" };
      const captured = await captureSandbox(task, sandbox, run);
      return { grade: { grade: chatGrade(task, captured), workflow, workflowArtifact }, diff: captured.diff };
    },
    report: renderWorkflowAuthorshipReport,
  };
}
