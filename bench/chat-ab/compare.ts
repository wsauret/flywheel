#!/usr/bin/env bun
// Judges a candidate campaign against a baseline campaign. For every task and
// repeat both campaigns completed, the pinned judge (judge-inputs.ts), from a
// model family no seat uses, reads the request, the fix that shipped (as a
// statement of intent only), and the two diffs under neutral labels, with each
// side's final handoff when both are workflow campaigns. Every input is
// redacted the way score.ts redacts it. Each pair is judged twice with the
// slots swapped (verdict.ts). The comparison lives in the candidate campaign
// directory, so running the same command again resumes it.
//
// `--differ arm` (the default) pairs two campaigns whose arm is the one
// difference and applies the adopt rule. `--differ models` pairs two workflow
// campaigns whose seats are the one difference and reports only the
// win-tie-loss tally: the absolute scores of score.ts are the main measure of
// a model comparison, and the pairs only break ties.
//
//   bun --conditions=browser bench/chat-ab/compare.ts --baseline <dir> --candidate <dir>
//     [--differ arm|models] [--auth-profile <id>] [--min-win-ratio 2] [--max-cost-increase 0.3]
import { basename, join, resolve } from "node:path";
import { Schema } from "effect";
import { createJsonLinesLedger } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { scoreAcceptance } from "./acceptance.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { VerdictSchema } from "./pair-judge.js";
import { comparabilityProblem, historicalCampaignStore, modelComparisonProblem, pairedTasks, type CampaignConfig, type RunRecord } from "./store.js";
import { decide, pairOutcome, sideOf, DEFAULT_RULE, type DecisionRule, type PairSide } from "./verdict.js";

const CallSchema = Schema.Struct({
  kind: Schema.Literal("chat-ab-judge-call"),
  task: Schema.String,
  repeat: Schema.Int,
  order: Schema.Literals([0, 1]),
  baselineFirst: Schema.Boolean,
  verdict: Schema.NullOr(VerdictSchema),
  error: Schema.NullOr(Schema.String),
  usd: Schema.NullOr(Schema.Number),
});
type CallRecord = typeof CallSchema.Type;

type Differ = "arm" | "models";

interface Args {
  readonly baseline: string;
  readonly candidate: string;
  readonly differ: Differ;
  readonly authProfile: string;
  readonly rule: DecisionRule;
  readonly reportOnly: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  let reportOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--report-only") { reportOnly = true; continue; }
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Expected --flag value pairs, got ${flag}`);
    flags.set(flag, value);
    index++;
  }
  const required = (flag: string) => {
    const value = flags.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  const known = new Set(["--baseline", "--candidate", "--differ", "--auth-profile", "--min-win-ratio", "--max-cost-increase"]);
  for (const flag of flags.keys()) if (!known.has(flag)) throw new Error(`Unknown option: ${flag}`);
  const authProfile = flags.get("--auth-profile") ?? process.env.FLYWHEEL_AUTH_PROFILE ?? "";
  if (!authProfile) throw new Error("--auth-profile is required (or FLYWHEEL_AUTH_PROFILE)");
  const ratio = (flag: string, fallback: number) => {
    const value = Number(flags.get(flag) ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number, such as 2 or 0.3`);
    return value;
  };
  const differ = flags.get("--differ") ?? "arm";
  if (differ !== "arm" && differ !== "models") throw new Error("--differ must be arm or models");
  return {
    baseline: resolve(required("--baseline")),
    candidate: resolve(required("--candidate")),
    differ,
    authProfile,
    reportOnly,
    rule: {
      minWinRatio: ratio("--min-win-ratio", DEFAULT_RULE.minWinRatio),
      maxCostIncrease: ratio("--max-cost-increase", DEFAULT_RULE.maxCostIncrease),
    },
  };
}

async function loadCampaign(dir: string): Promise<{ config: CampaignConfig; runs: RunRecord[] }> {
  const store = historicalCampaignStore(dir);
  const config = await store.loadConfig();
  if (!config) throw new Error(`${dir} is not a chat A/B campaign: it has no run-config.json`);
  return { config, runs: await store.runs.load() };
}

/** A pair is fair only when both sides ran the same agent: the same Flywheel
 *  source, module composition, and account skills. Only the arm differs, or,
 *  for a model comparison, only the seats. */
