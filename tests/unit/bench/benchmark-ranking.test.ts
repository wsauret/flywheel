import { describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CampaignRecords, CellLine, GradeLine, RecordJudge, ScoreLine } from "../../../src/orchestration/modules/development/benchmark/records/benchmark-records.js";
import type { BenchmarkMode } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { rankBenchmarkRecords, renderRanking, type RankingCorpus, type RankingInput, type RoleRanking } from "../../../src/orchestration/modules/development/benchmark/records/ranking.js";
import { renderResultsPages, staleResultsPages, writeResultsPages } from "../../../src/orchestration/modules/development/benchmark/persona/results-pages.js";
import type { CheckGrade } from "../../../src/orchestration/modules/development/benchmark/implement-task/check-grade.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();

type FailureLine = CampaignRecords["failures"][number];

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
  /** An implementation cell's grade; all of one essential check passed by default. */
  grade?: CheckGrade;
  /** An implementation cell graded before the check tags: [passed, total] over every hidden test. */
  legacy?: readonly [number, number];
  taskIdentity?: string;
  /** The candidate identity an implementation cell answered; `<task>@candidate` by default. */
  candidateIdentity?: string;
  judges?: readonly RecordJudge[];
  version?: string;
  /** The time limit an implementation cell hit: it records no change and no score. */
  timedOutMs?: number;
}

