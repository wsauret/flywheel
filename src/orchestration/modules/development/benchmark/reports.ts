import type { BenchmarkTask, ReviewTask } from "./catalog.js";
import type { JudgeVerdict } from "./judge.js";
import type { ReviewScore } from "./scoring.js";
import type { AttemptRecord, JudgeAttemptRecord } from "./run-store.js";
import type { BenchmarkAccounting } from "./evidence.js";
import { combineBenchmarkAccounting, formatAccountingObservation, formatOverheadAccounting } from "./report-accounting.js";

interface ReportVariant {
  id: string;
  model?: string;
  effort?: string;
}

export interface ReportArgs {
  persona: string;
  variants: readonly ReportVariant[];
  /** The campaign's resolved judge, when it has one. */
  judge?: { model: string; effort: string };
}

/** What the run did not settle, plus what its judging cost. An unsuccessful
 *  cell attempt produced no run record, and a failed judge call produced no
 *  score; both are audit counts the report must show. Judge spend is benchmark
 *  overhead and is reported apart from the candidate totals. */
export interface ReportCounts {
  failedJudgeCalls: number;
  unsuccessfulAttempts: number;
  unsuccessfulAccounting: BenchmarkAccounting;
  /** Unsuccessful attempts with at least one unavailable cost or token total. */
  unsuccessfulAccountingUnavailable: number;
  judgeAccounting: BenchmarkAccounting;
  /** Judge calls with at least one unavailable cost or token total. */
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
  return `- Unsuccessful cell attempts: ${counts.unsuccessfulAttempts}. Their separate cumulative accounting is ${formatOverheadAccounting(counts.unsuccessfulAccounting)}. Accounting was unavailable for ${counts.unsuccessfulAccountingUnavailable} attempt(s). Every attempt is recorded in the campaign ledger and retried by --resume.`;
}

function hasUnavailableTotal(accounting: BenchmarkAccounting): boolean {
  return accounting.estimatedUsd.kind === "unavailable" || accounting.billedUsd.kind === "unavailable" || accounting.tokens.kind === "unavailable";
}

/** What the unsuccessful cell attempts spent. An attempt with no complete
 *  accounting makes the total a lower bound, never a silent zero. */
export function unsuccessfulOverhead(attempts: readonly Pick<AttemptRecord, "accounting">[]): Pick<ReportCounts, "unsuccessfulAccounting" | "unsuccessfulAccountingUnavailable"> {
  return {
    unsuccessfulAccounting: combineBenchmarkAccounting(attempts.map((attempt) => attempt.accounting)),
    unsuccessfulAccountingUnavailable: attempts.filter((attempt) => hasUnavailableTotal(attempt.accounting)).length,
  };
}

/** What benchmark judging itself spent, from the ledger of every judge call.
 *  A call that could not be fully measured makes the total a lower bound
 *  instead of contributing a zero, so the reported spend is never overstated
 *  as exact. */
export function judgeOverhead(attempts: readonly Pick<JudgeAttemptRecord, "accounting">[]): Pick<ReportCounts, "judgeAccounting" | "judgeAccountingUnavailable"> {
  return {
    judgeAccounting: combineBenchmarkAccounting(attempts.map((attempt) => attempt.accounting)),
    judgeAccountingUnavailable: attempts.filter((attempt) => hasUnavailableTotal(attempt.accounting)).length,
  };
}

/** Benchmark judging is overhead, not a measurement of the candidates, so its
 *  spend is reported on its own line and joins no candidate total. */