function requireComparable(differ: Differ, baseline: CampaignConfig, candidate: CampaignConfig): void {
  const problem = differ === "models" ? modelComparisonProblem(baseline, candidate) : comparabilityProblem(baseline, candidate);
  if (problem) throw new Error(problem);
  // A model comparison always runs one arm, so only an arm comparison of one arm measures noise.
  if (differ === "arm" && baseline.arm.id === candidate.arm.id && baseline.arm.identity === candidate.arm.identity) console.log("[compare] both campaigns ran the same arm; the result measures run-to-run noise");
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

interface Pair { readonly baseline: RunRecord; readonly candidate: RunRecord }

function renderComparison(args: Args, baseline: CampaignConfig, candidate: CampaignConfig, pairs: readonly Pair[], plannedPairs: number, calls: readonly CallRecord[], skippedTasks: readonly string[]) {
  const settled = (pair: Pair, order: 0 | 1) => calls.find((call) => call.task === pair.candidate.task && call.repeat === pair.candidate.repeat && call.order === order && call.verdict !== null);
  const rows = pairs.map((pair) => {
    const orders = [settled(pair, 0), settled(pair, 1)] as const;
    const sides = orders.map((call) => call?.verdict ? sideOf(call.verdict.winner, call.baselineFirst) : undefined);
    const outcome = sides[0] !== undefined && sides[1] !== undefined ? pairOutcome([sides[0], sides[1]]) : "unjudged";
    return { pair, orders, outcome };
  });
  const count = (side: PairSide | "tie" | "unjudged") => rows.filter((row) => row.outcome === side).length;
  const tally = { candidate: count("candidate"), baseline: count("baseline"), ties: count("tie"), unjudged: count("unjudged") };
  // Cost compares only pairs priced on both sides, so an unpriced cell never
  // shifts one side's mean alone.
  const priced = pairs.filter((pair) => pair.baseline.costUsd !== null && pair.candidate.costUsd !== null);
  const cost = (side: "baseline" | "candidate") => mean(priced.map((pair) => pair[side].costUsd ?? 0));
  const costIncrease = priced.length === 0 || cost("baseline") === 0 ? null : cost("candidate") / cost("baseline") - 1;
  const decision = args.differ === "arm" ? decide(tally, costIncrease, args.rule, pairs.map(({ baseline: before, candidate: after }) => ({
    caseId: `${after.task}/r${after.repeat}`,
    baseline: before.acceptance,
    candidate: after.acceptance,
  }))) : undefined;
  const missing = plannedPairs - pairs.length;
  const correct = (side: PairSide) => calls.flatMap((call) => {
    if (!call.verdict) return [];
    return [(side === "baseline") === call.baselineFirst ? call.verdict.correctA : call.verdict.correctB];
  }).filter((value) => value === "yes").length;
  const judgedCalls = calls.filter((call) => call.verdict !== null).length;
  const stat = (side: "baseline" | "candidate", pick: (run: RunRecord) => number) => mean(pairs.map((pair) => pick(pair[side])));
  const percent = (fraction: number) => `${fraction >= 0 ? "+" : ""}${Math.round(fraction * 100)}%`;
  const lines = [
    `# Chat A/B: ${candidate.arm.id} against ${baseline.arm.id}`,
    "",
    `Judge: ${CHAT_AB_JUDGE.model} at ${CHAT_AB_JUDGE.effort} effort, both slot orders per pair. Pairs: ${pairs.length}. Judge spend: $${calls.reduce((total, call) => total + (call.usd ?? 0), 0).toFixed(2)}.`,
    ...(skippedTasks.length === 0 ? [] : [`Not paired, because the task changed between the campaigns: ${skippedTasks.join(", ")}.`]),
    "",
    decision
      ? `**Decision: ${decision.adopt ? "adopt" : "drop"}.** Rule: the candidate wins at least ${args.rule.minWinRatio}x as many pairs as the baseline, mean cost per cell rises at most ${Math.round(args.rule.maxCostIncrease * 100)}%, and no paired candidate breaks a frozen guard or loses a passing fix.${decision.reasons.length === 0 ? "" : ` Not met: ${decision.reasons.join("; ")}.`}${tally.unjudged > 0 || missing > 0 ? ` The decision is provisional: ${missing} planned pairs have no completed cell on both sides, and ${tally.unjudged} pairs are not judged yet.` : ""}`
      : `**Model comparison: ${candidate.chat.model} won ${tally.candidate}, ${baseline.chat.model} won ${tally.baseline}, ${tally.ties} ties.** With this few pairs the tally only breaks ties between the absolute scores of score.ts, so no adopt rule applies.${tally.unjudged > 0 || missing > 0 ? ` ${missing} planned pairs have no completed cell on both sides, and ${tally.unjudged} pairs are not judged yet.` : ""}`,
    "",
    "| Measure | Baseline | Candidate |",
    "|---|---:|---:|",
    `| Pairs won | ${tally.baseline} | ${tally.candidate} (${tally.ties} ties) |`,
    `| Judged fully correct (of ${judgedCalls} judgments) | ${correct("baseline")} | ${correct("candidate")} |`,
    `| Mean cost per cell (${priced.length} pairs priced on both sides) | $${cost("baseline").toFixed(2)} | $${cost("candidate").toFixed(2)} (${costIncrease === null ? "unknown" : percent(costIncrease)}) |`,
    `| Mean agent minutes | ${stat("baseline", (run) => run.agentMs / 60_000).toFixed(1)} | ${stat("candidate", (run) => run.agentMs / 60_000).toFixed(1)} |`,
    `| Mean files changed | ${stat("baseline", (run) => run.diffStats.filesTouched).toFixed(1)} | ${stat("candidate", (run) => run.diffStats.filesTouched).toFixed(1)} |`,
    `| Mean acceptance score | ${stat("baseline", (run) => scoreAcceptance(run.acceptance).score).toFixed(2)} | ${stat("candidate", (run) => scoreAcceptance(run.acceptance).score).toFixed(2)} |`,
    `| Resolved (every acceptance test passes) | ${pairs.filter((pair) => scoreAcceptance(pair.baseline.acceptance).resolved).length} | ${pairs.filter((pair) => scoreAcceptance(pair.candidate.acceptance).resolved).length} |`,
    `| Cells that broke a guard test | ${pairs.filter((pair) => scoreAcceptance(pair.baseline.acceptance).brokenGuards.length > 0).length} | ${pairs.filter((pair) => scoreAcceptance(pair.candidate.acceptance).brokenGuards.length > 0).length} |`,
    "",
    "## Pairs",
    "",
    ...rows.flatMap(({ pair, orders, outcome }) => [
      `### ${pair.candidate.task} r${pair.candidate.repeat}: ${outcome}`,
      "",
      ...orders.map((call, order) => call?.verdict
        ? `- Order ${order} (${call.baselineFirst ? "baseline" : "candidate"} in slot A): ${sideOf(call.verdict.winner, call.baselineFirst)}. ${call.verdict.rationale}`
        : `- Order ${order}: not judged.`),
      "",
    ]),
  ];
  return { markdown: `${lines.join("\n")}\n`, json: { baseline: args.baseline, candidate: args.candidate, differ: args.differ, judge: CHAT_AB_JUDGE, rule: args.rule, tally, plannedPairs, pricedPairs: priced.length, costIncrease, decision, pairs: rows.map(({ pair, outcome }) => ({ task: pair.candidate.task, repeat: pair.candidate.repeat, outcome })) } };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { isChatCampaign } = await import("./chat-store.js");
  const native = await Promise.all([isChatCampaign(args.baseline), isChatCampaign(args.candidate)]);
  if (native.some(Boolean)) {
    if (!native.every(Boolean)) throw new Error("Historical and headless Chat campaigns have different execution semantics; compare like campaigns");
    const { compareChatCampaigns } = await import("./chat-compare.js");
    console.log((await compareChatCampaigns(args)).markdown);
    return;
  }
  const baseline = await loadCampaign(args.baseline);
  const candidate = await loadCampaign(args.candidate);
  requireComparable(args.differ, baseline.config, candidate.config);
  const { shared, changed: skippedTasks } = pairedTasks([baseline.config, candidate.config]);
  const pairs: Pair[] = candidate.runs.flatMap((run) => {
    const match = baseline.runs.find((other) => other.task === run.task && other.repeat === run.repeat);
    return match && shared.includes(run.task) ? [{ baseline: match, candidate: run }] : [];
  });
  const plannedPairs = shared.length * Math.min(baseline.config.repeats, candidate.config.repeats);

  const dir = join(args.candidate, `compare-${basename(args.baseline)}-${CHAT_AB_JUDGE.model}`);
  const ledger = createJsonLinesLedger(async () => join(dir, "judge-calls.jsonl"), CallSchema, "reject");
  const calls = await ledger.load();
  const report = renderComparison(args, baseline.config, candidate.config, pairs, plannedPairs, calls, skippedTasks);
  console.log(report.markdown);
  console.log(`[compare] results: ${dir}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`chat-ab compare failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
