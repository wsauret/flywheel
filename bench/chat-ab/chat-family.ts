import { classifyAcceptance } from "./acceptance.js";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { BASELINE_ARM_ID, installArm, type Arm } from "./arms.js";
import type { CampaignDesign, CampaignFamily } from "./campaign-runner.js";
import type { CampaignTreatment } from "./campaign-subject.js";
import { chatLedger, requireNewChatCampaign, type ChatCampaign, type ChatOutcome } from "./chat-store.js";
import { renderChatReport } from "./chat-report.js";
import { REPO_ROOT, TASKS_DIR } from "./harness-paths.js";
import { captureSandbox, loadBenchTasks, provisionSandbox, type BenchTask, type CapturedCell } from "./tasks.js";

/** Capture frozen acceptance outcomes without treating absent execution evidence as zero usage. */
export function chatGrade(task: Pick<BenchTask, "acceptanceBaseline">, captured: CapturedCell): NonNullable<ChatOutcome["grade"]> {
  return {
    acceptance: classifyAcceptance(task.acceptanceBaseline, captured.acceptance),
    diffStats: { linesAdded: captured.linesAdded, linesRemoved: captured.linesRemoved, filesTouched: captured.filesTouched },
  };
}

const taskIdentity = ({ id, stratum, contentIdentity, timeoutMs }: BenchTask) => ({ id, stratum, contentIdentity, timeoutMs });

/** Skill arms use the normal project skill store, and the agent loads the arm's skill itself. Provider filters are not treatments. */
export function chatFamily(design: CampaignDesign, arms: ReadonlyMap<string, Arm>): CampaignFamily<BenchTask, Pick<ChatOutcome, "grade">, ChatCampaign, ChatOutcome> {
  for (const [id, treatment] of Object.entries(design.treatments)) {
    if (design.challenge && typeof treatment !== "string" && treatment.subject === "claude-code") throw new Error("Challenge campaigns require Flywheel headless subjects");
    if (typeof treatment !== "string" && treatment.subject === "claude-code" && arms.get(id)?.id !== BASELINE_ARM_ID) {
      throw new Error("Claude Code treatments require the baseline arm; skill arms use the Flywheel store");
    }
  }
  const armIdentity = (id: string) => {
    const arm = arms.get(id)!;
    return { id: arm.id, identity: arm.identity, invokeSkill: arm.invokeSkill ?? null };
  };
  return {
    kind: "chat-ab", hiddenTaskDirs: [TASKS_DIR], ledger: chatLedger, requireWritable: () => {}, requireDirectory: requireNewChatCampaign,
    loadTasks: (ids) => loadBenchTasks(TASKS_DIR, ids, design.message, design.challenge), taskIdentity, qualify: async () => {},
    // A skill arm's task once arrived as a typed skill invocation; the marker
    // keeps a cell recorded under that treatment from matching this one.
    treatmentIdentity: (id) => {
      const arm = armIdentity(id);
      return structuredIdentity(arm.invokeSkill === null ? arm : { ...arm, skillRoute: "agent-load" });
    },
    manifest: (fields, tasks) => ({
      ...fields, kind: "chat-ab", effort: design.effort, tasks: tasks.map(taskIdentity),
      treatments: fields.treatments.map((treatment) => {
        const value = design.treatments[treatment.id]!;
        const settings: CampaignTreatment = typeof value === "string" ? { revision: value } : value;
        return { ...treatment, arm: armIdentity(treatment.id), model: treatment.subject === "claude-code" ? treatment.model : settings.model ?? design.model, effort: settings.effort ?? design.effort, authProfile: settings.subject === "claude-code" ? "Claude Code login" : settings.authProfile ?? design.authProfile };
      }),
    }),
    async provision(task, run, root, treatment, subject) {
      const sandbox = await provisionSandbox(REPO_ROOT, task, run, root);
      try {
        if (subject === "flywheel") await installArm(sandbox.dir, arms.get(treatment)!);
        return sandbox;
      } catch (error) {
        await sandbox.dispose();
        throw error;
      }
    },
    message: (task, treatment, subject) => {
      if (subject === "claude-code") return task.message;
      const arm = arms.get(treatment)!;
      // The agent loads the arm's skill, because people no longer invoke skills.
      return arm.invokeSkill ? `Load the \`${arm.invokeSkill}\` skill with the skill tool, then apply it to this task:\n\n${task.message}` : task.message;
    },
    challenge: (task) => task.challenge?.text,
    emptyCapture: () => ({ grade: null }),
    async capture(task, sandbox, run) {
      const captured = await captureSandbox(task, sandbox, run);
      return { grade: { grade: chatGrade(task, captured) }, diff: captured.diff };
    },
    report: renderChatReport,
  };
}
