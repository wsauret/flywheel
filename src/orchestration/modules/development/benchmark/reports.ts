import type { BenchmarkTask, ReviewTask } from "./catalog.js";
import type { JudgeVerdict } from "./judge.js";
import type { ReviewScore } from "./scoring.js";
import type { AttemptRecord, JudgeAttemptRecord } from "./run-store.js";
import type { BenchmarkAccounting } from "./evidence.js";
import { formatAccountingObservation } from "./report-accounting.js";

interface ReportVariant {
  id: string;
  model?: string;
  effort?: string;
}

export interface ReportArgs {
  persona: string;
  variants: readonly ReportVariant[];
}

/** What the run did not settle, plus what its judging cost. An unsuccessful
 *  cell attempt produced no run record, and a failed judge call produced no
 *  score; both are audit counts the report must show. Judge spend is benchmark
 *  overhead and is reported apart from the candidate totals. */
export interface ReportCounts {
  failedJudgeCalls: number;
  unsuccessfulAttempts: number;
  unsuccessfulEstimatedUsd: number;
  unsuccessfulBilledUsd: number;
  unsuccessfulTokens: number;
  unsuccessfulAccountingUnavailable: number;
  judgeEstimatedUsd: number;
  judgeBilledUsd: number;
  judgeTokens: number;
  /** Judge calls whose cost or tokens could not be observed, so the reported
   *  overhead is a floor rather than a total. */
  judgeAccountingUnavailable: number;
}

