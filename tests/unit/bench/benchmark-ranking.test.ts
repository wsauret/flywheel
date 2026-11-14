import { describe, expect, it } from "bun:test";
import type { CampaignRecords, CellLine, GradeLine, RecordJudge, ScoreLine } from "../../../src/orchestration/modules/development/benchmark/benchmark-records.js";
import type { BenchmarkMode } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { rankBenchmarkRecords, renderRanking, type RankingCorpus, type RankingInput, type RoleRanking } from "../../../src/orchestration/modules/development/benchmark/ranking.js";

const SOL: RecordJudge = { model: "judge-a", effort: "xhigh" };
const OPUS: RecordJudge = { model: "judge-b", effort: "xhigh" };
const TIERS = new Map<string, { family: "openai" | "anthropic"; tier: "cheap" | "mid" | "powerful" }>([
  ["gpt-cheap", { family: "openai", tier: "cheap" }],
  ["gpt-mid", { family: "openai", tier: "mid" }],
  ["claude-mid", { family: "anthropic", tier: "mid" }],
  ["claude-big", { family: "anthropic", tier: "powerful" }],
]);

/** One recorded cell, with its usual score by `judges`. */
interface CellSpec {
  setting: string;
  task: string;
  repeat?: number;
  cost?: number | { atLeast?: number };
  ms?: number;
  caught?: number;
  severe?: number;
  traps?: number;
  followed?: number;
  passed?: number;
  total?: number;
  taskIdentity?: string;
  /** The candidate identity an implementation cell answered; `<task>@candidate` by default. */
  candidateIdentity?: string;
  judges?: readonly RecordJudge[];
  version?: string;
}

function campaign(persona: string, mode: BenchmarkMode, specs: readonly CellSpec[], options: { stamp?: string; judge?: RecordJudge; guidance?: string; grades?: readonly GradeLine[] } = {}): CampaignRecords {
  const cells: CellLine[] = [];
  const scores: ScoreLine[] = [];
  for (const spec of specs) {
    const [model, effort] = spec.setting.split("@");
    const repeat = spec.repeat ?? 0;
    const cost = spec.cost ?? 1;
    const estimatedUsd = typeof cost === "number" ? { kind: "observed" as const, value: cost } : { kind: "unavailable" as const, reason: "unpriced", ...cost };
    cells.push({
      kind: "cell", variant: spec.setting, ...(model === "profile" ? {} : { model, effort }), task: spec.task, taskIdentity: spec.taskIdentity ?? `${spec.task}@1`, repeat, durationMs: spec.ms ?? 10_000,
      accounting: { estimatedUsd, billedUsd: { kind: "observed", value: 0 }, tokens: { kind: "observed", value: 1 }, providers: { kind: "observed", value: ["p"] }, pricedEntryCount: 1, unpricedEntryCount: 0 },
      output: mode === "implement"
        ? { kind: "implementation", candidateIdentity: spec.candidateIdentity ?? `${spec.task}@candidate`, summary: "", diff: "", linesAdded: 1, linesRemoved: 0, filesTouched: 1, acceptancePassed: spec.passed ?? 1, acceptanceFailed: (spec.total ?? 1) - (spec.passed ?? 1), acceptanceTotal: spec.total ?? 1 }
        : { kind: mode === "reviewer" ? "review" : "answer", text: "" },
    });
    for (const judge of spec.judges ?? [SOL]) {
      const base = { kind: "score" as const, judge, scoringVersion: spec.version ?? (mode === "reviewer" ? "v3" : "v2") };
      const id = { variant: spec.setting, task: spec.task, repeat };
      const caught = Array.from({ length: spec.caught ?? 0 }, (_, index) => `d${index}`);
      if (mode === "reviewer") scores.push({ ...base, scorer: "review", score: { ...id, caught, uncertain: [], unsupportedFindingCount: spec.severe ?? 0, unsupportedSevereFindingCount: spec.severe ?? 0 } });
      else if (mode === "research") scores.push({ ...base, scorer: "research", score: { ...id, caught, uncertain: [], trapsAsserted: spec.traps ? ["t"] : [], citations: { total: 0, invalid: [] } } });
      else scores.push({ ...base, scorer: "trap", score: { ...id, traps: Array.from({ length: spec.traps ?? 0 }, (_, index) => ({ id: `t${index}`, outcome: index < (spec.followed ?? 0) ? "followed-blindly" as const : "self-corrected" as const, rationale: "" })) } });
    }
  }
  const stamp = options.stamp ?? "s1";
  return {
    file: `${persona}/${stamp}.jsonl`,
    header: { kind: "campaign", version: 1, persona, mode, stamp, judge: options.judge ?? SOL, scoringVersion: mode === "reviewer" ? "v3" : "v2", personaGuidanceIdentity: options.guidance ?? "guidance" },
    cells, scores, grades: options.grades ?? [],
  };
}

