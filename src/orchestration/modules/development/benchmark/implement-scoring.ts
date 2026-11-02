import { completeJudge, judgePairs, type JudgeLoopOptions, type JudgeModel, type JudgePairOptions, type JudgeSettlement, type JudgeVerdict } from "./judge.js";
import type { ImplementManifest, ManifestPoint } from "./task-schema.js";
import type { ImplementTask } from "./catalog.js";
import { judgeOverheadNote, type ReportArgs, type ReportCounts } from "./reports.js";
import type { BenchmarkAccounting } from "./evidence.js";
import { IMPLEMENT_QUALITY_RUBRIC } from "../../../../infra/benchmark-rubrics.js";
import { structuredIdentity } from "./content-identity.js";
import { formatAccountingObservation } from "./report-accounting.js";

export interface ImplementCandidate {
  variant: string;
  task: string;
  repeat: number;
  accounting: BenchmarkAccounting;
  durationMs: number;
  summary: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
  acceptancePassed: number;
  acceptanceFailed: number;
  acceptanceTotal: number;
  nativeGrade?: string;
}

type TrapOutcome = "self-corrected" | "followed-blindly" | "silently-lucky" | "unclear";

interface TrapVerdict {
  id: string;
  outcome: TrapOutcome;
  rationale: string;
}

export interface ImplementScore {
  variant: string;
  task: string;
  repeat: number;
  traps: readonly TrapVerdict[];
}

export type TrapScoringOptions = JudgeLoopOptions<ImplementScore>;

const TRAP_OUTCOMES: readonly TrapOutcome[] = ["self-corrected", "followed-blindly", "silently-lucky", "unclear"];
const EMPTY_IMPLEMENT_DIFF = "(no diff)";

function buildTrapPrompt(traps: readonly ManifestPoint[], diff: string, agentText: string): string {
  return [
    "You are classifying how an implementation agent handled known plan traps.",
    "For each trap, use self-corrected when the agent recognized and corrected the trap, followed-blindly when its diff implements the trap, silently-lucky when its diff avoids the trap without showing recognition, and unclear when the evidence cannot distinguish these outcomes. Apply each catchCriteria exactly.",
    "",
    "## Traps",
    JSON.stringify(traps, null, 2),
    "",
    "## Agent diff",
    diff || "(no diff)",
    "",
    "## Agent handoff and final text",
    agentText || "(none)",
    "",
    "Respond with only one JSON object on one line. Include every trap ID exactly once:",
    `{"traps":[{"id":"trap-id","outcome":"self-corrected"|"followed-blindly"|"silently-lucky"|"unclear","rationale":"One concise sentence."}]}`,
  ].join("\n");
}

function unclearTraps(traps: readonly ManifestPoint[], rationale: string): TrapVerdict[] {
  return traps.map((trap) => ({ id: trap.id, outcome: "unclear", rationale }));
}

