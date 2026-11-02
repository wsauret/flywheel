import type { ReviewManifest } from "./catalog.js";
import type { JudgeVerdict } from "./judge.js";
import { runKey, type AgentRunRecord, type AttemptRecord, type BenchmarkVariant, type JudgeAttemptRecord, type ScoreRecord } from "./run-store.js";
import type { BenchmarkPlan } from "./persona-benchmark.js";

type EvidenceTask =
  | { readonly id: string }
  | { readonly id: string; readonly fixtureDir: string; readonly manifest: ReviewManifest };

type EvidencePlan = Pick<BenchmarkPlan, "persona" | "mode" | "repeats"> & {
  readonly tasks: readonly EvidenceTask[];
  readonly variants: readonly BenchmarkVariant[];
};

type SeatRecord = Pick<AgentRunRecord, "persona" | "mode" | "variant" | "model" | "effort" | "task" | "repeat">;

function isReviewTask(task: EvidenceTask): task is Extract<EvidenceTask, { fixtureDir: string }> {
  return "fixtureDir" in task;
}

function validateCellRecords(plan: EvidencePlan, taskIds: ReadonlySet<string>, records: readonly SeatRecord[], label: string): void {
  for (const record of records) {
    const cell = `${record.variant}/${record.task}/${record.repeat}`;
    if (record.persona !== plan.persona || record.mode !== plan.mode) {
      throw new Error(`${label} ${cell} belongs to ${record.persona}/${record.mode}, not ${plan.persona}/${plan.mode}`);
    }
    const variant = plan.variants.find((candidate) => candidate.id === record.variant);
    if (!variant || variant.model !== record.model || variant.effort !== record.effort) {
      throw new Error(`${label} ${cell} conflicts with the configured variants`);
    }
    if (!taskIds.has(record.task)) throw new Error(`${label} ${cell} has an unknown task`);
    if (record.repeat >= plan.repeats) throw new Error(`${label} ${cell} exceeds configured repeats ${plan.repeats}`);
  }
}

export function validateRuns(plan: EvidencePlan, taskIds: ReadonlySet<string>, runs: readonly AgentRunRecord[]): void {
  validateCellRecords(plan, taskIds, runs, "Run");
  const keys = new Set<string>();
  for (const run of runs) {
    const key = runKey(run);
    if (keys.has(key)) throw new Error(`Duplicate run record for ${run.variant}/${run.task}/${run.repeat}`);
    keys.add(key);
  }
}

export function validateAttempts(plan: EvidencePlan, taskIds: ReadonlySet<string>, attempts: readonly AttemptRecord[]): void {
  validateCellRecords(plan, taskIds, attempts, "Attempt");
  const ids = new Set<string>();
  for (const attempt of attempts) {
    if (ids.has(attempt.attemptId)) throw new Error(`Duplicate attempt record ${attempt.attemptId}`);
    ids.add(attempt.attemptId);
  }
}

/** Refuses judge accounting rows that do not belong to the planned campaign. */
export function validateJudgeAttempts(plan: EvidencePlan, taskIds: ReadonlySet<string>, attempts: readonly JudgeAttemptRecord[]): void {
  const variantIds = new Set(plan.variants.map((variant) => variant.id));
  const ids = new Set<string>();
  const permittedKinds = plan.mode === "research"
    ? new Set(["pair-score"])
    : plan.mode === "reviewer"
      ? new Set(["review-score"])
      : new Set(["pair-score", "trap-score"]);
  for (const attempt of attempts) {
    if (attempt.persona !== plan.persona || attempt.mode !== plan.mode) {
      throw new Error(`Judge attempt ${attempt.attemptId} belongs to ${attempt.persona}/${attempt.mode}, not ${plan.persona}/${plan.mode}`);
    }
    if (ids.has(attempt.attemptId)) throw new Error(`Duplicate judge attempt record ${attempt.attemptId}`);
    ids.add(attempt.attemptId);
    const score = attempt.score;
    if (!permittedKinds.has(score.kind)) {
      throw new Error(`Judge attempt ${attempt.attemptId} uses ${score.kind}, which is not valid for ${plan.mode} mode`);
    }
    if (score.kind === "pair-score") {
      validatePlanCell(plan, taskIds, "Judge pair attempt", score.task, score.repeat);
      validateSeat(variantIds, "Judge pair attempt", score.slotA);
      validateSeat(variantIds, "Judge pair attempt", score.slotB);
      if (score.slotA === score.slotB) throw new Error(`Judge pair attempt compares ${score.slotA} against itself`);
    } else {
      validatePlanCell(plan, taskIds, `Judge ${score.kind} attempt`, score.task, score.repeat);
      validateSeat(variantIds, `Judge ${score.kind} attempt`, score.variant);
    }
  }
}

