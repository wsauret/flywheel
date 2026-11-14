import { EFFORT_VALUES } from "../../../../infra/workflow-types.js";
import type { RankedModelTier } from "../../../config/model-tiers.js";
import { currentGrade, judgeLabel, recordScorer, type CampaignRecords, type CellLine, type RecordJudge, type ScoreLine } from "./benchmark-records.js";
import type { BenchmarkMode, ImplementTask, ResearchTask, ReviewTask } from "./catalog.js";
import { combineBenchmarkAccounting } from "./report-accounting.js";

// The benchmark ranking (ARCH-DIRECTORIES-021). It pools every recorded cell
// whose task content matches the current corpus and that one judge scored
// under the current scoring contract, measures each setting on absolute
// per-cell measures, and applies the approved rule: filters on quality and
// false alarms relative to the role's best, then
//   score = quality - weight * false - 3 log2(cost / cheapest) - 3 log2(latency / fastest)
// over the passing settings. Pairwise preference never enters it. It reads
// only record files and the catalog, so every clone reproduces it.

/** One current task of a persona's corpus. */
interface RankingTask {
  readonly id: string;
  readonly contentIdentity: string;
  /** Seeded defects of a review fixture (0 on a control) or key facts of a research task. Undefined marks a task
   *  that the ranking cannot score: a research task without an answer key, which only pairwise judging scores. */
  readonly opportunities: number | undefined;
  /** An implementation task's split identity: a cell whose candidate identity still matches stays current under a
   *  changed grader once the current grader has graded it. */
  readonly implementation?: { readonly candidateIdentity: string; readonly graderIdentity: string };
}

export interface RankingCorpus {
  readonly persona: string;
  readonly mode: BenchmarkMode;
  readonly tasks: readonly RankingTask[];
}

/** A persona's current catalog tasks as a ranking and a rejudge read them. */
export function rankingCorpus(persona: string, mode: BenchmarkMode, tasks: readonly (ResearchTask | ReviewTask | ImplementTask)[]): RankingCorpus {
  return {
    persona, mode,
    tasks: tasks.map((task) => ({
      id: task.id,
      contentIdentity: task.contentIdentity,
      opportunities: "snapshot" in task ? task.answerKey?.facts.length : "fixtureDir" in task ? task.manifest.defects.length : 0,
      ...("candidateIdentity" in task ? { implementation: { candidateIdentity: task.candidateIdentity, graderIdentity: task.graderIdentity } } : {}),
    })),
  };
}

export type RankingFamily = "openai" | "anthropic";

export interface RankingInput {
  readonly campaigns: readonly CampaignRecords[];
  /** Every persona's role, from persona frontmatter. */
  readonly roleOf: (persona: string) => string | undefined;
  /** The current corpus of a persona that has records. */
  readonly corpora: ReadonlyMap<string, RankingCorpus>;
  /** The current scoring contract of a mode. */
  readonly scoringVersion: (mode: BenchmarkMode) => string;
  /** The coded family whose models document prices `model`, with its price tier there; both undefined for neither. */
  readonly classify: (model: string) => { family: RankingFamily | undefined; tier: RankedModelTier | undefined };
  /** The ROLE_MODEL_DEFAULTS entry that a role reads. */
  readonly entryOf: (role: string) => string;
  readonly roles?: readonly string[];
  readonly judge?: RecordJudge;
}

interface SettingMeasures {
  readonly quality: number;
  readonly false: number;
  readonly cost: number;
  /** The cost is a lower bound: some cell recorded only part of its spend. */
  readonly costLowerBound: boolean;
  readonly partlyUnpricedCells: number;
  readonly latencySeconds: number;
  readonly cells: number;
}

interface RankedSetting extends SettingMeasures {
  readonly setting: string;
  readonly model: string;
  readonly effort: string;
  readonly family: RankingFamily | undefined;
  readonly tier: RankedModelTier | undefined;
  readonly score: number;
  readonly filter: "pass" | "quality" | "false";
}

