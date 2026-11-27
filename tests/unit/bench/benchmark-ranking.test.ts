import { describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendCampaignRecords, type CampaignRecords, type CellLine, type GradeLine, type RecordJudge, type ScoreLine } from "../../../src/orchestration/modules/development/benchmark/records/benchmark-records.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/scoring/judge.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";
import { createBenchmarkCatalog, type BenchmarkMode, type TaskTier } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { rankBenchmarkRecords, renderRanking, type RoleRanking } from "../../../src/orchestration/modules/development/benchmark/records/ranking.js";
import type { RankingCorpus, RankingInput } from "../../../src/orchestration/modules/development/benchmark/records/ranking-pool.js";
import { committableTier, taskTierRule, tierAuditProblems } from "../../../src/orchestration/modules/development/benchmark/records/task-tiers.js";
import { loadRankingInput, renderResultsPages, staleResultsPages, writeResultsPages } from "../../../src/orchestration/modules/development/benchmark/persona/results-pages.js";
import type { CheckGrade } from "../../../src/orchestration/modules/development/benchmark/implement-task/check-grade.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();

type FailureLine = CampaignRecords["failures"][number];

const QUALITY_VERSION = "quality-1";
const NOT_CALIBRATED = { passed: false, summary: "no control results" };
const CALIBRATED = { passed: true, summary: "seeded controls 13 of 13 found" };
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
  /** The severities of the findings that each of `judges` reports in an implementation cell's diff; no judged-quality
   *  score when absent. */
  findings?: readonly ("major" | "minor")[];
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
      if (spec.findings) {
        const findings = spec.findings.map((severity, line) => ({ kind: "needless-code" as const, severity, file: "f.ts", line: line + 1, claim: "", evidence: "" }));
        scores.push({ kind: "score", judge, scoringVersion: QUALITY_VERSION, scorer: "quality", score: { ...id, findings, scopeOk: true, discarded: 0 } });
      }
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

/** A corpus of tasks given as [id, seeded defects or key facts, tier], each at content `<id>@1`. An implementer task
 *  is ranked unless it names another tier. */
function corpus(persona: string, mode: BenchmarkMode, tasks: readonly (readonly [string, number | undefined, TaskTier?])[]): RankingCorpus {
  return { persona, mode, tasks: tasks.map(([id, opportunities, tier]) => ({ id, contentIdentity: `${id}@1`, opportunities, ...(mode === "implement" ? { tier: tier ?? "ranked" } : {}) })) };
}

