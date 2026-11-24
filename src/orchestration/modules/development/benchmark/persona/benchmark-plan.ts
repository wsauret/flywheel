import type { BenchmarkMode, ImplementTask, ResearchTask, ReviewTask } from "../catalog.js";
import type { VariantSpec } from "../variant.js";

export type BenchmarkOperation = "run" | "resume" | "rescore";

/** The model and effort that score one persona campaign. */
export interface JudgeSelection {
  readonly model: string;
  readonly effort: string;
}

export type PlannedTask = ResearchTask | ReviewTask | ImplementTask;

/** A settled request: every seat, task and path the run will use. */
export interface BenchmarkPlan {
  persona: string;
  mode: BenchmarkMode;
  variants: readonly (Pick<VariantSpec, "id"> & Partial<Pick<VariantSpec, "model" | "effort">>)[];
  repeats: number;
  stamp: string;
  resultsDir: string;
  operation: BenchmarkOperation;
  tasks: readonly PlannedTask[];
  taskIds?: readonly string[];
  /** The pinned judge: the request's pin, or the judge a resumed campaign recorded. */
  judge?: JudgeSelection;
}

/** Whether a campaign calls a judge: every one except a solo research seat
 *  whose tasks have no answer key, which has nothing to compare or score. */
export function campaignJudges(plan: Pick<BenchmarkPlan, "mode" | "variants" | "tasks">): boolean {
  return plan.mode !== "research" || plan.variants.length >= 2 || plan.tasks.some((task) => "answerKey" in task && task.answerKey !== undefined);
}