interface NotPooled {
  readonly persona: string;
  readonly stamp: string;
  readonly reason: string;
  readonly cells: number;
  readonly command?: string;
}

interface FamilyPick {
  readonly family: RankingFamily;
  readonly setting: RankedSetting;
  /** False when no setting of the family passes the filters, so its top scorer stands in. */
  readonly passed: boolean;
}

export interface RoleRanking {
  readonly role: string;
  readonly entry: string;
  readonly mode: BenchmarkMode;
  readonly judge: RecordJudge;
  readonly otherJudges: readonly { judge: string; cells: number }[];
  readonly corpora: readonly { persona: string; tasks: number }[];
  readonly guidance: readonly { persona: string; identity: string; cells: number }[];
  readonly settings: readonly RankedSetting[];
  readonly thresholds: { readonly quality: number; readonly false: number };
  readonly incomplete: readonly { setting: string; missing: readonly string[] }[];
  readonly notRanked: readonly { setting: string; reason: string }[];
  readonly notPooled: readonly NotPooled[];
  readonly picks: readonly FamilyPick[];
  readonly fallback: { tier: RankedModelTier; effort: string } | undefined;
  readonly evidence: readonly string[];
}

/** Per mode: the false measure's weight in the score, its filter slack over the role's minimum, and its labels. */
const RULE = {
  reviewer: { weight: 5, slack: 0.6, quality: "recall %", false: "false P1/P2 per review" },
  research: { weight: 1, slack: 10, quality: "fact recall %", false: "trap rate %" },
  implement: { weight: 1, slack: 10, quality: "hidden-test pass %", false: "followed false claims %" },
} satisfies { [Mode in BenchmarkMode]: { weight: number; slack: number; quality: string; false: string } };
const FAMILIES: readonly RankingFamily[] = ["openai", "anthropic"];
const TIER_OF_RANK: readonly RankedModelTier[] = ["cheap", "mid", "powerful"];
const EFFORT_ORDER = new Map<string, number>(EFFORT_VALUES.map((effort, index) => [effort, index]));

/** A task that the ranking can score: it states its opportunities. */
type ScorableTask = RankingTask & { readonly opportunities: number };

function scorable(task: RankingTask): task is ScorableTask {
  return task.opportunities !== undefined;
}

/** Why a cell cannot join a ranking. `unscored` marks the reasons that a rejudge by the judge removes: the cell is
 *  current, and only its score under the current contract is missing. */
interface StaleCell {
  readonly reason: string;
  readonly unscored?: true;
}

/** Where a current cell pools: its corpus, its scorable task, its pinned setting, and its score under the contract. */
interface CellPlace {
  readonly corpus: RankingCorpus;
  readonly task: ScorableTask;
  readonly model: string;
  readonly effort: string;
  readonly score: ScoreLine;
}

interface PooledCell extends CellPlace {
  readonly campaign: CampaignRecords;
  readonly cell: CellLine;
}

/** Strings in code-unit order, as `Array.prototype.sort` orders them by default. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameJudge(a: RecordJudge, b: RecordJudge): boolean {
  return a.model === b.model && a.effort === b.effort;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  // The middle value of an odd count, or the two middle values of an even count.
  return mean(sorted.slice((sorted.length - 1) >> 1, (sorted.length >> 1) + 1));
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** The grade of an implementation cell by the current grader, when the task changed only in grading since the cell
 *  ran and a regrade graded it. */
function regradedGrade(campaign: CampaignRecords, cell: CellLine, task: RankingTask) {
  if (cell.taskIdentity === task.contentIdentity || !task.implementation) return undefined;
  return currentGrade(campaign, cell, task.implementation.graderIdentity);
}

/** Why the task of a cell no longer matches the cell, or undefined while it does. */
function taskChange(campaign: CampaignRecords, cell: CellLine, task: RankingTask): string | undefined {
  if (task.contentIdentity === cell.taskIdentity) return undefined;
  if (!task.implementation || cell.output.kind !== "implementation" || cell.output.candidateIdentity !== task.implementation.candidateIdentity) return "task content changed";
  return regradedGrade(campaign, cell, task) ? undefined : "task grader changed (--regrade grades it with the current grader)";
}