function campaign(persona: string, mode: BenchmarkMode, specs: readonly CellSpec[], options: { stamp?: string; judge?: RecordJudge; guidance?: string; grades?: readonly GradeLine[]; failures?: readonly FailureLine[] } = {}): CampaignRecords {
  const cells: CellLine[] = [];
  const scores: ScoreLine[] = [];
  for (const spec of specs) {
    const [model, effort] = spec.setting.split("@");
    const repeat = spec.repeat ?? 0;
    const cost = spec.cost ?? 1;
    const estimatedUsd = typeof cost === "number" ? { kind: "observed" as const, value: cost } : { kind: "unavailable" as const, reason: "unpriced", ...cost };
    cells.push({
      kind: "cell", variant: spec.setting, ...(model === "profile" ? {} : { model, effort }), task: spec.task, taskIdentity: spec.taskIdentity ?? `${spec.task}@1`, repeat, durationMs: spec.timedOutMs ?? spec.ms ?? 10_000,
      accounting: { estimatedUsd, billedUsd: { kind: "observed", value: 0 }, tokens: { kind: "observed", value: 1 }, providers: { kind: "observed", value: ["p"] }, pricedEntryCount: 1, unpricedEntryCount: 0 },
      output: spec.timedOutMs !== undefined
        ? { kind: "timed-out", candidateIdentity: spec.candidateIdentity ?? `${spec.task}@candidate`, timeoutMs: spec.timedOutMs }
        : mode === "implement"
        ? { kind: "implementation", candidateIdentity: spec.candidateIdentity ?? `${spec.task}@candidate`, summary: "", diff: "", linesAdded: 1, linesRemoved: 0, filesTouched: 1,
          ...spec.legacy ? { acceptancePassed: spec.legacy[0], acceptanceFailed: spec.legacy[1] - spec.legacy[0], acceptanceTotal: spec.legacy[1] } : { grade: spec.grade ?? checks(1, 1) } }
        : { kind: mode === "reviewer" ? "review" : "answer", text: "" },
    });
    for (const judge of spec.timedOutMs === undefined ? spec.judges ?? [SOL] : []) {
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
    cells, scores, grades: options.grades ?? [], failures: options.failures ?? [],
  };
}

/** A check grade: `passed` of `total` essential checks, with broken existing tests and edge checks. */
function checks(passed: number, total: number, { broken = 0, edge = [0, 0] as const }: { broken?: number; edge?: readonly [number, number] } = {}): CheckGrade {
  return { essential: { passed, total }, broken, edge: { passed: edge[0], total: edge[1] } };
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

  it("ranks the implementer on its whole corpus by core quality minus followed false claims, with no pairwise input", () => {
    const tasks = corpus("implementer", "implement", [["x", 0], ["y", 0], ["z", 0]]);
    const [role] = rankBenchmarkRecords(input([campaign("implementer", "implement", [
      // Every essential check passes, but one broken existing test adds a failed check: 9 of 10.
      { setting: "gpt-mid@high", task: "x", grade: checks(9, 9, { broken: 1, edge: [2, 2] }), traps: 2, followed: 1 },
      { setting: "gpt-mid@high", task: "y", grade: checks(10, 10) },
      { setting: "gpt-mid@high", task: "z", grade: checks(4, 4, { edge: [3, 3] }) },
      // Failed edge checks never lower quality.
      { setting: "claude-mid@high", task: "x", grade: checks(9, 9, { edge: [0, 2] }), traps: 2 },
      { setting: "claude-mid@high", task: "y", grade: checks(10, 10) },
      { setting: "claude-mid@high", task: "z", grade: checks(4, 4, { edge: [0, 3] }) },
      // A setting missing a task of the corpus is incomplete.
      { setting: "gpt-cheap@high", task: "x" },
    ])], [tasks]));
    const ranking = ranked(role);
    // Each task weighs the same: x 90, y 100, z 100.
    expect(ranking.settings.map((setting) => [setting.setting, setting.quality.toFixed(3), setting.false, setting.score.toFixed(3)])).toEqual([
      ["claude-mid@high", "100.000", 0, "100.000"],
      ["gpt-mid@high", "96.667", 50, "46.667"],
    ]);
    expect(ranking.thresholds).toEqual({ quality: 90, false: 10 });
    expect(ranking.incomplete).toEqual([{ setting: "gpt-cheap@high", missing: ["implementer: 1 of 3 tasks"] }]);
    expect(ranking.notPooled).toEqual([]);
    expect(renderRanking([role!])).toContain("Corpora: implementer (3 tasks)");
  });

  it("ranks a timed-out implementer cell as a failed attempt at the limit, and lists other failed attempts to retry", () => {
    const tasks = corpus("implementer", "implement", [["x", 0], ["y", 0]]);
    const failure = (attemptId: string, task: string, repeat: number): FailureLine => ({ kind: "failure", attemptId, variant: "gpt-mid@high", task, repeat, reason: "Native grade failed: exit code 1" });
    const [role] = rankBenchmarkRecords(input([campaign("implementer", "implement", [
      // Each task weighs the same whatever its test count, and each cell the same within its task.
      { setting: "gpt-mid@high", task: "x", grade: checks(1, 1), ms: 1000 },
      { setting: "gpt-mid@high", task: "y", grade: checks(20, 20), ms: 1000 },
      { setting: "gpt-mid@high", task: "y", repeat: 1, timedOutMs: 5000, cost: 3 },
      { setting: "gpt-mid@high", task: "x", repeat: 2, grade: checks(0, 1), ms: 1000 },
    ], { failures: [failure("a1", "y", 2), failure("a2", "x", 2)] })], [tasks]));
    const ranking = ranked(role);
    // x averages 1 and 0, y averages 1 and the timed-out 0; the limit is the slowest cell's latency.
    expect(ranking.settings).toEqual([expect.objectContaining({ setting: "gpt-mid@high", quality: 50, false: 0, cost: 1.5, latencySeconds: 1, cells: 4, timedOutCells: 1 })]);
    // The failed attempt of x #2 has a later result, so only y #2 waits for a retry.
    expect(ranking.retry).toEqual([{ setting: "gpt-mid@high", task: "y", repeat: 2, persona: "implementer", stamp: "s1", reason: "Native grade failed: exit code 1" }]);
    const text = renderRanking([role!]);
    expect(text).toContain("| 4 (1 timed out) |");
    expect(text).toContain("- gpt-mid@high y #2 (implementer s1): Native grade failed: exit code 1");
  });

  it("pools an implementer cell under a changed grader only once the current grader regraded it and its prompt still matches", () => {
    const tasks: RankingCorpus = { persona: "implementer", mode: "implement", tasks: [{ id: "x", contentIdentity: "x@2", opportunities: 0, implementation: { candidateIdentity: "x@candidate", graderIdentity: "grader-2" } }] };
    const grade = (variant: string, graderIdentity: string): GradeLine => ({ kind: "grade", graderIdentity, variant, task: "x", repeat: 0, grade: checks(4, 5, { broken: 0, edge: [0, 4] }) });
    const records = campaign("implementer", "implement", [
      // Graded before the check tags: its counts decode, but only a regrade pools it.
      { setting: "gpt-mid@high", task: "x", legacy: [10, 10] },
      // A timed-out cell is a failed attempt under every grader, so it needs no regrade.
      { setting: "gpt-mid@high", task: "x", repeat: 1, timedOutMs: 1000 },
      { setting: "gpt-cheap@high", task: "x" },
      { setting: "claude-mid@high", task: "x", candidateIdentity: "x@old-prompt" },
      { setting: "claude-big@high", task: "x" },
    ], { grades: [grade("gpt-mid@high", "grader-2"), grade("claude-mid@high", "grader-2"), grade("claude-big@high", "grader-1")] });
    const ranking = ranked(rankBenchmarkRecords(input([records], [tasks]))[0]);
    // The regrade's 4 of 5 replaces the 10 of 10 that the cell recorded under the earlier grader; the timed-out cell scores 0.
    expect(ranking.settings.map((setting) => [setting.setting, setting.quality])).toEqual([["gpt-mid@high", 40]]);
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

describe("benchmark results pages", () => {
  const implementer: RankingCorpus = {
    persona: "implementer", mode: "implement",
    tasks: [
      { id: "easy", contentIdentity: "easy@1", opportunities: 0 },
      { id: "x", contentIdentity: "x@2", opportunities: 0, implementation: { candidateIdentity: "x@candidate", graderIdentity: "grader-2" } },
    ],
  };
  const records = campaign("implementer", "implement", [
    { setting: "gpt-mid@high", task: "x", grade: checks(3, 3, { edge: [1, 2] }), taskIdentity: "x@2" },
    { setting: "gpt-mid@high", task: "x", repeat: 1, grade: checks(1, 2, { broken: 1 }), taskIdentity: "x@2" },
    { setting: "gpt-mid@high", task: "x", repeat: 2, timedOutMs: 5000, taskIdentity: "x@2" },
    { setting: "gpt-mid@high", task: "easy", cost: { atLeast: 2 } },
    { setting: "claude-mid@high", task: "x", legacy: [0, 3] },
    { setting: "claude-mid@high", task: "x", repeat: 1, legacy: [0, 3] },
    { setting: "gpt-cheap@high", task: "easy" },
  ], {
    // Only the current grader's grade pools; an earlier grader's grade before the check tags still shows, marked.
    grades: [
      { kind: "grade", graderIdentity: "grader-1", variant: "claude-mid@high", task: "x", repeat: 0, passed: 2, failed: 1, total: 3 },
      { kind: "grade", graderIdentity: "grader-2", variant: "claude-mid@high", task: "x", repeat: 1, grade: checks(3, 3) },
    ],
    failures: [{ kind: "failure", attemptId: "a1", variant: "gpt-mid@high", task: "easy", repeat: 1, reason: "RESOURCE_EXHAUSTED (code 429):\n  quota" }],
  });

  it("shows every implementer cell by task and setting, with its core quality, edge checks, timeouts, totals, gaps, and cells to retry", () => {
    const page = renderResultsPages(input([records], [implementer])).get("implementer")!;
    expect(page).toContain("| Task | claude-mid@high | claude-mid@high edge | gpt-cheap@high | gpt-cheap@high edge | gpt-mid@high | gpt-mid@high edge |");
    expect(page).toContain("| easy | - | - | 1/1 | n/a | 1/1 | n/a |");
    // A broken existing test adds a failed check to quality: 1 of 2 essential checks with one broken shows 1/3.
    expect(page).toContain("| x | (2/3)* 3/3 | ?* n/a | - | - | 3/3 1/3 T | 1/2 n/a T |");
    // Cells, core quality %, edge %, timed out, failed attempts, a lower-bound cost, tokens, median latency, providers.
    expect(page).toContain("| gpt-mid@high | 4 | 58.3 | 50.0 | 1 | 1 | >= $5.000 (1 cell partly unpriced) | 4 | 10s | p |");
    expect(page).toContain("| claude-mid@high | 2 | 100.0 | n/a | 0 | 0 | $2.000 | 2 | 10s | p |");
    expect(page).toContain("- gpt-cheap@high: x");
    expect(page).toContain("- gpt-mid@high easy #1 (s1), 1 failed attempt: RESOURCE_EXHAUSTED (code 429): quota");
    expect(page).toContain("### Judged by judge-a:xhigh");
    expect(page).toContain("| s1 | claude-mid@high, gpt-cheap@high, gpt-mid@high | judge-a:xhigh | 7 | 6 | 2 | 1 | not recorded |");
  });

  it("shows a reviewer cell's measure under each judge that scored the persona, and ? where a judge has no score", () => {
    const page = renderResultsPages(input([campaign("reviewer-code-quality", "reviewer", [
      { setting: "gpt-mid@high", task: "a", caught: 1, judges: [SOL, OPUS] },
      { setting: "gpt-mid@high", task: "control", severe: 2 },
    ])], [QUALITY])).get("reviewer-code-quality")!;
    const [, solMatrix, opusMatrix] = page.split(/### Scored by /);
    expect(solMatrix).toStartWith("judge-a:xhigh");
    expect(solMatrix).toContain("| a | 1/2 |");
    expect(solMatrix).toContain("| control | 0/0+2 |");
    expect(opusMatrix).toContain("| control | ? |");
    expect(opusMatrix).toContain("| b | - |");
  });

  it("writes only missing or changed pages, and the check names each page that differs from its records", async () => {
    const root = directory("benchmark-results-pages-");
    const pages = renderResultsPages(input([records], [implementer]));
    const file = join(root, "implementer.md");
    expect(await staleResultsPages(root, pages)).toEqual([`${file} is missing`]);
    expect(await writeResultsPages(root, pages)).toEqual([file]);
    expect(await staleResultsPages(root, pages)).toEqual([]);
    expect(await writeResultsPages(root, pages)).toEqual([]);
    await writeFile(file, "hand-edited\n");
    expect(await staleResultsPages(root, pages)).toEqual([`${file} is stale`]);
  });
});
