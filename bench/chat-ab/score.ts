#!/usr/bin/env bun
// Scores each run of a finished workflow campaign on an absolute rubric.
// The pinned judge reads
// the request, the diff, and the final handoff only, all redacted, and never
// the arm, the model, the cost, the ending, or the acceptance result. Each run
// is scored twice, once with the diff first and once with the handoff first,
// and its score is the mean of the two calls. The scores live in the campaign
// directory under score-<judge>/, so running the same command again resumes.
// With more than one campaign, the scorer also prints one table that puts
// every campaign's model on the same scale.
//
//   bun --conditions=browser bench/chat-ab/score.ts --campaign <dir> [--campaign <dir> ...]
//     [--auth-profile <id>] [--report-only]
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { sum } from "../shared/sum.js";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { BenchmarkAccountingSchema } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import { completeJudge, type JudgeModel } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { createJsonFile, createJsonLinesLedger, readJsonFile, type JsonLinesLedger } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { scoreAcceptance } from "./acceptance.js";
import { mean, tQuantile95 } from "./statistics.js";
import { TASKS_DIR } from "./harness-paths.js";
import { eachJudgeJob } from "./pair-judge.js";
import { campaignRedaction, CHAT_AB_JUDGE, judgeFamilyProblem, runInputs, type RunInputs } from "./judge-inputs.js";
import { historicalCampaignStore, modelComparisonProblem, observedUsd, openCampaignStore, pairedTasks, type CampaignConfig, type RunRecord } from "./store.js";

const JUDGE_TIMEOUT_MS = 600_000;
/** Two calls on one run that differ by this many points flag the run. */
const SPLIT_POINTS = 3;

const SCORE_INSTRUCTIONS = [
  "You are a staff engineer scoring one change made for a request in the Flywheel repository (TypeScript on Bun). You do not know who or what made the change.",
  "",
  "Score the change from 1 to 10:",
  "- 1-2: no diff, the change breaks the build, or the change does not address the request. An empty diff never scores above 2.",
  "- 3-4: the wrong root cause, or the change misses the main path.",
  "- 5-6: the change fixes the main path but misses a path that the request names, adds behavior nobody asked for, or removes a guard or a test.",
  "- 7-8: correct on every path the request names, with small scope or quality problems, and a test is present.",
  "- 9-10: correct and minimal, matches the repository conventions, has a regression test at a boundary a user can see, and the handoff is accurate.",
  "",
  "The handoff is the final report of the work. Use it only to check honesty: lower the score by at most 2 points when the handoff claims something the diff does not contain, such as a test or a verification. A missing handoff costs nothing.",
].join("\n");

const REPLY_FORMAT = `{"correct":"yes"|"partial"|"no","scope":"clean"|"minor"|"major","test":"none"|"weak"|"regression","handoffAccurate":"yes"|"partial"|"no"|"absent","score":<integer 1-10>,"rationale":"At most three sentences."}`;

/** The prompt of one call. Call 0 shows the diff before the handoff and call 1
 *  shows the handoff first, so an order effect shows as a split between them. */
export function scorePrompt(inputs: RunInputs, call: 0 | 1): string {
  const diff = ["## Change (diff)", inputs.diff, ""];
  const handoff = ["## Final handoff", inputs.handoff ?? "This run writes no handoff.", ""];
  return [
    SCORE_INSTRUCTIONS, "",
    "## Request", inputs.request, "",
    ...(call === 0 ? [...diff, ...handoff] : [...handoff, ...diff]),
    "Respond with only one JSON object on one line:",
    REPLY_FORMAT,
  ].join("\n");
}

const ScoreReplySchema = Schema.Struct({
  correct: Schema.Literals(["yes", "partial", "no"]),
  scope: Schema.Literals(["clean", "minor", "major"]),
  test: Schema.Literals(["none", "weak", "regression"]),
  handoffAccurate: Schema.Literals(["yes", "partial", "no", "absent"]),
  score: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10)),
  rationale: Schema.String,
});
type ScoreReply = typeof ScoreReplySchema.Type;
const decodeReply = Schema.decodeUnknownSync(ScoreReplySchema);