/** Where a cell pools in a ranking under `judge`, or why it cannot. */
export function cellStanding(cell: CellLine, campaign: CampaignRecords, corpus: RankingCorpus | undefined, judge: RecordJudge, version: string): StaleCell | CellPlace {
  const { model, effort } = cell;
  if (model === undefined || effort === undefined) return { reason: "no pinned model" };
  const task = corpus?.tasks.find(({ id }) => id === cell.task);
  if (!corpus || !task) return { reason: "task removed from corpus" };
  const changed = taskChange(campaign, cell, task);
  if (changed) return { reason: changed };
  if (!scorable(task)) return { reason: "task has no answer key" };
  const scores = campaign.scores.filter((line) => sameJudge(line.judge, judge) && line.scorer === recordScorer(campaign.header.mode) && line.score.variant === cell.variant && line.score.task === cell.task && line.score.repeat === cell.repeat);
  const score = scores.find((line) => line.scoringVersion === version);
  if (score) return { corpus, task, model, effort, score };
  const old = scores[0];
  return { reason: old ? `scored under ${old.scoringVersion}` : `not scored by ${judgeLabel(judge)}`, unscored: true };
}

/** The judge that scored the most current cells of a role, under the current scoring contract, or undefined when
 *  no judge scored any. When two judges scored as many, the one that more of those cells' own campaigns ran with
 *  wins: a rejudge of every cell does not displace the judge the campaigns chose. */
function defaultJudge(role: string, campaigns: readonly CampaignRecords[], input: RankingInput): RecordJudge | undefined {
  const counts = new Map<string, { judge: RecordJudge; cells: number; own: number }>();
  for (const campaign of campaigns) {
    const corpus = input.corpora.get(campaign.header.persona);
    const version = input.scoringVersion(campaign.header.mode);
    for (const line of campaign.scores) {
      if (line.scoringVersion !== version) continue;
      const cell = campaign.cells.find((candidate) => candidate.variant === line.score.variant && candidate.task === line.score.task && candidate.repeat === line.score.repeat);
      if (!cell || "reason" in cellStanding(cell, campaign, corpus, line.judge, version)) continue;
      const key = judgeLabel(line.judge);
      const prior = counts.get(key);
      counts.set(key, { judge: line.judge, cells: (prior?.cells ?? 0) + 1, own: (prior?.own ?? 0) + Number(sameJudge(line.judge, campaign.header.judge)) });
    }
  }
  const ranked = [...counts.values()].sort((a, b) => b.cells - a.cells || b.own - a.own);
  const [top, next] = ranked;
  if (!top) return undefined;
  if (next && next.cells === top.cells && next.own === top.own) throw new Error(`Judges ${judgeLabel(top.judge)} and ${judgeLabel(next.judge)} each scored ${top.cells} current cells of role ${role}; name one with --judge`);
  return top.judge;
}

/** Quality and false measures of one setting's pooled cells in one corpus. */
function corpusMeasures(mode: BenchmarkMode, cells: readonly PooledCell[]): Pick<SettingMeasures, "quality" | "false"> {
  if (mode === "reviewer") {
    let caught = 0;
    let seeded = 0;
    let severe = 0;
    for (const { score, task } of cells) {
      if (score.scorer !== "review") throw new Error("A reviewer corpus holds a non-review score");
      // A control has no seeded defect, so its findings count only as false alarms.
      if (task.opportunities > 0) {
        caught += score.score.caught.length;
        seeded += task.opportunities;
      }
      severe += score.score.unsupportedSevereFindingCount ?? 0;
    }
    return { quality: 100 * caught / seeded, false: severe / cells.length };
  }
  if (mode === "research") {
    let caught = 0;
    let facts = 0;
    let trapped = 0;
    for (const { score, task } of cells) {
      if (score.scorer !== "research") throw new Error("A research corpus holds a non-research score");
      caught += score.score.caught.length;
      facts += task.opportunities;
      if (score.score.trapsAsserted.length > 0) trapped++;
    }
    return { quality: 100 * caught / facts, false: 100 * trapped / cells.length };
  }
  let passed = 0;
  let total = 0;
  let followed = 0;
  let verdicts = 0;
  for (const { campaign, cell, score, task } of cells) {
    if (score.scorer !== "trap" || cell.output.kind !== "implementation") throw new Error("An implement corpus holds a non-implementation cell or score");
    // A regrade by the current grader replaces the grade that the cell recorded under an earlier grader.
    const grade = regradedGrade(campaign, cell, task) ?? { passed: cell.output.acceptancePassed, total: cell.output.acceptanceTotal };
    passed += grade.passed;
    total += grade.total;
    followed += score.score.traps.filter((trap) => trap.outcome === "followed-blindly").length;
    verdicts += score.score.traps.length;
  }
  return { quality: 100 * passed / total, false: verdicts === 0 ? 0 : 100 * followed / verdicts };
}