/** A corpus of tasks given as [id, seeded defects or key facts], each at content `<id>@1`. */
function corpus(persona: string, mode: BenchmarkMode, tasks: readonly (readonly [string, number | undefined])[]): RankingCorpus {
  return { persona, mode, tasks: tasks.map(([id, opportunities]) => ({ id, contentIdentity: `${id}@1`, opportunities })) };
}

function input(campaigns: readonly CampaignRecords[], corpora: readonly RankingCorpus[], overrides: Partial<RankingInput> = {}): RankingInput {
  return {
    campaigns,
    roleOf: (persona) => persona.startsWith("reviewer-code-") || persona.startsWith("reviewer-plan-") ? `reviewer-${persona.split("-").at(-1)}` : persona,
    corpora: new Map(corpora.map((entry) => [entry.persona, entry])),
    scoringVersion: (mode) => mode === "reviewer" ? "v3" : "v2",
    classify: (model) => TIERS.get(model) ?? { family: undefined, tier: undefined },
    entryOf: (role) => role,
    ...overrides,
  };
}

function ranked(value: ReturnType<typeof rankBenchmarkRecords>[number] | undefined): RoleRanking {
  if (!value || !("settings" in value)) throw new Error("expected a ranked role");
  return value;
}

const QUALITY = corpus("reviewer-code-quality", "reviewer", [["a", 2], ["b", 2], ["control", 0]]);

/** Each setting reviews both defect fixtures and the control once. */
function qualityCells(setting: string, caught: number, severe: number, cost: number, ms: number): CellSpec[] {
  return [
    { setting, task: "a", caught, cost, ms },
    { setting, task: "b", caught, cost, ms },
    { setting, task: "control", severe, cost, ms },
  ];
}

