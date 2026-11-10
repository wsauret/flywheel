import { completeJudge, type JudgeLoopOptions, type JudgeModel, type JudgeSettlement } from "./judge.js";
import type { ReviewDefect, ReviewManifest } from "./catalog.js";

export interface ReviewCandidate {
  variant: string;
  task: string;
  repeat: number;
  summary: string;
}

export interface ReviewScore {
  variant: string;
  task: string;
  repeat: number;
  caught: readonly string[];
  uncertain: readonly string[];
  unsupportedFindingCount: number;
  /** Unsupported findings the review rated P1 or P2. On a control fixture,
   *  which lists no defect, every finding is unsupported, so this is the
   *  review's alarm count. Absent on persona-v2 scores, which did not ask. */
  unsupportedSevereFindingCount?: number;
}

export type ReviewScoringOptions = JudgeLoopOptions<ReviewScore>;

type ParsedScore = Pick<ReviewScore, "caught" | "uncertain" | "unsupportedFindingCount" | "unsupportedSevereFindingCount">;

/** The judge sees what the catch criteria need and nothing about who found a
 *  defect or whether curation accepted it. */
function judgedManifest(manifest: ReviewManifest): ReviewManifest {
  return {
    ...manifest,
    defects: manifest.defects.map(({ id, title, category, files, catch_criteria }) => ({ id, title, category, files, catch_criteria })),
  };
}

function buildScoringPrompt(manifest: ReviewManifest, reviewText: string): string {
  return [
    "You are scoring a review (of a code change or of an implementation plan) against seeded defects with known ground truth.",
    "A defect counts as caught only when the review identifies the defect specifically enough to satisfy its catch_criteria. Do not award credit for vague concern, a different issue in the same file, or a finding without the required causal detail. Put a defect in uncertain only when the review is close but does not clearly satisfy the criterion. Count review findings that do not correspond to any listed defect as unsupported findings.",
    "Of the unsupported findings, also count those the review rates P1 or P2, or names with an equivalent severity such as critical, high, or blocking. A manifest can list no defects; then every finding is unsupported.",
    "",
    "## Fixture manifest",
    JSON.stringify(judgedManifest(manifest), null, 2),
    "",
    "## Review to score",
    reviewText,
    "",
    "Respond with only one JSON object on one line. Use only defect IDs from the manifest and do not put an ID in both arrays. unsupported_severe_finding_count is at most unsupported_finding_count:",
    `{"caught":["defect-id"],"uncertain":["defect-id"],"unsupported_finding_count":0,"unsupported_severe_finding_count":0}`,
  ].join("\n");
}

function parseIds(value: readonly unknown[], allowed: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item) && !ids.includes(item)) ids.push(item);
  }
  return ids;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseScore(text: string, defects: readonly ReviewDefect[]): JudgeSettlement<ParsedScore> {
  const defectIds = defects.map((defect) => defect.id);
  const allowed = new Set(defectIds);
  const fallback = (error: string): JudgeSettlement<ParsedScore> => ({
    value: { caught: [], uncertain: defectIds, unsupportedFindingCount: 0, unsupportedSevereFindingCount: 0 },
    error,
  });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback("Judge response did not contain JSON");
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null || !("caught" in parsed) || !("uncertain" in parsed) || !("unsupported_finding_count" in parsed) || !("unsupported_severe_finding_count" in parsed)) {
      return fallback("Judge response was not a JSON object");
    }
    const caughtValue = parsed.caught;
    const uncertainValue = parsed.uncertain;
    const unsupported = parsed.unsupported_finding_count;
    const severe = parsed.unsupported_severe_finding_count;
    if (!Array.isArray(caughtValue) || !Array.isArray(uncertainValue) || !isCount(unsupported) || !isCount(severe) || severe > unsupported) {
      return fallback("Judge response did not match the review score schema");
    }
    const caught = parseIds(caughtValue, allowed);
    const uncertain = parseIds(uncertainValue, allowed);
    if (caught.length !== caughtValue.length || uncertain.length !== uncertainValue.length || uncertain.some((id) => caught.includes(id))) {
      return fallback("Judge response contained invalid or duplicate defect IDs");
    }
    return { value: { caught, uncertain, unsupportedFindingCount: unsupported, unsupportedSevereFindingCount: severe }, error: null };
  } catch (error) {
    return fallback(`Judge response JSON failed to parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scoreKey(score: Pick<ReviewScore, "variant" | "task" | "repeat">): string {
  return `${score.variant}\u0000${score.task}\u0000${score.repeat}`;
}

export async function scoreReviews(
  results: readonly ReviewCandidate[],
  manifests: ReadonlyMap<string, ReviewManifest>,
  model: JudgeModel,
  options: ReviewScoringOptions = {},
): Promise<ReviewScore[]> {
  const existing = new Map((options.existing ?? []).map((score) => [scoreKey(score), score]));
  const scores: ReviewScore[] = [];
  for (const result of results) {
    if (options.signal?.aborted) return scores;
    const prior = existing.get(scoreKey(result));
    if (prior) {
      scores.push(prior);
      continue;
    }
    const manifest = manifests.get(result.task);
    if (!manifest) throw new Error(`Missing review manifest for task ${result.task}`);
    const completion = await completeJudge(model, buildScoringPrompt(manifest, result.summary), options.timeoutMs, options.signal);
    // The call is accounted before anything is published: the request was paid
    // for whatever it produced.
    await options.onAttempt?.({
      score: { kind: "review-score", variant: result.variant, task: result.task, repeat: result.repeat },
      terminal: completion.terminal,
      accounting: completion.accounting,
    });
    if (completion.terminal === "cancelled") return scores;
    const parsed = completion.error === null
      ? parseScore(completion.value, manifest.defects)
      : { value: { caught: [], uncertain: manifest.defects.map((defect) => defect.id), unsupportedFindingCount: 0, unsupportedSevereFindingCount: 0 }, error: completion.error };
    const score: ReviewScore = {
      variant: result.variant,
      task: result.task,
      repeat: result.repeat,
      ...parsed.value,
    };
    await options.onSettled?.({ value: score, error: parsed.error });
    // Errored scores are persisted for audit only: an unscored run must not
    // enter recall tallies, and --rescore retries it.
    if (parsed.error === null) scores.push(score);
    // A completion that a cancellation followed is kept: it was paid for and
    // recorded. The stop applies to the calls that would come next.
    if (options.signal?.aborted) return scores;
  }
  return scores;
}