/** Cost and latency of one setting's pooled cells in one corpus, or undefined when it has no cost. */
function spendMeasures(cells: readonly PooledCell[]): Omit<SettingMeasures, "quality" | "false" | "cells"> | undefined {
  // A cell that states no amount at all would make any mean a guess, while a partly priced cell still bounds it.
  if (cells.some(({ cell }) => cell.accounting.estimatedUsd.kind === "unavailable" && cell.accounting.estimatedUsd.atLeast === undefined)) return undefined;
  const estimated = combineBenchmarkAccounting(cells.map(({ cell }) => cell.accounting)).estimatedUsd;
  // SAFETY: the guard above returns for every cell without `atLeast`, so an unavailable sum combines at least one amount.
  return {
    cost: (estimated.kind === "observed" ? estimated.value : estimated.atLeast!) / cells.length,
    costLowerBound: estimated.kind === "unavailable",
    partlyUnpricedCells: cells.filter(({ cell }) => cell.accounting.estimatedUsd.kind === "unavailable").length,
    latencySeconds: median(cells.map(({ cell }) => cell.durationMs)) / 1000,
  };
}

/** A role whose records hold no cell that the ranking can pool, with what it left out. `judge` is undefined when no
 *  judge scored a current cell of the role; each campaign's own judge then states its cells' reasons. */
export interface UnpooledRole {
  readonly role: string;
  readonly judge: RecordJudge | undefined;
  readonly notPooled: readonly NotPooled[];
}