function parseTrapVerdicts(text: string, traps: readonly ManifestPoint[]): JudgeSettlement<TrapVerdict[]> {
  const fallback = (error: string): JudgeSettlement<TrapVerdict[]> => ({ value: unclearTraps(traps, error), error });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback("Judge response did not contain JSON");
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null || !("traps" in parsed)) return fallback("Judge response was not a JSON object");
    const values = parsed.traps;
    if (!Array.isArray(values)) return fallback("Judge response did not match the trap score schema");
    const verdicts = new Map<string, TrapVerdict>();
    for (const value of values) {
      if (typeof value !== "object" || value === null || !("id" in value) || !("outcome" in value) || !("rationale" in value)) return fallback("Judge response contained a non-object trap verdict");
      const { id, outcome, rationale } = value;
      if (typeof id !== "string" || !traps.some((trap) => trap.id === id) || !TRAP_OUTCOMES.some((candidate) => candidate === outcome) || typeof rationale !== "string" || verdicts.has(id)) {
        return fallback("Judge response contained an invalid trap verdict");
      }
      verdicts.set(id, { id, outcome, rationale });
    }
    if (verdicts.size !== traps.length) return fallback("Judge response did not classify every trap");
    return { value: traps.map((trap) => verdicts.get(trap.id) ?? { id: trap.id, outcome: "unclear", rationale: "Judge response did not classify this trap" }), error: null };
  } catch (error) {
    return fallback(`Judge response JSON failed to parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scoreKey(score: Pick<ImplementScore, "variant" | "task" | "repeat">): string {
  return `${score.variant}\u0000${score.task}\u0000${score.repeat}`;
}

export async function scoreImplementTraps(
  results: readonly ImplementCandidate[],
  manifests: ReadonlyMap<string, ImplementManifest>,
  model: JudgeModel,
  options: TrapScoringOptions = {},
): Promise<ImplementScore[]> {
  const existing = new Map((options.existing ?? []).map((score) => [scoreKey(score), score]));
  const scores: ImplementScore[] = [];
  for (const result of results) {
    if (options.signal?.aborted) return scores;
    const prior = existing.get(scoreKey(result));
    if (prior) {
      scores.push(prior);
      continue;
    }
    const manifest = manifests.get(result.task);
    if (!manifest) throw new Error(`Missing implement manifest for task ${result.task}`);
    let parsed: JudgeSettlement<TrapVerdict[]>;
    if (manifest.traps.length === 0) {
      parsed = { value: [], error: null };
    } else {
      const completion = await completeJudge(model, buildTrapPrompt(manifest.traps, result.diff, result.summary), options.timeoutMs, options.signal);
      // The call is accounted before anything is published: the request was
      // paid for whatever it produced.
      await options.onAttempt?.({
        score: { kind: "trap-score", variant: result.variant, task: result.task, repeat: result.repeat },
        terminal: completion.terminal,
        accounting: completion.accounting,
      });
      if (completion.terminal === "cancelled") return scores;
      parsed = completion.error === null
        ? parseTrapVerdicts(completion.value, manifest.traps)
        : { value: unclearTraps(manifest.traps, completion.error), error: completion.error };
    }
    const score: ImplementScore = { variant: result.variant, task: result.task, repeat: result.repeat, traps: parsed.value };
    await options.onSettled?.({ value: score, error: parsed.error });
    // Errored scores are persisted for audit only: unclear-by-failure must
    // not enter trap tallies, and --rescore retries it.
    if (parsed.error === null) scores.push(score);
    // A completion that a cancellation followed is kept: it was paid for and
    // recorded. The stop applies to the calls that would come next.
    if (options.signal?.aborted) return scores;
  }
  return scores;
}

function buildQualityPrompt(plan: string, diffA: string, diffB: string): string {
  return [
    "You are a meticulous staff engineer comparing two blinded implementation diffs produced from the same plan.",
    IMPLEMENT_QUALITY_RUBRIC,
    "Do not infer model identity from writing style. Allow a tie only when quality is genuinely equal.",
    "",
    "## Plan",
    plan,
    "",
    "## DIFF A",
    diffA || EMPTY_IMPLEMENT_DIFF,
    "",
    "## DIFF B",
    diffB || EMPTY_IMPLEMENT_DIFF,
    "",
    "Respond with only one JSON object on one line:",
    `{"winner":"A"|"B"|"tie","rationale":"At most two concise sentences naming the deciding difference."}`,
  ].join("\n");
}

/** The quality judge must not treat a trapped plan as gospel: without the
 *  disclosure it rewards blind compliance with seeded plan errors that the
 *  trap judge separately penalizes. */
function planForQualityJudging(task: ImplementTask): string {
  if (task.kind === "native") return task.prompt;
  const plan = JSON.stringify(task.plan, null, 2);
  if (task.manifest.traps.length === 0) return plan;
  return [
    plan,
    "",
    "## Known plan defects (seeded; do not reward compliance)",
    "The plan above deliberately contains the following errors. An implementation that follows them verbatim is defective; one that reconciles them against the repository's evidence is correct:",
    ...task.manifest.traps.map((trap) => `- ${trap.id}: ${trap.title} Correct handling: ${trap.catchCriteria}`),
  ].join("\n");
}

/** Identifies every task-derived and static user-prompt byte used by quality judging. */
export function implementQualityJudgeInputIdentity(tasks: readonly ImplementTask[]): string {
  return structuredIdentity({
    promptTemplate: buildQualityPrompt("<PLAN>", "<DIFF_A>", "<DIFF_B>"),
    emptyDiff: EMPTY_IMPLEMENT_DIFF,
    taskPlans: tasks.map((task) => ({ id: task.id, plan: planForQualityJudging(task) })),
  });
}

export function judgeImplementPairs(
  results: readonly ImplementCandidate[],
  tasks: readonly ImplementTask[],
  model: JudgeModel,
  flip?: () => boolean,
  options: JudgePairOptions = {},
): Promise<JudgeVerdict[]> {
  return judgePairs(
    results.map((result) => ({ variant: result.variant, task: result.task, repeat: result.repeat, summary: result.diff })),
    new Map(tasks.map((task) => [task.id, planForQualityJudging(task)])),
    model,
    flip,
    buildQualityPrompt,
    options,
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function ratio(passed: number, total: number): string {
  return total === 0 ? "n/a" : `${passed}/${total} (${(passed / total * 100).toFixed(1)}%)`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function trapCounts(scores: readonly ImplementScore[]): string[] {
  return TRAP_OUTCOMES.map((outcome) => String(sum(scores.map((score) => score.traps.filter((trap) => trap.outcome === outcome).length))));
}

function quality(variant: string, verdicts: readonly JudgeVerdict[]): string {
  const relevant = verdicts.filter((verdict) => verdict.slotA === variant || verdict.slotB === variant);
  const wins = relevant.filter((verdict) => verdict.winner === variant).length;
  const losses = relevant.filter((verdict) => verdict.winner !== variant && verdict.winner !== "tie").length;
  const ties = relevant.filter((verdict) => verdict.winner === "tie").length;
  return `${wins}-${losses}-${ties}`;
}

function reportRow(
  label: string,
  variant: string,
  runs: readonly ImplementCandidate[],
  scores: readonly ImplementScore[],
  verdicts: readonly JudgeVerdict[],
  aggregation: "average" | "total" = "average",
): string {
  const passed = sum(runs.map((run) => run.acceptancePassed));
  const total = sum(runs.map((run) => run.acceptanceTotal));
  const accounting = runs.map((run) => run.accounting);
  return `| ${cell(label)} | ${variant} | ${runs.length} | ${ratio(passed, total)} | ${trapCounts(scores).join(" | ")} | ${quality(variant, verdicts)} | ${average(runs.map((run) => run.linesAdded)).toFixed(1)} | ${average(runs.map((run) => run.linesRemoved)).toFixed(1)} | ${average(runs.map((run) => run.filesTouched)).toFixed(1)} | ${formatAccountingObservation(accounting, "estimatedUsd", aggregation)} | ${formatAccountingObservation(accounting, "billedUsd", aggregation)} | ${formatAccountingObservation(accounting, "tokens", aggregation)} | ${Math.round(average(runs.map((run) => run.durationMs)))} |`;
}

export function renderImplementReport(
  args: ReportArgs,
  tasks: readonly ImplementTask[],
  results: readonly ImplementCandidate[],
  scores: readonly ImplementScore[],
  verdicts: readonly JudgeVerdict[],
  stamp: string,
  counts: ReportCounts,
): string {
  const taskRows: string[] = [];
  const totalRows: string[] = [];
  for (const task of tasks) {
    for (const variant of args.variants) {
      const runs = results.filter((result) => result.task === task.id && result.variant === variant.id);
      const runScores = scores.filter((score) => score.task === task.id && score.variant === variant.id);
      const taskVerdicts = verdicts.filter((verdict) => verdict.task === task.id);
      taskRows.push(reportRow(`${task.id} (${task.stratum})`, variant.id, runs, runScores, taskVerdicts));
    }
  }
  for (const variant of args.variants) {
    totalRows.push(reportRow("All tasks", variant.id, results.filter((result) => result.variant === variant.id), scores.filter((score) => score.variant === variant.id), verdicts, "total"));
  }
  return [
    `# ${args.persona} implementation benchmark`,
    "",
    `Run: ${stamp}`,
    "",
    "| Variant | Model | Effort |",
    "|---|---|---|",
    ...args.variants.map((variant) => `| ${variant.id} | ${variant.model ?? "profile role"} | ${variant.effort ?? "role policy"} |`),
    "",
    "## Per-task results",
    "",
    "| Task | Variant | Runs | Acceptance | Self-corrected | Followed blindly | Silently lucky | Unclear | Quality W-L-T | Avg + | Avg - | Avg files | Avg estimated equivalent | Avg billed | Avg tokens | Avg latency (ms) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...taskRows,
    "",
    "## Totals",
    "",
    "| Scope | Variant | Runs | Acceptance | Self-corrected | Followed blindly | Silently lucky | Unclear | Quality W-L-T | Avg + | Avg - | Avg files | Estimated equivalent | Billed | Total tokens | Avg latency (ms) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...totalRows,
    "",
    "## Blind quality verdicts",
    "",
    "| Task | Repeat | Slot A | Slot B | Winner | Rationale |",
    "|---|---:|---|---|---|---|",
    ...verdicts.map((verdict) => `| ${verdict.task} | ${verdict.repeat} | ${verdict.slotA} | ${verdict.slotB} | ${verdict.winner} | ${cell(verdict.rationale)} |`),
    "",
    "## Measurement notes",
    "",
    ...(tasks.some(task => task.kind !== "native") ? ["- Plan acceptance is the number of hidden Bun tests passed divided by all hidden test outcomes. A build or test-run failure without Bun counts is recorded as one failed outcome."] : []),
    ...(tasks.some(task => task.kind === "native") ? ["- Native acceptance uses original grader counts, with complete original evidence retained in each run. Command failures and missing or invalid reports are unsuccessful attempts, not failed test outcomes."] : []),
    "- Trap classifications compare the agent diff and final handoff against each manifest catch criterion. Tasks without traps do not call the trap judge.",
    "- Quality is wins-losses-ties from randomized blinded pairwise diff judging. Functional correctness is measured by acceptance tests.",
    "- Candidate cost and tokens come from durable run accounting. Judge calls are excluded. Latency includes model and tool time.",
    `- Unsuccessful cell attempts: ${counts.unsuccessfulAttempts}. Every attempt that produced no run record is recorded in attempts.jsonl and retried by --resume.`,
    `- Failed judge calls: ${counts.failedJudgeCalls}. Failed calls remain in judge-attempts.jsonl, are excluded from trap and quality tallies, and retry under --rescore.`,
    judgeOverheadNote(counts),
    "",
  ].join("\n");
}

export interface ImplementRawResult {
  [field: string]: unknown;
}

export function buildImplementRawResults(
  results: readonly ImplementCandidate[],
  scores: readonly ImplementScore[],
  verdicts: readonly JudgeVerdict[],
): readonly ImplementRawResult[] {
  return results.map((result) => {
    const score = scores.find((candidate) => candidate.variant === result.variant && candidate.task === result.task && candidate.repeat === result.repeat);
    const qualityVerdicts = verdicts.filter((verdict) => verdict.task === result.task && verdict.repeat === result.repeat && (verdict.slotA === result.variant || verdict.slotB === result.variant));
    const { summary: agentText, ...run } = result;
    // A run whose trap judge failed carries traps: null; --rescore fills it in.
    return { ...run, agentText, traps: score ? score.traps : null, quality: { record: quality(result.variant, qualityVerdicts), verdicts: qualityVerdicts } };
  });
}
