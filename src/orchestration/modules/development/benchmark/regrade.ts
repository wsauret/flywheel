import { rm } from "node:fs/promises";
import type { OwnedCommandRunner } from "../../../../infra/owned-command.js";
import { appendCampaignRecords, currentGrade, loadAllCampaignRecords, type GradeLine } from "./benchmark-records.js";
import type { BenchmarkCatalog, ImplementTask } from "./catalog.js";
import { captureImplementation, gradeNativeImplementation, provisionTaskSandbox } from "./implement-task.js";
import { runCheckedSandboxCommand } from "./sandbox-command.js";

/** Drop the sections of a captured patch that change a Python bytecode cache. Captures before 2026-11-13 included
 *  them; captureImplementation now excludes them, and git refuses to apply their binary diffs. */
function withoutBytecodeCaches(diff: string): string {
  return diff.split(/(?=^diff --git )/m).filter((section) => !/^diff --git a\/(?:\S*\/)?__pycache__\//.test(section)).join("");
}

/** Grade a stored diff with the task's current grader. A native adapter grades the patch in its own fresh workspace.
 *  A plan task rebuilds its sandbox, applies the diff, and runs its hidden acceptance tests through the same capture
 *  as a campaign. */
async function gradeStoredDiff(projectRoot: string, task: ImplementTask, diff: string, run: OwnedCommandRunner) {
  if (task.kind === "native") return (await gradeNativeImplementation(task, diff, run)).acceptance;
  const sandbox = await provisionTaskSandbox(projectRoot, task, run);
  try {
    await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn"], { cwd: sandbox, sandboxDir: sandbox, stdin: diff });
    return (await captureImplementation(task, sandbox, run)).acceptance;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

/** Regrade every recorded implementer cell whose task changed only in grading since the cell ran: run the current
 *  grader on the cell's stored diff, and append one grade line keyed by the task's grader identity. Earlier lines
 *  stay as they are, and no candidate or judge runs. A cell whose task is gone or changed what the candidate answered
 *  is skipped, because its diff answers another task, and a timed-out cell is never graded. A grader failure throws, as in a campaign, and the grades
 *  appended before it stay. */
export async function regradeRecords(catalog: BenchmarkCatalog, run: OwnedCommandRunner): Promise<{ graded: number; current: number; skipped: number }> {
  const tasks = new Map((await catalog.implementTasks()).map((task) => [task.id, task]));
  let graded = 0;
  let current = 0;
  let skipped = 0;
  for (const campaign of (await loadAllCampaignRecords(catalog.recordsRoot)).filter(({ header }) => header.mode === "implement")) {
    for (const cell of campaign.cells) {
      // A timed-out cell is a failed attempt under every grader: it has no change to grade.
      if (cell.output.kind === "timed-out") continue;
      const task = tasks.get(cell.task);
      if (!task || cell.output.kind !== "implementation" || cell.output.candidateIdentity !== task.candidateIdentity) {
        skipped++;
        continue;
      }
      if (cell.taskIdentity === task.contentIdentity || currentGrade(campaign, cell, task.graderIdentity)) {
        current++;
        continue;
      }
      const acceptance = await gradeStoredDiff(catalog.projectRoot, task, withoutBytecodeCaches(cell.output.diff), run);
      const grade: GradeLine = { kind: "grade", graderIdentity: task.graderIdentity, variant: cell.variant, task: cell.task, repeat: cell.repeat, ...acceptance };
      await appendCampaignRecords(campaign.file, campaign.header, { grades: [grade] });
      graded++;
    }
  }
  return { graded, current, skipped };
}