function rankRole(role: string, campaigns: readonly CampaignRecords[], input: RankingInput): RoleRanking | UnpooledRole {
  const chosen = input.judge ?? defaultJudge(role, campaigns, input);
  const notPooledCounts = new Map<string, NotPooled>();
  const pooled = new Map<string, { corpus: RankingCorpus; cells: PooledCell[] }>();
  const otherJudges = new Map<string, number>();
  for (const campaign of campaigns) {
    const { persona, mode } = campaign.header;
    const corpus = input.corpora.get(persona);
    const version = input.scoringVersion(mode);
    // Without a chosen judge, each campaign's own judge states why its cells do not pool.
    const cellJudge = chosen ?? campaign.header.judge;
    for (const cell of campaign.cells) {
      const standing = cellStanding(cell, campaign, corpus, cellJudge, version);
      if ("reason" in standing) {
        const key = `${persona}\u0000${campaign.header.stamp}\u0000${standing.reason}`;
        const prior = notPooledCounts.get(key);
        notPooledCounts.set(key, {
          persona, stamp: campaign.header.stamp, reason: standing.reason, cells: (prior?.cells ?? 0) + 1,
          ...(standing.unscored ? { command: `bun bench/ab-persona/bench.ts --rejudge ${persona} --judge ${judgeLabel(cellJudge)}` } : {}),
        });
        continue;
      }
      const pool = pooled.get(persona) ?? { corpus: standing.corpus, cells: [] };
      pool.cells.push({ ...standing, campaign, cell });
      pooled.set(persona, pool);
    }
    for (const line of campaign.scores) {
      if (chosen && !sameJudge(line.judge, chosen)) otherJudges.set(judgeLabel(line.judge), (otherJudges.get(judgeLabel(line.judge)) ?? 0) + 1);
    }
  }
  const pools = [...pooled.values()].sort((a, b) => byCodeUnit(a.corpus.persona, b.corpus.persona));
  const corpora = pools.map(({ corpus }) => corpus);
  const modes = new Set(corpora.map(({ mode }) => mode));
  const [mode] = modes;
  // Without a chosen judge no cell pools, because no judge scored a current cell.
  if (!chosen || mode === undefined) return { role, judge: chosen, notPooled: [...notPooledCounts.values()] };
  const judge = chosen;
  if (modes.size !== 1) throw new Error(`Role ${role} pools corpora of several modes: ${[...modes].join(", ")}`);
  const rule = RULE[mode];

  // Each setting's first pooled cell names its model and effort.
  const settingCells = new Map<string, PooledCell>();
  for (const pooledCell of pools.flatMap(({ cells }) => cells)) {
    if (!settingCells.has(pooledCell.cell.variant)) settingCells.set(pooledCell.cell.variant, pooledCell);
  }
  const incomplete: { setting: string; missing: string[] }[] = [];
  const notRanked: { setting: string; reason: string }[] = [];
  const measured: (Omit<RankedSetting, "score" | "filter">)[] = [];
  for (const [setting, { model, effort }] of [...settingCells].sort(([a], [b]) => byCodeUnit(a, b))) {
    const perCorpus = pools.map(({ corpus, cells: pooledCells }) => {
      const cells = pooledCells.filter(({ cell }) => cell.variant === setting);
      const tasks = corpus.tasks.filter(scorable);
      const covered = tasks.filter((task) => cells.some(({ cell }) => cell.task === task.id)).length;
      return { corpus, cells, covered, scorable: tasks.length };
    });
    const missing = perCorpus.filter((part) => part.covered < part.scorable).map((part) => `${part.corpus.persona}: ${part.covered} of ${part.scorable} tasks`);
    if (missing.length > 0) {
      incomplete.push({ setting, missing });
      continue;
    }
    const spend = perCorpus.flatMap((part) => spendMeasures(part.cells) ?? []);
    if (spend.length < perCorpus.length) {
      notRanked.push({ setting, reason: "cost unavailable" });
      continue;
    }
    const qualities = perCorpus.map((part) => corpusMeasures(mode, part.cells));
    const { family, tier } = input.classify(model);
    measured.push({
      setting, model, effort, family, tier,
      // Each corpus of the role weighs the same, whatever its cell count.
      quality: mean(qualities.map((part) => part.quality)),
      false: mean(qualities.map((part) => part.false)),
      cost: mean(spend.map((part) => part.cost)),
      costLowerBound: spend.some((part) => part.costLowerBound),
      partlyUnpricedCells: spend.reduce((total, part) => total + part.partlyUnpricedCells, 0),
      latencySeconds: mean(spend.map((part) => part.latencySeconds)),
      cells: perCorpus.reduce((total, part) => total + part.cells.length, 0),
    });
  }

  const thresholds = measured.length === 0
    ? { quality: 0, false: 0 }
    : { quality: Math.max(...measured.map((setting) => setting.quality)) - 10, false: Math.min(...measured.map((setting) => setting.false)) + rule.slack };
  const filterOf = (setting: SettingMeasures): RankedSetting["filter"] => setting.quality < thresholds.quality - 1e-9 ? "quality" : setting.false > thresholds.false + 1e-9 ? "false" : "pass";
  const passing = measured.filter((setting) => filterOf(setting) === "pass");
  const base = passing.length > 0 ? passing : measured;
  const cheapest = Math.min(...base.map((setting) => setting.cost));
  const fastest = Math.min(...base.map((setting) => setting.latencySeconds));
  const settings: RankedSetting[] = measured
    .map((setting) => ({
      ...setting,
      score: setting.quality - rule.weight * setting.false - 3 * Math.log2(setting.cost / cheapest) - 3 * Math.log2(setting.latencySeconds / fastest),
      filter: filterOf(setting),
    }))
    .sort((a, b) => b.score - a.score);

  const picks = FAMILIES.flatMap((family): FamilyPick[] => {
    const own = settings.filter((setting) => setting.family === family);
    const pass = own.find((setting) => setting.filter === "pass");
    const pick = pass ?? own[0];
    return pick ? [{ family, setting: pick, passed: pass !== undefined }] : [];
  }).sort((a, b) => Number(b.passed) - Number(a.passed) || b.setting.score - a.setting.score);

  const passingSettings = settings.filter((setting) => setting.filter === "pass");
  // cheap 1, mid 2, powerful 3; an unpriced setting has no tier to average.
  const ranks = passingSettings.flatMap((setting) => setting.tier ? [TIER_OF_RANK.indexOf(setting.tier) + 1] : []);
  const effortCounts = new Map<string, number>();
  for (const setting of passingSettings) effortCounts.set(setting.effort, (effortCounts.get(setting.effort) ?? 0) + 1);
  const effortOrder = (effort: string) => EFFORT_ORDER.get(effort) ?? -1;
  const [effort] = [...effortCounts].sort((a, b) => b[1] - a[1] || effortOrder(b[0]) - effortOrder(a[0]));
  // SAFETY: every rank is 1 to 3, so the floor of their mean less one indexes TIER_OF_RANK.
  const fallback = ranks.length > 0 && effort
    ? { tier: TIER_OF_RANK[Math.floor(mean(ranks)) - 1]!, effort: effort[0] }
    : undefined;

  const guidance = new Map<string, { persona: string; identity: string; cells: number }>();
  for (const { corpus: { persona }, cells } of pools) {
    for (const { campaign } of cells) {
      const key = `${persona}\u0000${campaign.header.personaGuidanceIdentity}`;
      guidance.set(key, { persona, identity: campaign.header.personaGuidanceIdentity, cells: (guidance.get(key)?.cells ?? 0) + 1 });
    }
  }
  return {
    role, entry: input.entryOf(role), mode, judge,
    otherJudges: [...otherJudges].map(([label, cells]) => ({ judge: label, cells })).sort((a, b) => a.judge.localeCompare(b.judge)),
    corpora: corpora.map((corpus) => ({ persona: corpus.persona, tasks: corpus.tasks.filter(scorable).length })),
    guidance: [...guidance.values()],
    settings, thresholds, incomplete, notRanked,
    notPooled: [...notPooledCounts.values()],
    picks, fallback,
    evidence: [...new Set(pools.flatMap(({ corpus, cells }) => cells.map(({ campaign }) => `${corpus.persona}-${campaign.header.stamp}`)))].sort(),
  };
}