/** The judge's reply: the first JSON object in its text. */
export function parseScoreReply(text: string): ScoreReply {
  return decodeReply(JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? ""));
}

export const ScoreCallSchema = Schema.Struct({
  kind: Schema.Literal("chat-ab-score-call"),
  task: Schema.String,
  repeat: Schema.Int,
  /** Binds the score to one attempt of the cell, so a new attempt is scored again. */
  artifactDir: Schema.String,
  call: Schema.Literals([0, 1]),
  reply: Schema.NullOr(ScoreReplySchema),
  error: Schema.NullOr(Schema.String),
  usd: Schema.NullOr(Schema.Number),
  accounting: BenchmarkAccountingSchema,
});
export type ScoreCall = typeof ScoreCallSchema.Type;

const ScoringConfigSchema = Schema.Struct({
  kind: Schema.Literal("chat-ab-scoring"),
  judge: Schema.String,
  judgeEffort: Schema.String,
  promptIdentity: Schema.String,
  redactionIdentity: Schema.String,
});
const decodeScoringConfig = Schema.decodeUnknownSync(ScoringConfigSchema, { onExcessProperty: "error" });

export interface JudgeSpec {
  readonly model: string;
  readonly effort: string;
}

/** One campaign with its score ledger opened. */
export interface CampaignScoring {
  readonly campaignDir: string;
  /** score-<judge>/ inside the campaign. */
  readonly directory: string;
  readonly config: CampaignConfig;
  readonly runs: readonly RunRecord[];
  readonly calls: readonly ScoreCall[];
  /** Calls still owed: every call of every run that has no reply yet. */
  readonly pending: number;
  /** Makes the owed calls through `judge` and records each one, its cost
   *  included, whether or not it produced a score. */
  score(judge: JudgeModel): Promise<void>;
}

/** Opens the scoring of one workflow campaign. It refuses a chat campaign, a
 *  judge from a seat's model family, and a score directory that another
 *  judge, effort, prompt, or redaction wrote. */
export async function openCampaignScoring(campaignDir: string, judge: JudgeSpec = CHAT_AB_JUDGE, tasksDir: string = TASKS_DIR): Promise<CampaignScoring> {
  const store = await openCampaignStore(campaignDir);
  const config = await store.loadConfig();
  if (!config) throw new Error(`${campaignDir} is not a chat A/B campaign: it has no run-config.json`);
  if (!config.cell) throw new Error(`${campaignDir} ran chat cells; score.ts scores workflow campaigns, whose runs write a final handoff`);
  const familyProblem = judgeFamilyProblem(judge.model, [config]);
  if (familyProblem) throw new Error(familyProblem);
  const runs = await store.runs.load();
  const directory = join(campaignDir, `score-${judge.model}`);
  await mkdir(directory, { recursive: true });
  // A run's score must not depend on the other campaigns of one invocation, so each campaign hides only its own seats.
  const redaction = campaignRedaction([config]);
  const scoringConfig = { kind: "chat-ab-scoring" as const, judge: judge.model, judgeEffort: judge.effort, promptIdentity: structuredIdentity([SCORE_INSTRUCTIONS, REPLY_FORMAT]), redactionIdentity: redaction.identity };
  const existing = await readJsonFile(join(directory, "run-config.json"));
  if (existing === undefined) await createJsonFile(join(directory, "run-config.json"), `${JSON.stringify(scoringConfig, null, 2)}\n`);
  else if (JSON.stringify(decodeScoringConfig(JSON.parse(existing))) !== JSON.stringify(scoringConfig)) throw new Error(`${directory} was scored with another judge, effort, prompt, or redaction; remove it to score again`);
  const ledger: JsonLinesLedger<ScoreCall> = createJsonLinesLedger(async () => join(directory, "score-calls.jsonl"), ScoreCallSchema, "repair");
  const calls = await ledger.load();
  const done = new Set(calls.filter((call) => call.reply !== null).map((call) => `${call.artifactDir}/${call.call}`));
  const jobs = runs.flatMap((run) => ([0, 1] as const).map((call) => ({ run, call }))).filter(({ run, call }) => !done.has(`${run.artifactDir}/${call}`));
  return {
    campaignDir,
    directory,
    config,
    runs,
    calls,
    pending: jobs.length,
    async score(model) {
      await eachJudgeJob(jobs, async ({ run, call }) => {
        const settlement = await completeJudge(model, scorePrompt(await runInputs(tasksDir, campaignDir, run, redaction), call), JUDGE_TIMEOUT_MS);
        let reply: ScoreReply | null = null;
        let error = settlement.error;
        if (error === null) {
          try {
            reply = parseScoreReply(settlement.value);
          } catch (cause) {
            error = `unparsable reply: ${cause instanceof Error ? cause.message : String(cause)}`;
          }
        }
        const record: ScoreCall = { kind: "chat-ab-score-call", task: run.task, repeat: run.repeat, artifactDir: run.artifactDir, call, reply, error, usd: observedUsd(settlement.accounting.estimatedUsd), accounting: settlement.accounting };
        await ledger.append(record);
        calls.push(record);
        console.log(`[score] ${run.task}/r${run.repeat} call ${call}: ${reply ? reply.score : error}`);
      });
    },
  };
}

