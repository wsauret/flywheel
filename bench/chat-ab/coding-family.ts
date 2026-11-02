import { renderCodingReport } from "./coding-ab-report.js";
import { codingLedger, requireWritableCodingCampaign, type CodingCampaign, type CodingOutcomeRecord } from "./coding-ab-store.js";
import { captureCodingCell, codingMessage, findCodingTask, HIDDEN_TASK_DIRS, requireQualified, type CodingTask } from "./coding-task.js";
import type { CampaignFamily } from "./campaign-runner.js";
import { REPO_ROOT } from "./harness-paths.js";
import { provisionSandbox } from "./tasks.js";

type CodingGrade = Pick<Extract<CodingOutcomeRecord, { version: 2 }>, "acceptance">;
const taskIdentity = ({ id, role, contentIdentity, qualificationIdentity }: CodingTask) => ({ id, role, contentIdentity, qualificationIdentity });

/** Coding task semantics retain the v2 acceptance payload and handoff/diff artifacts. */
export const codingFamily: CampaignFamily<CodingTask, CodingGrade, CodingCampaign, CodingOutcomeRecord> = {
  kind: "coding-ab",
  hiddenTaskDirs: HIDDEN_TASK_DIRS,
  ledger: codingLedger,
  requireWritable: requireWritableCodingCampaign,
  loadTasks: (ids, input) => Promise.all(ids.map(async (id) => {
    const task = await findCodingTask(id);
    if (!task) throw new Error(`Unknown coding task: ${id}`);
    if (task.role === "reserved-evaluation" && !input.reservedEvaluation) throw new Error(`${id} requires --reserved-evaluation`);
    return task;
  })),
  taskIdentity,
  async qualify(task, run) { await requireQualified(task, run); },
  manifest: (fields, tasks) => ({ ...fields, kind: "coding-ab", tasks: tasks.map(taskIdentity) }),
  provision: (task, run, workspaceRoot) => provisionSandbox(REPO_ROOT, task, run, workspaceRoot),
  message: codingMessage,
  emptyCapture: () => ({ acceptance: null }),
  async capture(task, sandbox, run) {
    const captured = await captureCodingCell(task, sandbox, run);
    return { grade: { acceptance: captured.acceptance }, diff: captured.diff };
  },
  report: renderCodingReport,
};