/** Rank every selected role that has records. A named role with no record is an error. */
export function rankBenchmarkRecords(input: RankingInput): (RoleRanking | UnpooledRole)[] {
  const byRole = new Map<string, CampaignRecords[]>();
  for (const campaign of input.campaigns) {
    const role = input.roleOf(campaign.header.persona);
    if (role === undefined) throw new Error(`${campaign.file} names persona ${campaign.header.persona}, which has no role`);
    byRole.set(role, [...byRole.get(role) ?? [], campaign]);
  }
  const selected = input.roles?.map((role) => {
    const campaigns = byRole.get(role);
    if (!campaigns) throw new Error(`No benchmark records for role ${role}; roles with records: ${[...byRole.keys()].sort().join(", ")}`);
    return [role, campaigns] as const;
  }) ?? [...byRole].sort(([a], [b]) => byCodeUnit(a, b));
  return selected.map(([role, campaigns]) => rankRole(role, campaigns, input));
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

function notPooledTable(rows: readonly NotPooled[]): string[] {
  return ["Not pooled:", "", "| Persona | Campaign | Cells | Reason |", "|---|---|---:|---|", ...rows.map((row) => `| ${row.persona} | ${row.stamp} | ${row.cells} | ${row.reason}${row.command ? ` (\`${row.command}\`)` : ""} |`)];
}

/** The ranking as Markdown: per role, its inputs, the table, what it left out and why, and the policy it implies. */
export function renderRanking(rankings: readonly (RoleRanking | UnpooledRole)[]): string {
  const out: string[] = [];
  for (const ranking of rankings) {
    if (!("settings" in ranking)) {
      out.push(`## ${ranking.role}`, "", ranking.judge ? `No recorded cell of this role can be pooled under ${judgeLabel(ranking.judge)}.` : "No judge has scored a current cell of this role; each campaign's own judge states the reasons below.", "", ...notPooledTable(ranking.notPooled), "");
      continue;
    }
    const rule = RULE[ranking.mode];
    const cost = (setting: RankedSetting) => `${setting.costLowerBound ? ">= " : ""}$${fixed(setting.cost, 3)}${setting.costLowerBound ? ` (${setting.partlyUnpricedCells} of ${setting.cells} cells partly unpriced)` : ""}`;
    out.push(
      `## ${ranking.role}`,
      "",
      `Judge: ${judgeLabel(ranking.judge)}${ranking.otherJudges.length > 0 ? ` (other judges in these records: ${ranking.otherJudges.map(({ judge, cells }) => `${judge} ${cells} scores`).join(", ")})` : ""}`,
      `Corpora: ${ranking.corpora.map(({ persona, tasks }) => `${persona} (${tasks} tasks)`).join(", ")}${ranking.corpora.length > 1 ? ", averaged with equal weight" : ""}`,
      `Persona guidance: ${ranking.guidance.map(({ persona, identity, cells }) => `${persona} ${identity.slice(0, 8)} (${cells} cells)`).join(", ")}`,
      `Filters: ${rule.quality} >= ${fixed(ranking.thresholds.quality, 1)}, ${rule.false} <= ${fixed(ranking.thresholds.false, 2)}. Score = quality - ${rule.weight} x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.`,
      "",
      `| Setting | Family | Tier | ${rule.quality} | ${rule.false} | Cost/cell | Median latency | Score | Filter | Cells |`,
      "|---|---|---|---:|---:|---:|---:|---:|---|---:|",
      ...ranking.settings.map((setting) => `| ${setting.setting} | ${setting.family ?? "other"} | ${setting.tier ?? "unpriced"} | ${fixed(setting.quality, 1)} | ${fixed(setting.false, 2)} | ${cost(setting)} | ${fixed(setting.latencySeconds, 0)}s | ${fixed(setting.score, 1)} | ${setting.filter} | ${setting.cells} |`),
      ...ranking.settings.some((setting) => setting.costLowerBound) ? ["", "A lower-bound cost enters the score as its bound, which can only flatter that setting."] : [],
      ...ranking.incomplete.length > 0 ? ["", "Incomplete (cells to run next):", ...ranking.incomplete.map(({ setting, missing }) => `- ${setting}: ${missing.join("; ")}`)] : [],
      ...ranking.notRanked.length > 0 ? ["", "Not ranked:", ...ranking.notRanked.map(({ setting, reason }) => `- ${setting}: ${reason}`)] : [],
      ...ranking.notPooled.length > 0 ? ["", ...notPooledTable(ranking.notPooled)] : [],
      "", "Policy:", "", "```",
      `${ranking.role} (ROLE_MODEL_DEFAULTS entry: ${ranking.entry}${ranking.entry === ranking.role ? "" : ", inherited"})`,
      ...ranking.picks.map((pick, index) => `  ${index + 1}. ${pick.family} ${pick.setting.model} ${pick.setting.effort}${pick.passed ? "" : " (no setting of this family passes the filters)"}`),
      `  fallback: ${ranking.fallback ? `${ranking.fallback.tier}, ${ranking.fallback.effort}` : "none (no setting passes the filters)"}`,
      `  evidence: ${ranking.evidence.join(", ")}`, "```", "",
    );
  }
  return out.join("\n");
}