export interface RunScore {
  readonly task: string;
  readonly repeat: number;
  readonly artifactDir: string;
  /** The score of each call, or null when that call has no reply yet. */
  readonly calls: readonly [number | null, number | null];
  /** The mean of the two calls; null until both have a reply. */
  readonly score: number | null;
  /** The two calls differ by SPLIT_POINTS or more. */
  readonly split: boolean;
}

function runScores(runs: readonly RunRecord[], calls: readonly ScoreCall[]): RunScore[] {
  return runs.map((run) => {
    const scored = (call: 0 | 1) => calls.find((row) => row.artifactDir === run.artifactDir && row.call === call && row.reply !== null)?.reply?.score ?? null;
    const [first, second] = [scored(0), scored(1)];
    const both = first !== null && second !== null;
    return { task: run.task, repeat: run.repeat, artifactDir: run.artifactDir, calls: [first, second], score: both ? (first + second) / 2 : null, split: both && Math.abs(first - second) >= SPLIT_POINTS };
  });
}

/** The judge's scores of a campaign's runs, read without a write: null when
 *  the judge has not scored the campaign. A paired campaign's report reads
 *  each arm's scores this way. */
export async function readRunScores(campaignDir: string, runs: readonly RunRecord[], judge: JudgeSpec = CHAT_AB_JUDGE): Promise<RunScore[] | null> {
  const path = join(campaignDir, `score-${judge.model}`, "score-calls.jsonl");
  if (!existsSync(path)) return null;
  return runScores(runs, await createJsonLinesLedger(async () => path, ScoreCallSchema, "reject").load());
}

/** Read retained scores for historical Chat or workflow campaigns without admitting a judge or changing artifacts. */
export async function readHistoricalScoring(campaignDir: string, judge: JudgeSpec = CHAT_AB_JUDGE): Promise<Pick<CampaignScoring, "config" | "runs" | "calls">> {
  const store = historicalCampaignStore(campaignDir);
  const config = await store.loadConfig();
  if (!config) throw new Error(`${campaignDir} is not a chat A/B campaign: it has no run-config.json`);
  const path = join(campaignDir, `score-${judge.model}`, "score-calls.jsonl");
  return { config, runs: await store.runs.load(), calls: await createJsonLinesLedger(async () => path, ScoreCallSchema, "reject").load() };
}