interface RunResult {
  variant: string;
  task: string;
  repeat: number;
  accounting: BenchmarkAccounting;
  durationMs: number;
  summary: string;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function metricRows(args: ReportArgs, tasks: readonly BenchmarkTask[], results: readonly RunResult[], verdicts: readonly JudgeVerdict[]): string[] {
  const rows: string[] = [];
  for (const task of tasks) {
    for (const variant of args.variants) {
      const runs = results.filter((result) => result.task === task.id && result.variant === variant.id);
      const taskVerdicts = verdicts.filter((verdict) => verdict.task === task.id);
      const wins = taskVerdicts.filter((verdict) => verdict.winner === variant.id).length;
      const losses = taskVerdicts.filter((verdict) => verdict.winner !== variant.id && verdict.winner !== "tie").length;
      const ties = taskVerdicts.filter((verdict) => verdict.winner === "tie").length;
      const accounting = runs.map((run) => run.accounting);
      rows.push(`| ${task.id} | ${variant.id} | ${runs.length} | ${formatAccountingObservation(accounting, "estimatedUsd", "average")} | ${formatAccountingObservation(accounting, "billedUsd", "average")} | ${formatAccountingObservation(accounting, "tokens", "average")} | ${Math.round(average(runs.map((run) => run.durationMs)))} | ${wins}-${losses}-${ties} |`);
    }
  }
  return rows;
}

function totalRows(args: ReportArgs, results: readonly RunResult[], verdicts: readonly JudgeVerdict[]): string[] {
  return args.variants.map((variant) => {
    const runs = results.filter((result) => result.variant === variant.id);
    const wins = verdicts.filter((verdict) => verdict.winner === variant.id).length;
    const losses = verdicts.filter((verdict) => verdict.winner !== variant.id && verdict.winner !== "tie").length;
    const ties = verdicts.filter((verdict) => verdict.winner === "tie").length;
    const accounting = runs.map((run) => run.accounting);
    return `| ${variant.id} | ${runs.length} | ${formatAccountingObservation(accounting, "estimatedUsd", "total")} | ${formatAccountingObservation(accounting, "billedUsd", "total")} | ${formatAccountingObservation(accounting, "tokens", "total")} | ${Math.round(average(runs.map((run) => run.durationMs)))} | ${wins}-${losses}-${ties} |`;
  });
}

function overallVerdict(args: ReportArgs, verdicts: readonly JudgeVerdict[]): string {
  if (args.variants.length === 1) return "Pairwise judging was skipped because this campaign has one variant.";
  const standings = args.variants
    .map((variant) => ({ id: variant.id, wins: verdicts.filter((verdict) => verdict.winner === variant.id).length }))
    .sort((left, right) => right.wins - left.wins);
  const ties = verdicts.filter((verdict) => verdict.winner === "tie").length;
  const table = standings.map(({ id, wins }) => `${id}: ${wins}W`).join(", ");
  const leader = standings[0];
  const runnerUp = standings[1];
  if (!leader || !runnerUp) throw new Error("Expected at least two variants");
  if (leader.wins === runnerUp.wins) return `Tie at the top (${table}${ties ? `, ${ties} tied pair${ties === 1 ? "" : "s"}` : ""}).`;
  return `${leader.id} won the blind round-robin (${table}${ties ? `, ${ties} tied pair${ties === 1 ? "" : "s"}` : ""}).`;
}

function attemptNote(counts: ReportCounts): string {
  const accounting = counts.unsuccessfulAccountingUnavailable === 0
    ? `$${counts.unsuccessfulEstimatedUsd.toFixed(4)} estimated equivalent, $${counts.unsuccessfulBilledUsd.toFixed(4)} billed, and ${counts.unsuccessfulTokens} tokens`
    : "unavailable because at least one attempt lacks complete accounting";
  return `- Unsuccessful cell attempts: ${counts.unsuccessfulAttempts}. Their separate cumulative accounting is ${accounting}. Accounting was unavailable for ${counts.unsuccessfulAccountingUnavailable} attempt(s). Every attempt is recorded in the campaign ledger and retried by --resume.`;
}

export function unsuccessfulOverhead(attempts: readonly AttemptRecord[]): Pick<ReportCounts, "unsuccessfulEstimatedUsd" | "unsuccessfulBilledUsd" | "unsuccessfulTokens" | "unsuccessfulAccountingUnavailable"> {
  let unsuccessfulEstimatedUsd = 0;
  let unsuccessfulBilledUsd = 0;
  let unsuccessfulTokens = 0;
  let unsuccessfulAccountingUnavailable = 0;
  for (const attempt of attempts) {
    if (attempt.accounting.estimatedUsd.kind === "observed") unsuccessfulEstimatedUsd += attempt.accounting.estimatedUsd.value;
    if (attempt.accounting.billedUsd.kind === "observed") unsuccessfulBilledUsd += attempt.accounting.billedUsd.value;
    if (attempt.accounting.tokens.kind === "observed") unsuccessfulTokens += attempt.accounting.tokens.value;
    if (
      attempt.accounting.estimatedUsd.kind === "unavailable"
      || attempt.accounting.billedUsd.kind === "unavailable"
      || attempt.accounting.tokens.kind === "unavailable"
    ) unsuccessfulAccountingUnavailable++;
  }
  return { unsuccessfulEstimatedUsd, unsuccessfulBilledUsd, unsuccessfulTokens, unsuccessfulAccountingUnavailable };
}

/** What benchmark judging itself spent, from the ledger of every judge call.
 *  A call that could not be measured raises the unavailable count instead of
 *  contributing a zero, so the reported spend is never overstated. */
export function judgeOverhead(attempts: readonly JudgeAttemptRecord[]): Pick<ReportCounts, "judgeEstimatedUsd" | "judgeBilledUsd" | "judgeTokens" | "judgeAccountingUnavailable"> {
  let judgeEstimatedUsd = 0;
  let judgeBilledUsd = 0;
  let judgeTokens = 0;
  let judgeAccountingUnavailable = 0;
  for (const attempt of attempts) {
    if (attempt.accounting.estimatedUsd.kind === "observed") judgeEstimatedUsd += attempt.accounting.estimatedUsd.value;
    if (attempt.accounting.billedUsd.kind === "observed") judgeBilledUsd += attempt.accounting.billedUsd.value;
    if (attempt.accounting.tokens.kind === "observed") judgeTokens += attempt.accounting.tokens.value;
    if (attempt.accounting.estimatedUsd.kind === "unavailable" || attempt.accounting.billedUsd.kind === "unavailable" || attempt.accounting.tokens.kind === "unavailable") judgeAccountingUnavailable++;
  }
  return { judgeEstimatedUsd, judgeBilledUsd, judgeTokens, judgeAccountingUnavailable };
}

/** Benchmark judging is overhead, not a measurement of the candidates, so its
 *  spend is reported on its own line and joins no candidate total. */
export function judgeOverheadNote(counts: ReportCounts): string {
  const unavailable = counts.judgeAccountingUnavailable;
  const accounting = unavailable === 0
    ? `$${counts.judgeEstimatedUsd.toFixed(4)} estimated equivalent, $${counts.judgeBilledUsd.toFixed(4)} billed, and ${counts.judgeTokens} tokens`
    : "unavailable because at least one judge call lacks complete accounting";
  return `- Judge overhead, excluded from every candidate total above: ${accounting}, from the campaign ledger. Accounting was unavailable for ${unavailable} judge call${unavailable === 1 ? "" : "s"}.`;
}

export function renderReport(args: ReportArgs, tasks: readonly BenchmarkTask[], results: readonly RunResult[], verdicts: readonly JudgeVerdict[], stamp: string, counts: ReportCounts): string {
  const verdictRows = verdicts.map((verdict) =>
    `| ${verdict.task} | ${verdict.repeat} | ${verdict.slotA} | ${verdict.slotB} | ${verdict.winner} | ${cell(verdict.rationale)} |`,
  );
  return [
    `# ${args.persona} persona model A/B benchmark`,
    "",
    `Run: ${stamp}`,
    "",
    "| Variant | Model | Effort |",
    "|---|---|---|",
    ...args.variants.map((variant) => `| ${variant.id} | ${variant.model ?? "profile role"} | ${variant.effort ?? "role policy"} |`),
    "",
    "## Per-task results",
    "",
    "Quality is shown as wins-losses-ties from blinded pairwise judging.",
    "",
    "| Task | Variant | Runs | Avg estimated equivalent | Avg billed | Avg tokens | Avg latency (ms) | Quality |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...metricRows(args, tasks, results, verdicts),
    "",
    "## Totals",
    "",
    "| Variant | Runs | Estimated equivalent | Billed | Total tokens | Avg latency (ms) | Quality |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...totalRows(args, results, verdicts),
    "",
    `**Verdict:** ${overallVerdict(args, verdicts)}`,
    "",
    "## Blind verdicts",
    "",
    "| Task | Repeat | Slot A | Slot B | Winner | Rationale |",
    "|---|---:|---:|---:|---:|---|",
    ...verdictRows,
    "",
    "## Measurement notes",
    "",
    "- Accounting folds distinct committed UsageEntry records. Estimated equivalent and billed cost are separate, and judge calls are excluded from candidate totals.",
    "- Tokens include input, output, cache read, cache write, and reasoning tokens. Latency includes model and tool time until the runner settles.",
    "- The judge compares randomized blinded slots for factual grounding with file:line citations, completeness, and concision. It is a relative quality measure, not an absolute score.",
    attemptNote(counts),
    `- Failed judge calls: ${counts.failedJudgeCalls}. Failed calls remain in the campaign ledger, are excluded from the quality tallies, and retry under --rescore.`,
    judgeOverheadNote(counts),
    "- Small repeat counts are useful for directional results only. Provider load and cache state can affect cost and latency.",
    "",
  ].join("\n");
}

function recall(caught: number, total: number): string {
  return total === 0 ? "n/a" : `${caught}/${total} (${(caught / total * 100).toFixed(1)}%)`;
}

function reviewMetricRows(args: ReportArgs, tasks: readonly ReviewTask[], results: readonly RunResult[], scores: readonly ReviewScore[]): string[] {
  const rows: string[] = [];
  for (const task of tasks) {
    for (const variant of args.variants) {
      const runs = results.filter((result) => result.task === task.id && result.variant === variant.id);
      const runScores = scores.filter((score) => score.task === task.id && score.variant === variant.id);
      const caught = sum(runScores.map((score) => score.caught.length));
      const accounting = runs.map((run) => run.accounting);
      rows.push(`| ${cell(`${task.id}: ${task.manifest.title}`)} | ${variant.id} | ${runs.length} | ${recall(caught, task.manifest.defects.length * runScores.length)} | ${sum(runScores.map((score) => score.uncertain.length))} | ${sum(runScores.map((score) => score.unsupportedFindingCount))} | ${formatAccountingObservation(accounting, "estimatedUsd", "average")} | ${formatAccountingObservation(accounting, "billedUsd", "average")} | ${formatAccountingObservation(accounting, "tokens", "average")} | ${Math.round(average(runs.map((run) => run.durationMs)))} |`);
    }
  }
  return rows;
}

function reviewTotalRows(args: ReportArgs, tasks: readonly ReviewTask[], results: readonly RunResult[], scores: readonly ReviewScore[]): string[] {
  return args.variants.map((variant) => {
    const runs = results.filter((result) => result.variant === variant.id);
    const runScores = scores.filter((score) => score.variant === variant.id);
    const totalDefects = sum(tasks.map((task) => task.manifest.defects.length * runScores.filter((score) => score.task === task.id).length));
    const accounting = runs.map((run) => run.accounting);
    return `| ${variant.id} | ${runs.length} | ${recall(sum(runScores.map((score) => score.caught.length)), totalDefects)} | ${sum(runScores.map((score) => score.uncertain.length))} | ${sum(runScores.map((score) => score.unsupportedFindingCount))} | ${formatAccountingObservation(accounting, "estimatedUsd", "total")} | ${formatAccountingObservation(accounting, "billedUsd", "total")} | ${formatAccountingObservation(accounting, "tokens", "total")} | ${Math.round(average(runs.map((run) => run.durationMs)))} |`;
  });
}

export function renderReviewReport(args: ReportArgs, tasks: readonly ReviewTask[], results: readonly RunResult[], scores: readonly ReviewScore[], stamp: string, counts: ReportCounts): string {
  return [
    `# ${args.persona} detection benchmark`,
    "",
    `Run: ${stamp}`,
    "",
    "| Variant | Model | Effort |",
    "|---|---|---|",
    ...args.variants.map((variant) => `| ${variant.id} | ${variant.model ?? "profile role"} | ${variant.effort ?? "role policy"} |`),
    "",
    "## Per-fixture results",
    "",
    "| Fixture | Variant | Runs | Recall | Uncertain | Unsupported findings | Avg estimated equivalent | Avg billed | Avg tokens | Avg latency (ms) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...reviewMetricRows(args, tasks, results, scores),
    "",
    "## Totals",
    "",
    "| Variant | Runs | Recall | Uncertain | Unsupported findings | Estimated equivalent | Billed | Total tokens | Avg latency (ms) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...reviewTotalRows(args, tasks, results, scores),
    "",
    "## Measurement notes",
    "",
    "- Recall is caught seeded defects divided by total seeded defect opportunities across runs. The judge awards a catch only when the review satisfies the manifest catch criteria.",
    "- Uncertain and unsupported findings are judge classifications. They do not count as caught defects.",
    "- Cost and tokens come from the production subagent statistics stream. Judge calls are excluded. Latency includes model and tool time.",
    attemptNote(counts),
    `- Failed judge calls: ${counts.failedJudgeCalls}. Failed calls remain in the campaign ledger; unscored runs are excluded from recall denominators and retry under --rescore.`,
    judgeOverheadNote(counts),
    "",
  ].join("\n");
}