function validatePlanCell(plan: EvidencePlan, taskIds: ReadonlySet<string>, label: string, task: string, repeat: number): void {
  if (!taskIds.has(task)) throw new Error(`${label} has an unknown task ${task}`);
  if (repeat < 0 || repeat >= plan.repeats) throw new Error(`${label} repeat ${repeat} is outside the configured repeats ${plan.repeats}`);
}

function validateSeat(variantIds: ReadonlySet<string>, label: string, variant: string): void {
  if (!variantIds.has(variant)) throw new Error(`${label} names seat ${variant}, which the run does not have`);
}

function validatePairScore(plan: EvidencePlan, taskIds: ReadonlySet<string>, variantIds: ReadonlySet<string>, verdict: JudgeVerdict): string {
  const label = `Pair score ${verdict.task}/${verdict.repeat}`;
  validatePlanCell(plan, taskIds, label, verdict.task, verdict.repeat);
  validateSeat(variantIds, label, verdict.slotA);
  validateSeat(variantIds, label, verdict.slotB);
  if (verdict.slotA === verdict.slotB) throw new Error(`${label} compares ${verdict.slotA} against itself`);
  if (verdict.winner !== "tie" && verdict.winner !== verdict.slotA && verdict.winner !== verdict.slotB) {
    throw new Error(`${label} names winner ${verdict.winner}, which is neither participant nor a tie`);
  }
  return `pair-score/${verdict.task}/${verdict.repeat}/${[verdict.slotA, verdict.slotB].sort().join("/")}`;
}

/** Refuses stored evidence that does not belong to the planned benchmark. */
export function validateScores(plan: EvidencePlan, taskIds: ReadonlySet<string>, scores: readonly ScoreRecord[]): void {
  validateScoreCells(plan, taskIds, scores);
  const seededDefects = new Map(plan.tasks.filter(isReviewTask).map((task) => [task.id, new Set(task.manifest.defects.map((defect) => defect.id))]));
  for (const record of scores) {
    if (record.kind !== "review-score") continue;
    const { variant, task, repeat, caught, uncertain } = record.score;
    const seeded = seededDefects.get(task) ?? new Set<string>();
    for (const defect of [...caught, ...uncertain]) {
      if (!seeded.has(defect)) throw new Error(`review-score ${variant}/${task}/${repeat} names defect ${defect}, which ${task} does not seed`);
    }
  }
}

/** Validate ledger relationships without copying fixture ground truth into the campaign manifest. */
export function validateScoreCells(plan: EvidencePlan, taskIds: ReadonlySet<string>, scores: readonly ScoreRecord[]): void {
  const variantIds = new Set(plan.variants.map((variant) => variant.id));
  const keys = new Set<string>();
  for (const score of scores) {
    if (score.persona !== plan.persona || score.mode !== plan.mode) {
      throw new Error(`Score record ${score.kind} belongs to ${score.persona}/${score.mode}, not ${plan.persona}/${plan.mode}`);
    }
    let key: string;
    if (score.kind === "pair-score") {
      key = validatePairScore(plan, taskIds, variantIds, score.verdict);
    } else {
      const { variant, task, repeat } = score.score;
      const label = `${score.kind} ${variant}/${task}/${repeat}`;
      validatePlanCell(plan, taskIds, label, task, repeat);
      validateSeat(variantIds, label, variant);
      key = `${score.kind}/${variant}/${task}/${repeat}`;
    }
    if (keys.has(key)) throw new Error(`Duplicate score record for ${key}`);
    keys.add(key);
  }
}