function fixed(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/** The judge's spend over the calls, estimated-equivalent; a call without a price counts as unknown. */
function judgeSpend(calls: readonly ScoreCall[]) {
  return { usd: calls.every((call) => call.usd === null) ? null : sum(calls.flatMap((call) => call.usd === null ? [] : [call.usd])), unpriced: calls.filter((call) => call.usd === null).length };
}

/** Projects one campaign's score ledger into report.md and report.json. Nothing reads these back. */
export function renderScoreReport(scoring: Pick<CampaignScoring, "config" | "runs" | "calls">, judge: JudgeSpec = CHAT_AB_JUDGE) {
  const scores = runScores(scoring.runs, scoring.calls);
  const spend = judgeSpend(scoring.calls);
  const scored = scores.flatMap((run) => run.score === null ? [] : [run.score]);
  const lines = [
    `# Absolute scores: ${scoring.config.arm.id}, ${campaignModels(scoring.config)}`,
    "",
    `Judge: ${judge.model} at ${judge.effort} effort, two calls per run. Runs scored: ${scored.length}/${scores.length}. Mean score: ${fixed(mean(scored))}. Judge spend: ${spend.usd === null ? "n/a" : `$${spend.usd.toFixed(2)}`}${spend.unpriced > 0 ? `, ${spend.unpriced} calls unpriced` : ""}. Failed calls: ${scoring.calls.filter((call) => call.reply === null).length}.`,
    "",
    "| Task | Repeat | Call 0 | Call 1 | Score | Flag |",
    "|---|---:|---:|---:|---:|---|",
    ...scores.map((run) => `| ${run.task} | ${run.repeat} | ${run.calls[0] ?? "n/a"} | ${run.calls[1] ?? "n/a"} | ${fixed(run.score, 1)} | ${run.split ? `calls differ by ${SPLIT_POINTS}+ points` : ""} |`),
  ];
  return { markdown: `${lines.join("\n")}\n`, json: { judge, meanScore: mean(scored), judgeUsd: spend.usd, unpricedCalls: spend.unpriced, runs: scores } };
}

/** The models a campaign pinned, as one label. */
function campaignModels(config: CampaignConfig): string {
  return [...new Set((config.cell ? config.roles : [config.chat]).map((seat) => `${seat.model}${seat.effort ? ` ${seat.effort}` : ""}`))].sort().join(", ");
}

interface TaskMeans { readonly [task: string]: number }

function taskMeans(scores: readonly RunScore[]): TaskMeans {
  const byTask = Map.groupBy(scores.filter((run) => run.score !== null), (run) => run.task);
  return Object.fromEntries([...byTask].map(([task, runs]) => [task, sum(runs.map((run) => run.score!)) / runs.length]));
}

/** The mean paired task difference of two campaigns' scores, left minus
 *  right, with its 90% t interval. Null with fewer than two shared tasks. */
function pairedScoreDifference(left: TaskMeans, right: TaskMeans): { readonly tasks: number; readonly difference: number; readonly interval: readonly [number, number] } | null {
  const differences = Object.keys(left).filter((task) => task in right).map((task) => left[task]! - right[task]!);
  if (differences.length < 2) return null;
  const difference = sum(differences) / differences.length;
  const variance = sum(differences.map((value) => (value - difference) ** 2)) / (differences.length - 1);
  const half = tQuantile95(differences.length - 1) * Math.sqrt(variance / differences.length);
  return { tasks: differences.length, difference, interval: [difference - half, difference + half] };
}

/** One table across campaigns that ran the same agent with different models.
 *  The absolute scores put every model on one scale, so this is the main
 *  measure of a model comparison; compare.ts --differ models only breaks ties.
 *  Every measure covers only the tasks that every campaign ran with the same
 *  content (pairedTasks). The judge spend covers every call. */
export function renderModelTable(campaigns: readonly Pick<CampaignScoring, "config" | "runs" | "calls">[]) {
  for (const campaign of campaigns.slice(1)) {
    const problem = modelComparisonProblem(campaigns[0]!.config, campaign.config);
    if (problem) throw new Error(problem);
  }
  const { shared, changed } = pairedTasks(campaigns.map((campaign) => campaign.config));
  const rows = campaigns.map((campaign) => {
    const runs = campaign.runs.filter((run) => shared.includes(run.task));
    const scores = runScores(runs, campaign.calls);
    const priced = runs.flatMap((run) => run.costUsd === null ? [] : [run.costUsd]);
    return {
      model: campaignModels(campaign.config),
      runs: runs.length,
      meanScore: mean(scores.flatMap((run) => run.score === null ? [] : [run.score])),
      taskScores: taskMeans(scores),
      meanAcceptance: mean(runs.map((run) => scoreAcceptance(run.acceptance).score)),
      meanAgentMinutes: mean(runs.map((run) => run.agentMs / 60_000)),
      meanWallMinutes: mean(runs.map((run) => run.wallMs / 60_000)),
      meanCostUsd: mean(priced),
      totalCostUsd: sum(priced),
      unpricedRuns: runs.length - priced.length,
      judgeUsd: judgeSpend(campaign.calls).usd,
    };
  });
  const tasks = [...new Set(rows.flatMap((row) => Object.keys(row.taskScores)))].sort();
  const pairs = rows.flatMap((left, index) => rows.slice(index + 1).map((right) => ({ left: left.model, right: right.model, result: pairedScoreDifference(left.taskScores, right.taskScores) })));
  const lines = [
    "# Models on one scale",
    "",
    ...(changed.length === 0 ? [] : [`Not compared, because the task changed between the campaigns: ${changed.join(", ")}.`, ""]),
    "| Model | Runs | Mean score | Mean acceptance | Agent min | Wall min | Mean cost | Total cost | Judge spend |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.model} | ${row.runs} | ${fixed(row.meanScore)} | ${fixed(row.meanAcceptance)} | ${fixed(row.meanAgentMinutes, 1)} | ${fixed(row.meanWallMinutes, 1)} | $${fixed(row.meanCostUsd)} | $${row.totalCostUsd.toFixed(2)}${row.unpricedRuns > 0 ? ` (${row.unpricedRuns} unpriced)` : ""} | ${row.judgeUsd === null ? "n/a" : `$${row.judgeUsd.toFixed(2)}`} |`),
    "",
    "## Mean score per task",
    "",
    `| Task | ${rows.map((row) => row.model).join(" | ")} |`,
    `|---|${rows.map(() => "---:").join("|")}|`,
    ...tasks.map((task) => `| ${task} | ${rows.map((row) => fixed(row.taskScores[task] ?? null, 1)).join(" | ")} |`),
    "",
    "## Paired task differences (mean score, 90% t interval)",
    "",
    ...pairs.map(({ left, right, result }) => result === null
      ? `- ${left} minus ${right}: fewer than two shared tasks have scores.`
      : `- ${left} minus ${right}: ${result.difference.toFixed(2)} [${result.interval[0].toFixed(2)}, ${result.interval[1].toFixed(2)}] over ${result.tasks} tasks.`),
  ];
  return { markdown: `${lines.join("\n")}\n`, json: { rows, pairs, changedTasks: changed } };
}

interface Args {
  readonly campaigns: readonly string[];
  readonly authProfile: string;
  readonly reportOnly: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const campaigns: string[] = [];
  let authProfile = process.env.FLYWHEEL_AUTH_PROFILE ?? "";
  let reportOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--campaign") campaigns.push(resolve(value()));
    else if (flag === "--auth-profile") authProfile = value();
    else if (flag === "--report-only") reportOnly = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (campaigns.length === 0) throw new Error("--campaign <dir> is required");
  if (!reportOnly && !authProfile) throw new Error("--auth-profile is required (or FLYWHEEL_AUTH_PROFILE) unless --report-only");
  return { campaigns, authProfile, reportOnly };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { isChatCampaign } = await import("./chat-store.js");
  const historical: string[] = [];
  for (const directory of args.campaigns) {
    if (await isChatCampaign(directory)) {
      const { scoreChatCampaign } = await import("./chat-score.js");
      console.log((await scoreChatCampaign(directory, args.authProfile, args.reportOnly)).markdown);
    } else historical.push(directory);
  }
  if (historical.length === 0) return;
  const scorings = await Promise.all(historical.map((dir) => readHistoricalScoring(dir)));
  for (const scoring of scorings) {
    const report = renderScoreReport(scoring);
    console.log(report.markdown);
  }
  if (scorings.length > 1) console.log(renderModelTable(scorings).markdown);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`chat-ab score failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