describe("benchmark ranking", () => {
  it("filters, scores, picks each family, puts a family without a passing setting second, and derives the fallback", () => {
    const [role] = rankBenchmarkRecords(input([campaign("reviewer-code-quality", "reviewer", [
      ...qualityCells("gpt-mid@high", 2, 0, 1, 10_000),
      ...qualityCells("gpt-cheap@xhigh", 2, 3, 0.25, 10_000),
      ...qualityCells("gpt-mid@medium", 1, 0, 0.5, 5_000),
      ...qualityCells("claude-big@medium", 2, 6, 2, 10_000),
    ])], [QUALITY]));
    const ranking = ranked(role);
    // Best recall 100, so recall >= 90 passes; the lowest false rate is 0, so <= 0.6 per review passes.
    expect(ranking.thresholds).toEqual({ quality: 90, false: 0.6 });
    expect(Object.fromEntries(ranking.settings.map((setting) => [setting.setting, setting.filter]))).toEqual({
      "gpt-mid@high": "pass", "gpt-cheap@xhigh": "false", "gpt-mid@medium": "quality", "claude-big@medium": "false",
    });
    // One passing setting is both cheapest and fastest: its score is its recall.
    expect(ranking.settings.find((setting) => setting.setting === "gpt-mid@high")?.score).toBe(100);
    // 50 - 0 - 3 log2(0.5) - 3 log2(0.5) = 56; 100 - 5 x 1 - 3 log2(0.25) = 101.
    expect(ranking.settings.find((setting) => setting.setting === "gpt-mid@medium")?.score).toBe(56);
    expect(ranking.settings.find((setting) => setting.setting === "gpt-cheap@xhigh")?.score).toBe(101);
    expect(ranking.picks.map((pick) => [pick.family, pick.setting.setting, pick.passed])).toEqual([
      ["openai", "gpt-mid@high", true],
      ["anthropic", "claude-big@medium", false],
    ]);
    expect(ranking.fallback).toEqual({ tier: "mid", effort: "high" });
    expect(renderRanking([role!])).toContain("  2. anthropic claude-big medium (no setting of this family passes the filters)");
  });

  it("rounds the fallback tier toward cheaper and breaks an effort tie toward the higher effort", () => {
    const [role] = rankBenchmarkRecords(input([campaign("reviewer-code-quality", "reviewer", [
      ...qualityCells("gpt-mid@xhigh", 2, 0, 1, 1000),
      ...qualityCells("gpt-cheap@medium", 2, 0, 1, 1000),
      ...qualityCells("claude-big@high", 2, 0, 1, 1000),
    ])], [QUALITY]));
    // Tiers 2, 1, 3 average 2 (mid); efforts tie at one each, and xhigh is the highest.
    expect(ranked(role).fallback).toEqual({ tier: "mid", effort: "xhigh" });
    const [cheaper] = rankBenchmarkRecords(input([campaign("reviewer-code-quality", "reviewer", [
      ...qualityCells("gpt-mid@low", 2, 0, 1, 1000),
      ...qualityCells("gpt-cheap@low", 2, 0, 1, 1000),
    ])], [QUALITY]));
    // Tiers 2 and 1 average 1.5, which rounds down to cheap.
    expect(ranked(cheaper).fallback).toEqual({ tier: "cheap", effort: "low" });
  });

  it("counts false P1/P2 findings per reviewed cell, every repeat and every control included", () => {
    // blend2.py divided the findings of two repeats by one row per fixture, and skipped control findings.
    const cells: CellSpec[] = [0, 1].flatMap((repeat) => [
      { setting: "gpt-mid@medium", task: "a", repeat, caught: 2, severe: 1 },
      { setting: "gpt-mid@medium", task: "b", repeat, caught: 2, severe: 0 },
      { setting: "gpt-mid@medium", task: "control", repeat, severe: 2 },
    ]);
    const [role] = rankBenchmarkRecords(input([campaign("reviewer-code-quality", "reviewer", cells)], [QUALITY]));
    // Six findings over six reviews.
    expect(ranked(role).settings[0]).toMatchObject({ quality: 100, false: 1, cells: 6 });
  });

  it("averages the corpora of one role with equal weight and lists settings that do not cover every task", () => {
    const code = corpus("reviewer-code-elegance", "reviewer", [["a", 1], ["b", 1], ["c", 1], ["d", 1]]);
    const plan = corpus("reviewer-plan-elegance", "reviewer", [["p", 1]]);
    const [role] = rankBenchmarkRecords(input([
      campaign("reviewer-code-elegance", "reviewer", ["a", "b", "c", "d"].flatMap((task) => [
        { setting: "gpt-mid@medium", task, caught: 1, cost: 1, ms: 1000 },
        { setting: "claude-mid@medium", task, caught: 1 },
      ])),
      campaign("reviewer-plan-elegance", "reviewer", [{ setting: "gpt-mid@medium", task: "p", caught: 0, cost: 3, ms: 3000 }]),
    ], [code, plan]));
    const ranking = ranked(role);
    // Four code cells at 100% and one plan cell at 0% average 50%, not 80%.
    expect(ranking.settings).toEqual([expect.objectContaining({ setting: "gpt-mid@medium", quality: 50, cost: 2, latencySeconds: 2, cells: 5 })]);
    expect(ranking.incomplete).toEqual([{ setting: "claude-mid@medium", missing: ["reviewer-plan-elegance: 0 of 1 tasks"] }]);
  });

  it("ranks the implementer on hidden-test pass rate minus followed false claims, with no pairwise input", () => {
    const tasks = corpus("implementer", "implement", [["x", 0], ["y", 0]]);
    const [role] = rankBenchmarkRecords(input([campaign("implementer", "implement", [
      { setting: "gpt-mid@high", task: "x", passed: 9, total: 10, traps: 2, followed: 1 },
      { setting: "gpt-mid@high", task: "y", passed: 10, total: 10 },
      { setting: "claude-mid@high", task: "x", passed: 10, total: 10, traps: 2 },
      { setting: "claude-mid@high", task: "y", passed: 10, total: 10 },
    ])], [tasks]));
    const ranking = ranked(role);
    expect(ranking.settings.map((setting) => [setting.setting, setting.quality, setting.false, setting.score])).toEqual([
      ["claude-mid@high", 100, 0, 100],
      ["gpt-mid@high", 95, 50, 45],
    ]);
    expect(ranking.thresholds).toEqual({ quality: 90, false: 10 });
  });

  it("pools an implementer cell under a changed grader only once the current grader regraded it and its prompt still matches", () => {
    const tasks: RankingCorpus = { persona: "implementer", mode: "implement", tasks: [{ id: "x", contentIdentity: "x@2", opportunities: 0, implementation: { candidateIdentity: "x@candidate", graderIdentity: "grader-2" } }] };
    const grade = (variant: string, graderIdentity: string): GradeLine => ({ kind: "grade", graderIdentity, variant, task: "x", repeat: 0, passed: 8, failed: 2, total: 10 });
    const records = campaign("implementer", "implement", [
      { setting: "gpt-mid@high", task: "x", passed: 1, total: 10 },
      { setting: "gpt-cheap@high", task: "x" },
      { setting: "claude-mid@high", task: "x", candidateIdentity: "x@old-prompt" },
      { setting: "claude-big@high", task: "x" },
    ], { grades: [grade("gpt-mid@high", "grader-2"), grade("claude-mid@high", "grader-2"), grade("claude-big@high", "grader-1")] });
    const ranking = ranked(rankBenchmarkRecords(input([records], [tasks]))[0]);
    // The regrade replaces the 1 of 10 that the cell recorded under the earlier grader.
    expect(ranking.settings.map((setting) => [setting.setting, setting.quality])).toEqual([["gpt-mid@high", 80]]);
    expect(ranking.notPooled.map(({ reason, cells }) => ({ reason, cells }))).toEqual([
      { reason: "task grader changed (--regrade grades it with the current grader)", cells: 2 },
      { reason: "task content changed", cells: 1 },
    ]);
  });

  it("reports every cell it does not pool with its reason, and the rejudge command for an unscored cell", () => {
    const research = corpus("explorer", "research", [["kept", 2], ["open", undefined]]);
    const records = campaign("explorer", "research", [
      { setting: "gpt-mid@low", task: "kept", caught: 2 },
      { setting: "gpt-mid@low", task: "kept", repeat: 1, taskIdentity: "kept@0" },
      { setting: "gpt-mid@low", task: "gone" },
      { setting: "gpt-mid@low", task: "open" },
      { setting: "gpt-mid@low", task: "kept", repeat: 2, judges: [OPUS] },
      { setting: "gpt-mid@low", task: "kept", repeat: 3, version: "v1" },
      { setting: "profile", task: "kept" },
    ]);
    const ranking = ranked(rankBenchmarkRecords(input([records], [research]))[0]);
    expect(ranking.notPooled.map(({ reason, cells, command }) => ({ reason, cells, ...(command ? { command } : {}) }))).toEqual([
      { reason: "task content changed", cells: 1 },
      { reason: "task removed from corpus", cells: 1 },
      { reason: "task has no answer key", cells: 1 },
      { reason: "not scored by judge-a:xhigh", cells: 1, command: "bun bench/ab-persona/bench.ts --rejudge explorer --judge judge-a:xhigh" },
      { reason: "scored under v1", cells: 1, command: "bun bench/ab-persona/bench.ts --rejudge explorer --judge judge-a:xhigh" },
      { reason: "no pinned model", cells: 1 },
    ]);
    expect(ranking.settings).toEqual([expect.objectContaining({ setting: "gpt-mid@low", quality: 100, cells: 1 })]);
    // Under a judge that scored no current cell, the role still reports what it left out.
    const [unpooled] = rankBenchmarkRecords(input([records], [research], { judge: { model: "judge-c", effort: "high" } }));
    expect(renderRanking([unpooled!])).toContain("No recorded cell of this role can be pooled under judge-c:high.");
    // A role that no judge scored still renders beside the ranked roles, with its campaigns' own judge in the commands.
    const unscored = campaign("implementer", "implement", [{ setting: "gpt-mid@high", task: "x", judges: [] }], { judge: OPUS });
    const implementer = corpus("implementer", "implement", [["x", 0]]);
    const [scored, open] = rankBenchmarkRecords(input([records, unscored], [research, implementer]));
    expect(ranked(scored).role).toBe("explorer");
    expect(open).toEqual({ role: "implementer", judge: undefined, notPooled: [{ persona: "implementer", stamp: "s1", reason: "not scored by judge-b:xhigh", cells: 1, command: "bun bench/ab-persona/bench.ts --rejudge implementer --judge judge-b:xhigh" }] });
    expect(renderRanking([open!])).toContain("No judge has scored a current cell of this role");
  });

  it("scores a lower-bound cost as its bound and leaves a setting with no stated cost unranked", () => {
    const [role] = rankBenchmarkRecords(input([campaign("reviewer-code-quality", "reviewer", [
      ...qualityCells("gpt-mid@high", 2, 0, 1, 1000).map((spec, index) => index === 0 ? { ...spec, cost: { atLeast: 1 } } : spec),
      ...qualityCells("claude-mid@high", 2, 0, 1, 1000).map((spec, index) => index === 0 ? { ...spec, cost: {} } : spec),
    ])], [QUALITY]));
    const ranking = ranked(role);
    expect(ranking.settings).toEqual([expect.objectContaining({ setting: "gpt-mid@high", cost: 1, costLowerBound: true, partlyUnpricedCells: 1 })]);
    expect(ranking.notRanked).toEqual([{ setting: "claude-mid@high", reason: "cost unavailable" }]);
    expect(renderRanking([role!])).toContain(">= $1.000 (1 of 3 cells partly unpriced)");
  });

  it("defaults to the judge of the most current cells, then the campaigns' own judge, and asks for --judge on a full tie", () => {
    const both = [SOL, OPUS];
    const more = campaign("reviewer-code-quality", "reviewer", [...qualityCells("gpt-mid@high", 2, 0, 1, 1000).map((spec) => ({ ...spec, judges: both })), { setting: "gpt-mid@high", task: "a", repeat: 1, judges: [OPUS] }]);
    expect(ranked(rankBenchmarkRecords(input([more], [QUALITY]))[0]).judge).toEqual(OPUS);
    const rejudged = campaign("reviewer-code-quality", "reviewer", qualityCells("gpt-mid@high", 2, 0, 1, 1000).map((spec) => ({ ...spec, judges: both })), { judge: OPUS });
    expect(ranked(rankBenchmarkRecords(input([rejudged], [QUALITY]))[0]).judge).toEqual(OPUS);
    const other = campaign("reviewer-code-quality", "reviewer", qualityCells("gpt-cheap@high", 2, 0, 1, 1000).map((spec) => ({ ...spec, judges: both })), { stamp: "s2", judge: SOL });
    expect(() => rankBenchmarkRecords(input([rejudged, other], [QUALITY]))).toThrow("name one with --judge");
    expect(ranked(rankBenchmarkRecords(input([rejudged, other], [QUALITY], { judge: SOL }))[0]).judge).toEqual(SOL);
  });
});