export function judgeOverheadNote(counts: ReportCounts): string {
  const unavailable = counts.judgeAccountingUnavailable;
  return `- Judge overhead, excluded from every candidate total above: ${formatOverheadAccounting(counts.judgeAccounting)}, from the campaign ledger. Accounting was unavailable for ${unavailable} judge call${unavailable === 1 ? "" : "s"}.`;
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

/** A fixture that lists no defect is a control: a reviewed change that no
 *  recorded review found anything in. */
function isControl(task: ReviewTask): boolean {
  return task.manifest.defects.length === 0;
}

/** The P1/P2 unsupported count of some scores, or undefined when one of them
 *  was scored before the judge counted severity. */
function severeCount(scores: readonly ReviewScore[]): number | undefined {
  let total = 0;
  for (const score of scores) {
    if (score.unsupportedSevereFindingCount === undefined) return undefined;
    total += score.unsupportedSevereFindingCount;
  }
  return total;
}

/** Alarms on controls: the share of scored control cells with at least one
 *  P1/P2 finding, and the mean P1/P2 count per scored control cell. */
function controlAlarms(scores: readonly ReviewScore[]): string {
  if (scores.length === 0) return "n/a";
  const severe = severeCount(scores);
  if (severe === undefined) return "not measured";
  const alarmed = scores.filter((score) => (score.unsupportedSevereFindingCount ?? 0) > 0).length;
  return `${alarmed}/${scores.length} (${(alarmed / scores.length * 100).toFixed(1)}%), mean ${(severe / scores.length).toFixed(2)}`;
}

/** One report row's measurements over some fixtures and one variant. */
function reviewTally(tasks: readonly ReviewTask[], variant: string, results: readonly RunResult[], scores: readonly ReviewScore[]) {
  const ids = new Set(tasks.map((task) => task.id));
  const controls = new Set(tasks.filter(isControl).map((task) => task.id));
  const runs = results.filter((result) => result.variant === variant && ids.has(result.task));
  const runScores = scores.filter((score) => score.variant === variant && ids.has(score.task));
  const defectScores = runScores.filter((score) => !controls.has(score.task));
  return {
    runs,
    accounting: runs.map((run) => run.accounting),
    recall: recall(
      sum(defectScores.map((score) => score.caught.length)),
      sum(tasks.map((task) => task.manifest.defects.length * defectScores.filter((score) => score.task === task.id).length)),
    ),
    uncertain: sum(runScores.map((score) => score.uncertain.length)),
    unsupported: `${sum(defectScores.map((score) => score.unsupportedFindingCount))} (${severeCount(defectScores) ?? "not measured"})`,
    alarms: controlAlarms(runScores.filter((score) => controls.has(score.task))),
    latency: Math.round(average(runs.map((run) => run.durationMs))),
  };
}

/** Whether a variant runs on the judge's model, whose scores a judge may favor. */
function sharesJudgeModel(args: ReportArgs, variant: ReportVariant): boolean {
  return variant.model !== undefined && variant.model === args.judge?.model;
}

/** A variant as a review report row names it, marked when it shares the judge's model. */
function variantName(args: ReportArgs, variant: ReportVariant): string {
  return sharesJudgeModel(args, variant) ? `${variant.id} [judge model]` : variant.id;
}

function judgeLine(args: ReportArgs): string {
  if (!args.judge) return "Judge: none";
  const shared = args.variants.filter((variant) => sharesJudgeModel(args, variant)).map((variant) => variant.id);
  return `Judge: ${args.judge.model}:${args.judge.effort}. ${shared.length === 0
    ? "No candidate shares its model."
    : `Candidates that share its model, marked [judge model], may be scored in their favor: ${shared.join(", ")}.`}`;
}

/** How many fixtures of each origin the run covers. Recall on a restored
 *  change is measured on a rebuilt base, not on the tree its recorded review
 *  saw, so a reader must know the mix. */
function fixtureOriginLine(tasks: readonly ReviewTask[]): string {
  const count = (variant: string) => tasks.filter((task) => (task.source.kind === "commit" ? task.source.variant : "authored") === variant).length;
  return `Fixtures: ${count("recorded")} recorded, ${count("restore")} restored, ${count("authored")} hand-authored. A restored fixture rebuilds a change reviewed before the public history on a public commit, so the files around the change are newer than the ones its recorded reviewer saw.`;
}

function reviewMetricRows(args: ReportArgs, tasks: readonly ReviewTask[], results: readonly RunResult[], scores: readonly ReviewScore[]): string[] {
  return tasks.flatMap((task) => args.variants.map((variant) => {
    const tally = reviewTally([task], variant.id, results, scores);
    return `| ${cell(`${task.id}: ${task.manifest.title}`)} | ${task.stratum} | ${variantName(args, variant)} | ${tally.runs.length} | ${tally.recall} | ${tally.uncertain} | ${tally.unsupported} | ${tally.alarms} | ${formatAccountingObservation(tally.accounting, "estimatedUsd", "average")} | ${formatAccountingObservation(tally.accounting, "billedUsd", "average")} | ${formatAccountingObservation(tally.accounting, "tokens", "average")} | ${tally.latency} |`;
  }));
}

const STRATA: readonly ReviewTask["stratum"][] = ["S1", "S2", "S3", "S4", "plan"];

function reviewStratumRows(args: ReportArgs, tasks: readonly ReviewTask[], results: readonly RunResult[], scores: readonly ReviewScore[]): string[] {
  return STRATA.flatMap((stratum) => {
    const members = tasks.filter((task) => task.stratum === stratum);
    if (members.length === 0) return [];
    const controls = members.filter(isControl).length;
    return args.variants.map((variant) => {
      const tally = reviewTally(members, variant.id, results, scores);
      return `| ${stratum} | ${members.length - controls} | ${controls} | ${variantName(args, variant)} | ${tally.runs.length} | ${tally.recall} | ${tally.unsupported} | ${tally.alarms} | ${formatAccountingObservation(tally.accounting, "estimatedUsd", "average")} | ${tally.latency} |`;
    });
  });
}

function reviewTotalRows(args: ReportArgs, tasks: readonly ReviewTask[], results: readonly RunResult[], scores: readonly ReviewScore[]): string[] {
  return args.variants.map((variant) => {
    const tally = reviewTally(tasks, variant.id, results, scores);
    return `| ${variantName(args, variant)} | ${tally.runs.length} | ${tally.recall} | ${tally.uncertain} | ${tally.unsupported} | ${tally.alarms} | ${formatAccountingObservation(tally.accounting, "estimatedUsd", "total")} | ${formatAccountingObservation(tally.accounting, "billedUsd", "total")} | ${formatAccountingObservation(tally.accounting, "tokens", "total")} | ${tally.latency} |`;
  });
}

export function renderReviewReport(args: ReportArgs, tasks: readonly ReviewTask[], results: readonly RunResult[], scores: readonly ReviewScore[], stamp: string, counts: ReportCounts): string {
  return [
    `# ${args.persona} detection benchmark`,
    "",
    `Run: ${stamp}`,
    "",
    judgeLine(args),
    "",
    fixtureOriginLine(tasks),
    "",
    "| Variant | Model | Effort |",
    "|---|---|---|",
    ...args.variants.map((variant) => `| ${variantName(args, variant)} | ${variant.model ?? "profile role"} | ${variant.effort ?? "role policy"} |`),
    "",
    "## Per-fixture results",
    "",
    "| Fixture | Stratum | Variant | Runs | Recall | Uncertain | Unsupported (P1/P2) | Control alarms | Avg estimated equivalent | Avg billed | Avg tokens | Avg latency (ms) |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...reviewMetricRows(args, tasks, results, scores),
    "",
    "## By diff size",
    "",
    "| Stratum | Defect fixtures | Controls | Variant | Runs | Recall | Unsupported (P1/P2) | Control alarms | Avg estimated equivalent | Avg latency (ms) |",
    "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|",
    ...reviewStratumRows(args, tasks, results, scores),
    "",
    "## Totals",
    "",
    "| Variant | Runs | Recall | Uncertain | Unsupported (P1/P2) | Control alarms | Estimated equivalent | Billed | Total tokens | Avg latency (ms) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...reviewTotalRows(args, tasks, results, scores),
    "",
    "## Measurement notes",
    "",
    "- Recall is caught seeded defects divided by total seeded defect opportunities across runs. The judge awards a catch only when the review satisfies the manifest catch criteria.",
    "- Uncertain and unsupported findings are judge classifications. They do not count as caught defects. Unsupported findings on defect fixtures are shown as all (P1/P2).",
    "- A control is a reviewed change that no recorded review found anything in. Control alarms are the scored control cells with at least one P1/P2 finding, and the mean P1/P2 count per scored control cell: alarms on accepted-clean changes, not proven false findings.",
    "- Strata count the changed lines of the reviewed diff: S1 at most 50, S2 at most 200, S3 at most 600, S4 above 600; a plan review has no diff.",
    "- Cost and tokens come from the production subagent statistics stream. Judge calls are excluded. Latency includes model and tool time.",
    attemptNote(counts),
    `- Failed judge calls: ${counts.failedJudgeCalls}. Failed calls remain in the campaign ledger; unscored runs are excluded from recall denominators and retry under --rescore.`,
    judgeOverheadNote(counts),
    "",
  ].join("\n");
}
