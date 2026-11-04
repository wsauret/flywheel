import { existsSync } from "node:fs";
import { join } from "node:path";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { judgePlanningPairs } from "./planning-judge.js";
import { openPlanningCampaign, scorePlanningRecall, type RecallReply } from "./planning-recall.js";
import type { PlanningCampaign, PlanningOutcome } from "./planning-store.js";
import type { PlanningTask } from "./planning-task.js";

export interface PlanningReportInput {
  readonly manifest: Pick<PlanningCampaign, "name" | "repeats"> & { readonly treatments: readonly { readonly id: string }[] };
  readonly tasks: readonly Pick<PlanningTask, "id" | "stratum" | "manifest">[];
  /** Completed cells. */
  readonly outcomes: readonly (Pick<PlanningOutcome, "attemptId" | "cell" | "plan" | "otherChanges"> & { readonly runs: readonly Pick<PlanningOutcome["runs"][number], "outcome">[] })[];
  /** Each scored cell's recall reply, by attempt id. */
  readonly recall: ReadonlyMap<string, RecallReply>;
  /** Each judged comparison: the treatments in slots a and b and their verdicts. */
  readonly pairwise: readonly { readonly a: string; readonly b: string; readonly verdicts: readonly { readonly task: string; readonly winner: "a" | "b" | "tie" | null }[] }[];
}

const ratio = (count: number, total: number) => total === 0 ? "n/a" : `${count}/${total} (${(100 * count / total).toFixed(1)}%)`;

/** Counts per treatment and stratum, then over all strata. No interval is drawn: recall ranks treatments relative to
 *  each other on a handful of tasks. */
export function formatPlanningReport(input: PlanningReportInput): string {
  const strata = [...new Set(input.tasks.map(({ stratum }) => stratum))];
  const lines = [
    `# ${input.manifest.name}`, "",
    `Recall and pairwise judge: ${CHAT_AB_JUDGE.model}; effort: ${CHAT_AB_JUDGE.effort}. Recall counts only cells that the judge scored.`, "",
    "| Stratum | Treatment | Plans / cells | Addressed / opportunities | Uncertain | False premises addressed | Implemented (other changes) | Unanswered / incomplete | Pairwise W/L/T |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const stratum of [...strata, "all"]) {
    const tasks = input.tasks.filter((task) => stratum === "all" || task.stratum === stratum);
    for (const treatment of input.manifest.treatments) {
      const cells = input.outcomes.filter(({ cell }) => cell.treatment === treatment.id && tasks.some(({ id }) => id === cell.task));
      let addressed = 0;
      let opportunities = 0;
      let uncertain = 0;
      let premisesAddressed = 0;
      let premises = 0;
      for (const outcome of cells) {
        const reply = input.recall.get(outcome.attemptId);
        const manifest = tasks.find(({ id }) => id === outcome.cell.task)!.manifest;
        if (!reply || !manifest) continue;
        addressed += reply.addressed.length;
        uncertain += reply.uncertain.length;
        opportunities += manifest.mustAddress.length;
        premises += manifest.falsePremises.length;
        premisesAddressed += manifest.falsePremises.filter((id) => reply.addressed.includes(id)).length;
      }
      const comparisons = input.pairwise.flatMap(({ a, b, verdicts }) => {
        const slot = a === treatment.id ? "a" : b === treatment.id ? "b" : null;
        if (slot === null) return [];
        const judged = verdicts.filter(({ task }) => tasks.some(({ id }) => id === task));
        const count = (won: (winner: "a" | "b" | "tie" | null) => boolean) => judged.filter(({ winner }) => won(winner)).length;
        return [`vs ${slot === "a" ? b : a} ${count((winner) => winner === slot)}/${count((winner) => winner !== null && winner !== "tie" && winner !== slot)}/${count((winner) => winner === "tie")}`];
      });
      const pairwise = comparisons.length === 0 ? "not compared" : comparisons.join("; ");
      lines.push(`| ${stratum} | ${treatment.id} | ${cells.filter(({ plan }) => plan !== null).length}/${tasks.length * input.manifest.repeats} | ${ratio(addressed, opportunities)} | ${uncertain} | ${ratio(premisesAddressed, premises)} | ${cells.filter(({ otherChanges }) => (otherChanges?.filesTouched ?? 0) > 0).length} | ${cells.filter(({ runs }) => runs.at(-1)?.outcome === "input_required").length}/${cells.filter(({ runs }) => runs.at(-1)?.outcome === "incomplete").length} | ${pairwise} |`);
    }
  }
  lines.push("", "A cell that changed any file besides PLAN.md did not comply; its plan is still scored. A cell that asked a question or stopped early keeps the plan it wrote.");
  return lines.join("\n");
}

/** Read the campaign, the recall ledger, and every pairwise ledger that `judge` wrote, for any ordered pair of
 *  treatments, without writes or judge admission. */
export async function renderPlanningReport(directory: string): Promise<string> {
  const { manifest, outcomes, tasks } = await openPlanningCampaign(directory);
  const recall = await scorePlanningRecall(directory, { authProfile: manifest.authProfile, dryRun: true });
  const ids = manifest.treatments.map(({ id }) => id);
  const judged = ids.flatMap((a) => ids.flatMap((b) => a !== b && existsSync(join(directory, `judge-${structuredIdentity([a, b])}.jsonl`)) ? [{ a, b }] : []));
  const comparisons = await Promise.all(judged.map(async ({ a, b }) => ({ a, b, summary: await judgePlanningPairs({ directory, a, b, authProfile: manifest.authProfile, dryRun: true }) })));
  return [
    formatPlanningReport({ manifest, tasks, outcomes, recall: recall.replies, pairwise: comparisons.map(({ a, b, summary }) => ({ a, b, verdicts: summary.taskVerdicts })) }),
    `Recall: ${recall.scored} of ${recall.cells} plans scored, ${recall.pending} pending, ${recall.failedCalls} failed calls.`,
    ...(comparisons.length === 0 ? ["Pairwise: not judged."] : comparisons.map(({ a, b, summary }) => `Pairwise ${a} vs ${b}: ${summary.judged} judged, ${summary.pending} pending, ${summary.skipped.length} skipped.`)),
  ].join("\n");
}