function input(campaigns: readonly CampaignRecords[], corpora: readonly RankingCorpus[], overrides: Partial<RankingInput> = {}): RankingInput {
  return {
    campaigns,
    roleOf: (persona) => persona.startsWith("reviewer-code-") || persona.startsWith("reviewer-plan-") ? `reviewer-${persona.split("-").at(-1)}` : persona,
    corpora: new Map(corpora.map((entry) => [entry.persona, entry])),
    scoringVersion: (mode) => mode === "reviewer" ? "v3" : "v2",
    qualityScoringVersion: QUALITY_VERSION,
    qualityCalibration: () => NOT_CALIBRATED,
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
    expect(renderRanking([role!])).toContain("Corpora: implementer (3 tasks: 3 ranked, 0 floor)");
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

  it("sets implementer quality, cost, and latency from ranked tasks, and deducts each floor task's failed checks", () => {
    const tasks = corpus("implementer", "implement", [["r1", 0], ["r2", 0], ["f", 0, "floor"]]);
    const [role] = rankBenchmarkRecords(input([campaign("implementer", "implement", [
      { setting: "gpt-mid@high", task: "r1", grade: checks(1, 1), cost: 1, ms: 1000 },
      { setting: "gpt-mid@high", task: "r2", grade: checks(1, 2), cost: 3, ms: 3000 },
      // 1 of 2 essential checks with 2 broken existing tests fails 3 of 4; the timed-out repeat fails every check.
      { setting: "gpt-mid@high", task: "f", grade: checks(1, 2, { broken: 2 }), cost: 100, ms: 100_000 },
      { setting: "gpt-mid@high", task: "f", repeat: 1, timedOutMs: 200_000, cost: 100 },
    ])], [tasks]));
    // Ranked (100 + 50) / 2 = 75, less the floor task's mean failed share (0.75 + 1) / 2 over 2 ranked tasks: 43.75.
    expect(ranked(role).settings).toEqual([expect.objectContaining({ quality: 31.25, cost: 2, latencySeconds: 2, cells: 4, timedOutCells: 1 })]);
    expect(renderRanking([role!])).toContain("Corpora: implementer (3 tasks: 2 ranked, 1 floor)");
  });

  it("adds judged quality to implementer quality with equal weight only under a passing calibration, and resamples the mean", () => {
    const tasks = corpus("implementer", "implement", [["r", 0], ["f", 0, "floor"]]);
    const records = campaign("implementer", "implement", [
      // Test quality 50; judged (100 - 15 - 5 + 100) / 2 = 90 on r, and 70 on f, so judged quality is 80.
      { setting: "gpt-mid@high", task: "r", grade: checks(1, 2), findings: ["major", "minor"] },
      { setting: "gpt-mid@high", task: "r", repeat: 1, grade: checks(1, 2), findings: [] },
      { setting: "gpt-mid@high", task: "f", grade: checks(1, 1), findings: ["major", "major"] },
      // Test quality 100, judged quality 50: a timed-out cell scores 0 on both.
      { setting: "claude-mid@high", task: "r", grade: checks(2, 2), findings: [] },
      { setting: "claude-mid@high", task: "r", repeat: 1, timedOutMs: 1000 },
      { setting: "claude-mid@high", task: "f", grade: checks(1, 1), findings: [] },
    ]);
    const uncalibrated = ranked(rankBenchmarkRecords(input([records], [tasks]))[0]);
    expect(uncalibrated.settings.map(({ setting, quality, testQuality, judgedQuality }) => [setting, quality, testQuality, judgedQuality])).toEqual([
      ["claude-mid@high", 50, 50, 75],
      ["gpt-mid@high", 50, 50, 80],
    ]);
    expect(renderRanking([uncalibrated])).toContain("Quality is test quality alone, and judged quality is reported beside it, because the calibration of judge-a:xhigh does not pass: no control results.");
    const calibrated = ranked(rankBenchmarkRecords(input([records], [tasks], { qualityCalibration: () => CALIBRATED }))[0]);
    const gpt = calibrated.settings.find(({ setting }) => setting === "gpt-mid@high");
    expect(calibrated.settings.map(({ setting, quality }) => [setting, quality]).sort()).toEqual([["claude-mid@high", 62.5], ["gpt-mid@high", 65]]);
    // Each resample scores the mean again: drawing gpt-mid@high's repeat 0 twice gives (50 + 75) / 2, and repeat 1
    // twice gives (50 + 85) / 2, so its interval leaves the point estimate.
    expect(gpt?.qualityInterval).toEqual({ low: 62.5, high: 67.5 });
    expect(renderRanking([calibrated])).toContain("Quality is the equal-weight mean of test quality and judged quality, because the calibration of judge-a:xhigh passes: seeded controls 13 of 13 found.");
    // Under a passing calibration, a setting with a change that the judge has not scored waits for a rejudge.
    const unjudged = campaign("implementer", "implement", [{ setting: "gpt-cheap@high", task: "r" }, { setting: "gpt-cheap@high", task: "f", findings: [] }], { stamp: "s2" });
    const partial = ranked(rankBenchmarkRecords(input([records, unjudged], [tasks], { qualityCalibration: () => CALIBRATED }))[0]);
    expect(partial.notRanked).toEqual([{ setting: "gpt-cheap@high", reason: "1 pooled changes have no judged-quality score by judge-a:xhigh, which a rejudge by that judge adds" }]);
    // Floor deductions take test quality to -100 here, but the mean reads it clamped to 0, so quality and its interval
    // stay on the 0 to 100 scale; the test-only quality keeps its full range.
    const sevenMajors = Array.from({ length: 7 }, () => "major" as const);
    const failing = campaign("implementer", "implement", [
      { setting: "gpt-cheap@high", task: "r", grade: checks(0, 2), findings: sevenMajors },
      { setting: "gpt-cheap@high", task: "r", repeat: 1, grade: checks(0, 2), findings: sevenMajors },
      { setting: "gpt-cheap@high", task: "f", grade: checks(0, 1), findings: sevenMajors },
    ], { stamp: "s3" });
    const floored = ranked(rankBenchmarkRecords(input([records, failing], [tasks], { qualityCalibration: () => CALIBRATED }))[0]).settings.find(({ setting }) => setting === "gpt-cheap@high");
    expect(floored).toMatchObject({ quality: 0, testQuality: -100, judgedQuality: 0, qualityInterval: { low: 0, high: 0 } });
    expect(ranked(rankBenchmarkRecords(input([records, failing], [tasks]))[0]).settings.find(({ setting }) => setting === "gpt-cheap@high")?.quality).toBe(-100);
  });

  it("decides a task's tier from its mean core quality and the spread of setting means over the noise of repeats", () => {
    // Above the band: floor, whatever its spread.
    expect(taskTierRule([[1, 1], [1, 0.9]]).rule).toBe("floor");
    // Both band bounds are inside the band.
    expect(taskTierRule([[0.8, 0.8], [1, 1]])).toMatchObject({ mean: 0.9, rule: "ranked" });
    expect(taskTierRule([[0.1, 0.1], [0.2, 0.2]]).rule).toBe("ranked");
    expect(taskTierRule([[0.1, 0.1], [0.1, 0.1]]).rule).toBe("drop");
    // Each setting mean has noise 0.02 / 2 = 0.01: a between-setting variance of 0.02 is exactly twice it.
    const atBound = taskTierRule([[0.4, 0.6], [0.6, 0.8]]);
    expect(atBound.noise).toBeCloseTo(0.01, 12);
    expect(atBound.between).toBeCloseTo(0.02, 12);
    expect(atBound.rule).toBe("ranked");
    expect(taskTierRule([[0.4, 0.6], [0.58, 0.78]]).rule).toBe("drop");
    // One setting, or no repeats to measure noise, cannot show that the task separates settings.
    expect(taskTierRule([[0.2, 0.8]]).rule).toBe("drop");
    expect(taskTierRule([[0.2], [0.8]]).rule).toBe("drop");
    expect(taskTierRule([]).rule).toBe("drop");
  });

  it("lets a task rank only with an audit that records each separating failure as behavioral", () => {
    const failure = (verdict: "behavioral" | "unstated-interface" | "harness-fault" | "unresolved") => ({ failure: "check x", verdict, evidence: "e" });
    const audit = (failures: ReturnType<typeof failure>[]) => ({ auditor: "a", date: "2026-11-27", failures });
    expect(tierAuditProblems(new Map([
      ["floor-task", { tier: "floor" as const }],
      ["good", { tier: "ranked" as const, audit: audit([failure("behavioral")]) }],
      ["none", { tier: "ranked" as const }],
      ["empty", { tier: "ranked" as const, audit: audit([]) }],
      ["fault", { tier: "ranked" as const, audit: audit([failure("behavioral"), failure("harness-fault"), failure("unstated-interface")]) }],
      ["open", { tier: "ranked" as const, audit: audit([failure("unresolved")]) }],
      // A floor task may keep an audit that does not hold.
      ["parked", { tier: "floor" as const, audit: audit([failure("unresolved")]) }],
    ]))).toEqual([
      "- empty: its audit records no failure that separates settings",
      '- fault: its audit records "check x" as harness-fault, not behavioral',
      '- fault: its audit records "check x" as unstated-interface, not behavioral',
      "- none: ranked with no audit of the failures that separate settings",
      '- open: its audit records "check x" as unresolved, not behavioral',
    ]);
    // The tier to commit: a task that the rule ranks stays floor until its audit holds.
    expect(committableTier("t", "ranked", audit([failure("behavioral")]))).toBe("ranked");
    expect(committableTier("t", "ranked", audit([failure("unresolved")]))).toBe("floor");
    expect(committableTier("t", "ranked", undefined)).toBe("floor");
    expect(committableTier("t", "drop", audit([failure("behavioral")]))).toBe("floor");
  });

  it("refuses to rank from committed tiers that rank a task without an audit that holds, or with a blank audit", async () => {
    const root = directory("benchmark-ranking-tiers-");
    const plan = join(root, "bench", "tasks", "implement", "plan-task");
    await mkdir(join(plan, "project"), { recursive: true });
    await mkdir(join(plan, "acceptance"), { recursive: true });
    await writeFile(join(plan, "task.json"), JSON.stringify({ id: "plan-task", stratum: "small" }));
    await writeFile(join(plan, "manifest.json"), JSON.stringify({ traps: [], judgment: [] }));
    await writeFile(join(plan, "plan.json"), JSON.stringify(MINIMAL_IMPLEMENTATION_PLAN));
    await writeFile(join(plan, "project", "value.py"), "value = 1\n");
    await writeFile(join(plan, "acceptance", "value.test.ts"), "// hidden acceptance test\n");
    await writeFile(join(plan, "checks.json"), JSON.stringify({ "acceptance/value.test.ts > fixes": "core" }));
    const catalog = createBenchmarkCatalog(root);
    await mkdir(catalog.qualityCalibrationDir, { recursive: true });
    await writeFile(join(catalog.qualityCalibrationDir, "controls.json"), JSON.stringify({ controls: [] }));
    await writeFile(join(catalog.qualityCalibrationDir, "reviewer-labels.json"), JSON.stringify({ cells: [] }));
    const [task] = await catalog.implementTasks();
    await appendCampaignRecords(catalog.recordsFile("implementer", "s1"), { kind: "campaign", version: 1, persona: "implementer", mode: "implement", stamp: "s1", judge: SOL, scoringVersion: "v", personaGuidanceIdentity: "g" }, {
      cells: [{ kind: "cell", variant: "m@high", model: "m", effort: "high", task: "plan-task", taskIdentity: task!.contentIdentity, repeat: 0, durationMs: 1, accounting: unavailableJudgeAccounting("synthetic"), output: { kind: "timed-out", candidateIdentity: task!.candidateIdentity, timeoutMs: 1 } }],
    });
    // The committed shape as a person writes it, before decoding, so a blank field can reach the decoder.
    interface TiersEntry { readonly tier: string; readonly audit?: { readonly auditor: string; readonly date: string; readonly failures: readonly { readonly failure: string; readonly verdict: string; readonly evidence: string }[] } }
    const tiers = (entry: TiersEntry) => writeFile(catalog.implementTiersFile, JSON.stringify({ "plan-task": entry }));
    const failure = { failure: "check x", verdict: "behavioral", evidence: "e" };
    const audit = { auditor: "a", date: "2026-11-27", failures: [failure] };
    await tiers({ tier: "ranked" });
    await expect(loadRankingInput(catalog)).rejects.toThrow("- plan-task: ranked with no audit of the failures that separate settings");
    await tiers({ tier: "ranked", audit: { ...audit, failures: [{ ...failure, verdict: "unresolved" }] } });
    await expect(loadRankingInput(catalog)).rejects.toThrow('- plan-task: its audit records "check x" as unresolved, not behavioral');
    for (const blank of [{ ...audit, auditor: " " }, { ...audit, date: "" }, { ...audit, failures: [{ ...failure, evidence: "" }] }]) {
      await tiers({ tier: "ranked", audit: blank });
      await expect(loadRankingInput(catalog)).rejects.toThrow("must map each implementer task id to its tier");
    }
    await tiers({ tier: "ranked", audit });
    expect((await loadRankingInput(catalog)).corpora.get("implementer")?.tasks.map(({ tier }) => tier)).toEqual(["ranked"]);
  });

  it("states seeded 90% intervals and beats-next shares, and names the top scorer only on a quality lead that holds", () => {
    const tasks = corpus("implementer", "implement", [["a", 0], ["b", 0], ["c", 0]]);
    const cells = (setting: string, quality: (task: string) => number, cost: number) => ["a", "b", "c"].flatMap((task) => [0, 1].map((repeat): CellSpec => ({ setting, task, repeat, grade: checks(Math.round(20 * quality(task)), 20), cost, ms: 1000 })));
    const records = campaign("implementer", "implement", [
      ...cells("gpt-mid@high", () => 1, 1),
      // Quality 95 only from task a; four times cheaper, so it outscores the 100 of gpt-mid@high by 1 point.
      ...cells("claude-mid@high", (task) => task === "a" ? 0.85 : 1, 0.25),
      ...cells("claude-big@high", () => 0.9, 0.25),
    ]);
    const ranking = ranked(rankBenchmarkRecords(input([records], [tasks]))[0]);
    expect(rankBenchmarkRecords(input([records], [tasks]))).toEqual([ranking]);
    expect(ranking.settings.map((setting) => [setting.setting, setting.score.toFixed(6)])).toEqual([["claude-mid@high", "95.000000"], ["gpt-mid@high", "94.000000"], ["claude-big@high", "90.000000"]]);
    const [claudeMid, gptMid, claudeBig] = ranking.settings;
    expect(gptMid?.qualityInterval).toEqual({ low: 100, high: 100 });
    // Task a enters a resample of three tasks three times with probability 1/27, below 5%: the low bound is 90.
    expect(claudeMid?.qualityInterval).toEqual({ low: 90, high: 100 });
    // claude-mid@high outscores 94 when task a enters at most once: 20/27 of resamples.
    expect(claudeMid?.beatsNext).toBeGreaterThan(0.65);
    expect(claudeMid?.beatsNext).toBeLessThan(0.83);
    expect(claudeBig?.beatsNext).toBeUndefined();
    // No quality lead of the top scorer holds; gpt-mid@high leads on quality, and it beats claude-big@high in every
    // resample but claude-mid@high only when task a enters (19/27 < 90%), so the two tie and the better scorer is named.
    expect(ranking.named).toEqual({ kind: "tied", setting: "claude-mid@high", leader: "gpt-mid@high", tied: ["claude-mid@high", "gpt-mid@high"] });
    expect(renderRanking([ranking])).toContain("  named: anthropic claude-mid high (no quality lead holds in 90% of resamples; the top scorer of the settings that gpt-mid@high does not outscore on quality in 90% of resamples: claude-mid@high, gpt-mid@high)");

    const lead = campaign("implementer", "implement", [...cells("gpt-mid@high", () => 1, 1), ...cells("claude-mid@high", () => 0.95, 1)]);
    const leading = ranked(rankBenchmarkRecords(input([lead], [tasks]))[0]);
    expect(leading.named).toEqual({ kind: "lead", setting: "gpt-mid@high", share: 1 });
    const text = renderRanking([leading]);
    expect(text).toContain("  named: openai gpt-mid high (its quality exceeds every other passing setting's in 100% of resamples)");
    expect(text).toContain("| gpt-mid@high | openai | mid | 100.0 | 100.0 to 100.0 | 100.0 | n/a | 0.00 | $1.000 | 1s | 100.0 | 100.0 to 100.0 | 100% | pass | 6 |");
  });

  it("pools an implementer cell under a changed grader only once the current grader regraded it and its prompt still matches", () => {
    const tasks: RankingCorpus = { persona: "implementer", mode: "implement", tasks: [{ id: "x", contentIdentity: "x@2", opportunities: 0, tier: "ranked", implementation: { candidateIdentity: "x@candidate", graderIdentity: "grader-2" } }] };
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

  it("scores a lower-bound cost as its bound and leaves a setting with no stated cost or a zero bound unranked", () => {
    const [role] = rankBenchmarkRecords(input([campaign("reviewer-code-quality", "reviewer", [
      ...qualityCells("gpt-mid@high", 2, 0, 1, 1000).map((spec, index) => index === 0 ? { ...spec, cost: { atLeast: 1 } } : spec),
      ...qualityCells("claude-mid@high", 2, 0, 1, 1000).map((spec, index) => index === 0 ? { ...spec, cost: {} } : spec),
      // A bound of 0 states no amount, as when no attempt of the cell has a price.
      ...qualityCells("gemini-mid@high", 2, 0, 1, 1000).map((spec, index) => index === 0 ? { ...spec, cost: { atLeast: 0 } } : spec),
    ])], [QUALITY]));
    const ranking = ranked(role);
    expect(ranking.settings).toEqual([expect.objectContaining({ setting: "gpt-mid@high", cost: 1, costLowerBound: true, partlyUnpricedCells: 1 })]);
    expect(ranking.notRanked).toEqual([{ setting: "claude-mid@high", reason: "cost unavailable" }, { setting: "gemini-mid@high", reason: "cost unavailable" }]);
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
      { id: "easy", contentIdentity: "easy@1", opportunities: 0, tier: "floor" },
      { id: "x", contentIdentity: "x@2", opportunities: 0, tier: "ranked", implementation: { candidateIdentity: "x@candidate", graderIdentity: "grader-2" } },
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
    expect(page).toContain("| Task | Tier | claude-mid@high | claude-mid@high edge | gpt-cheap@high | gpt-cheap@high edge | gpt-mid@high | gpt-mid@high edge |");
    expect(page).toContain("| easy | floor | - | - | 1/1 | n/a | 1/1 | n/a |");
    // A broken existing test adds a failed check to quality: 1 of 2 essential checks with one broken shows 1/3.
    expect(page).toContain("| x | ranked | (2/3)* 3/3 | ?* n/a | - | - | 3/3 1/3 T | 1/2 n/a T |");
    // Cells, core quality %, edge %, timed out, failed attempts, a lower-bound cost, tokens, median latency, providers.
    expect(page).toContain("| gpt-mid@high | 4 | 58.3 | 50.0 | 1 | 1 | >= $5.000 (1 cell partly unpriced) | 4 | 10s | p |");
    expect(page).toContain("| claude-mid@high | 2 | 100.0 | n/a | 0 | 0 | $2.000 | 2 | 10s | p |");
    expect(page).toContain("- gpt-cheap@high: x");
    expect(page).toContain("- gpt-mid@high easy #1 (s1), 1 failed attempt: RESOURCE_EXHAUSTED (code 429): quota");
    expect(page).toContain("### Judged by judge-a:xhigh");
    expect(page).toContain("| s1 | claude-mid@high, gpt-cheap@high, gpt-mid@high | judge-a:xhigh | 7 | 6 | 2 | 1 | not recorded |");
  });

  it("shows each judge's judged quality per setting and the rank agreement of the two judges with the most scores", () => {
    const tasks = corpus("implementer", "implement", [["r", 0]]);
    const both = [SOL, OPUS];
    const judged = campaign("implementer", "implement", [
      { setting: "gpt-mid@high", task: "r", judges: both, findings: [] },
      { setting: "gpt-mid@high", task: "r", repeat: 1, judges: both, findings: ["minor"] },
      { setting: "claude-mid@high", task: "r", judges: both, findings: ["major"] },
      { setting: "claude-mid@high", task: "r", repeat: 1, timedOutMs: 1000 },
    ]);
    const page = renderResultsPages(input([judged], [tasks])).get("implementer")!;
    expect(page).toContain("| Setting | Cells | Core quality % | Edge % | Judged quality (judge-a:xhigh) | Judged quality (judge-b:xhigh) | Timed out |");
    expect(page).toContain("| gpt-mid@high | 2 | 100.0 | n/a | 97.5 | 97.5 | 0 |");
    expect(page).toContain("| claude-mid@high | 2 | 50.0 | n/a | 42.5 | 42.5 | 1 |");
    expect(page).toContain("Agreement of judge-a:xhigh and judge-b:xhigh: Spearman 1.00 over the 3 current changes that both scored.");
    const unjudged = renderResultsPages(input([campaign("implementer", "implement", [{ setting: "gpt-mid@high", task: "r" }])], [tasks])).get("implementer")!;
    expect(unjudged).toContain("Judged quality: no judge has scored a current change under judge identity quality-1; `bun bench/ab-persona/bench.ts --rejudge implementer --judge <model>:<effort>` scores them from the stored diffs.");
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
