import { EFFORT_VALUES } from "../../../../../infra/definitions/workflow/workflow-types.js";
import type { RankedModelTier } from "../../../../config/models/model-tiers.js";
import { judgeLabel, type CampaignRecords, type RecordJudge } from "./benchmark-records.js";
import type { BenchmarkMode } from "../catalog.js";
import { combineBenchmarkAccounting } from "../accounting/report-accounting.js";
import { byCodeUnit, cellQuality, poolRoleCells, scorable, type NotPooled, type PooledCell, type QualityCalibrationStanding, type RankingCorpus, type RankingFamily, type RankingInput, type ScorableTask } from "./ranking-pool.js";
import { judgedScore } from "../scoring/quality-judge.js";
import { bootstrapRandom, BOOTSTRAP_RESAMPLES, interval, nameDefault, resample, share, type DefaultNaming, type Interval } from "./ranking-confidence.js";

// The benchmark ranking (ARCH-DIRECTORIES-021, ARCH-DIRECTORIES-022). It
// measures each setting on absolute per-cell measures over the cells that
// `ranking-pool.ts` pools, and applies the approved rule: filters on quality
// and false alarms relative to the role's best, then
//   score = quality - weight * false - 3 log2(cost / cheapest) - 3 log2(latency / fastest)
// over the passing settings. Pairwise preference never enters it. It reads
// only record files and the catalog, so every clone reproduces it. Each
// persona ranks on its whole catalog corpus. A seeded bootstrap over tasks
// and repeats states each setting's confidence, and the setting that the
// ranking names rests on a quality lead that holds (ARCH-DIRECTORIES-025).
// An implementer's quality is the equal-weight mean of its test quality and
// its judged quality once the ranking judge's calibration passes, and its test
// quality alone otherwise (ARCH-DIRECTORIES-026).

interface SettingMeasures {
  readonly quality: number;
  /** An implementer setting's quality from hidden tests: ranked tasks less floor deductions. */
  readonly testQuality: number | undefined;
  /** An implementer setting's judged quality from 0 to 100, or undefined while a pooled change has no judged score. */
  readonly judgedQuality: number | undefined;
  readonly false: number;
  readonly cost: number;
  /** The cost is a lower bound: some cell recorded only part of its spend. */
  readonly costLowerBound: boolean;
  readonly partlyUnpricedCells: number;
  readonly latencySeconds: number;
  readonly cells: number;
  /** Pooled cells that hit their time limit, each a failed attempt. */
  readonly timedOutCells: number;
}

type Filter = "pass" | "quality" | "false";

interface MeasuredSetting extends SettingMeasures {
  readonly setting: string;
  readonly model: string;
  readonly effort: string;
  readonly family: RankingFamily | undefined;
  readonly tier: RankedModelTier | undefined;
}

interface RankedSetting extends MeasuredSetting {
  readonly score: number;
  readonly filter: Filter;
  /** The 5% and 95% bounds of quality and score over the resamples. */
  readonly qualityInterval: Interval;
  readonly scoreInterval: Interval;
  /** The share of resamples in which this setting outscores the next setting in point-score order; undefined on
   *  the last. */
  readonly beatsNext: number | undefined;
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
  /** An implementer ranking's quality judge calibration: judged quality enters quality only when it passes. */
  readonly calibration: QualityCalibrationStanding | undefined;
  readonly otherJudges: readonly { judge: string; cells: number }[];
  /** Each corpus with its scorable task count, and for an implementer corpus how many of them are floor tasks. */
  readonly corpora: readonly { persona: string; tasks: number; floor?: number }[];
  readonly guidance: readonly { persona: string; identity: string; cells: number }[];
  readonly settings: readonly RankedSetting[];
  readonly thresholds: { readonly quality: number; readonly false: number };
  readonly incomplete: readonly { setting: string; missing: readonly string[] }[];
  /** Failed attempts of suite cells that hold no result, which a resume runs again. */
  readonly retry: readonly { setting: string; task: string; repeat: number; persona: string; stamp: string; reason: string }[];
  readonly notRanked: readonly { setting: string; reason: string }[];
  readonly notPooled: readonly NotPooled[];
  readonly picks: readonly FamilyPick[];
  readonly fallback: { tier: RankedModelTier; effort: string } | undefined;
  /** The setting that the ranking names for the role, or undefined when no setting passes the filters. */
  readonly named: DefaultNaming | undefined;
  readonly evidence: readonly string[];
}

/** Per mode: the false measure's weight in the score, its filter slack over the role's minimum, and its labels. */
export const RULE = {
  reviewer: { weight: 5, slack: 0.6, quality: "recall %", false: "false P1/P2 per review" },
  research: { weight: 1, slack: 10, quality: "fact recall %", false: "trap rate %" },
  implement: { weight: 1, slack: 10, quality: "quality %", false: "followed false claims %" },
} satisfies { [Mode in BenchmarkMode]: { weight: number; slack: number; quality: string; false: string } };
const FAMILIES: readonly RankingFamily[] = ["openai", "anthropic"];
const TIER_OF_RANK: readonly RankedModelTier[] = ["cheap", "mid", "powerful"];
const EFFORT_ORDER = new Map<string, number>(EFFORT_VALUES.map((effort, index) => [effort, index]));

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  // The middle value of an odd count, or the two middle values of an even count.
  return mean(sorted.slice((sorted.length - 1) >> 1, (sorted.length >> 1) + 1));
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** One task's pooled cells of one setting. */
interface TaskCells {
  readonly task: ScorableTask;
  readonly cells: readonly PooledCell[];
}

/** One setting's pooled cells in one corpus, by task. A resample can hold one task several times. */
interface CorpusCells {
  readonly corpus: RankingCorpus;
  readonly tasks: readonly TaskCells[];
}

/** The judged quality of one implementer cell from 0 to 100, or undefined when it has no judged score: a timed-out
 *  cell made no change, so it scores 0. */
function cellJudgedQuality({ cell, quality }: PooledCell): number | undefined {
  if (cell.output.kind === "timed-out") return 0;
  return quality ? judgedScore(quality.score.findings) : undefined;
}

/** The mean over tasks of each task's mean judged cell quality, or undefined when a cell has no judged score. */
function judgedQuality(tasks: readonly TaskCells[]): number | undefined {
  const perTask: number[] = [];
  for (const { cells } of tasks) {
    const scores = cells.map(cellJudgedQuality);
    if (scores.some((score) => score === undefined)) return undefined;
    perTask.push(mean(scores.filter((score) => score !== undefined)));
  }
  return mean(perTask);
}

/** Quality and false measures of one setting's pooled cells in one corpus. With `combine`, an implementer's quality
 *  is the mean of its test quality and its judged quality. */
function corpusMeasures(mode: BenchmarkMode, tasks: readonly TaskCells[], combine: boolean): Pick<SettingMeasures, "quality" | "testQuality" | "judgedQuality" | "false"> {
  const cells = tasks.flatMap((part) => part.cells);
  if (mode === "reviewer") {
    let caught = 0;
    let seeded = 0;
    let severe = 0;
    for (const { score, task } of cells) {
      if (score?.scorer !== "review") throw new Error("A reviewer corpus holds a non-review score");
      // A control has no seeded defect, so its findings count only as false alarms.
      if (task.opportunities > 0) {
        caught += score.score.caught.length;
        seeded += task.opportunities;
      }
      severe += score.score.unsupportedSevereFindingCount ?? 0;
    }
    return { quality: 100 * caught / seeded, testQuality: undefined, judgedQuality: undefined, false: severe / cells.length };
  }
  if (mode === "research") {
    let caught = 0;
    let facts = 0;
    let trapped = 0;
    for (const { score, task } of cells) {
      if (score?.scorer !== "research") throw new Error("A research corpus holds a non-research score");
      caught += score.score.caught.length;
      facts += task.opportunities;
      if (score.score.trapsAsserted.length > 0) trapped++;
    }
    return { quality: 100 * caught / facts, testQuality: undefined, judgedQuality: undefined, false: 100 * trapped / cells.length };
  }
  // Each cell weighs the same within its task, and each task the same, whatever its check count. A ranked task adds
  // its mean core quality; a floor task subtracts its mean failed share, so a floor task that fails every check costs
  // as much as one ranked task at 0 (ARCH-DIRECTORIES-022, ARCH-DIRECTORIES-024).
  let ranked = 0;
  let total = 0;
  for (const { task, cells: taskCells } of tasks) {
    if (task.tier === undefined) throw new Error(`Implementer task ${task.id} has no tier`);
    const quality = mean(taskCells.map(cellQuality));
    if (task.tier === "ranked") ranked++;
    total += task.tier === "ranked" ? quality : quality - 1;
  }
  if (ranked === 0) throw new Error("An implementer corpus ranks no task: every task is floor");
  let followed = 0;
  let verdicts = 0;
  for (const { score } of cells) {
    if (score === undefined) continue;
    if (score.scorer !== "trap") throw new Error("An implement corpus holds a non-trap score");
    followed += score.score.traps.filter((trap) => trap.outcome === "followed-blindly").length;
    verdicts += score.score.traps.length;
  }
  const testQuality = 100 * total / ranked;
  const judged = judgedQuality(tasks);
  let quality = testQuality;
  if (combine) {
    if (judged === undefined) throw new Error("A combined implementer quality needs a judged score of every pooled change");
    // Floor deductions can take test quality below 0. The mean puts both measures on one 0 to 100 scale, so test
    // quality enters it clamped to that scale; the test-only quality keeps its full range.
    quality = (Math.min(100, Math.max(0, testQuality)) + judged) / 2;
  }
  return {
    quality,
    testQuality,
    judgedQuality: judged,
    false: verdicts === 0 ? 0 : 100 * followed / verdicts,
  };
}

/** Cost and latency of one setting's pooled cells in one corpus, or undefined when it has no cost. */
function spendMeasures(cells: readonly PooledCell[]): Pick<SettingMeasures, "cost" | "costLowerBound" | "partlyUnpricedCells" | "latencySeconds"> | undefined {
  // A cell that states no amount at all would make any mean a guess, while a partly priced cell still bounds it. A
  // bound of 0 states no amount: no attempt of the cell has a price.
  if (cells.some(({ cell }) => cell.accounting.estimatedUsd.kind === "unavailable" && !cell.accounting.estimatedUsd.atLeast)) return undefined;
  const estimated = combineBenchmarkAccounting(cells.map(({ cell }) => cell.accounting)).estimatedUsd;
  // SAFETY: the guard above returns for every cell without a positive `atLeast`, so an unavailable sum combines at least one amount.
  return {
    cost: (estimated.kind === "observed" ? estimated.value : estimated.atLeast!) / cells.length,
    costLowerBound: estimated.kind === "unavailable",
    partlyUnpricedCells: cells.filter(({ cell }) => cell.accounting.estimatedUsd.kind === "unavailable").length,
    latencySeconds: median(cells.map(({ cell }) => cell.durationMs)) / 1000,
  };
}

/** One setting's measures over its cells in each corpus, or undefined when its cost is unavailable. Each corpus of
 *  the role weighs the same, whatever its cell count, and cost and latency read only cells of tasks that are not
 *  floor tasks. */
function settingMeasures(mode: BenchmarkMode, perCorpus: readonly CorpusCells[], combine: boolean): SettingMeasures | undefined {
  const spend = perCorpus.map(({ tasks }) => spendMeasures(tasks.filter(({ task }) => task.tier !== "floor").flatMap(({ cells }) => cells)));
  if (spend.some((part) => part === undefined)) return undefined;
  const priced = spend.filter((part) => part !== undefined);
  const qualities = perCorpus.map(({ tasks }) => corpusMeasures(mode, tasks, combine));
  const cells = perCorpus.flatMap(({ tasks }) => tasks.flatMap((part) => part.cells));
  const meanOf = (values: readonly (number | undefined)[]) => values.some((value) => value === undefined) ? undefined : mean(values.filter((value) => value !== undefined));
  return {
    quality: mean(qualities.map((part) => part.quality)),
    testQuality: meanOf(qualities.map((part) => part.testQuality)),
    judgedQuality: meanOf(qualities.map((part) => part.judgedQuality)),
    false: mean(qualities.map((part) => part.false)),
    cost: mean(priced.map((part) => part.cost)),
    costLowerBound: priced.some((part) => part.costLowerBound),
    partlyUnpricedCells: priced.reduce((total, part) => total + part.partlyUnpricedCells, 0),
    latencySeconds: mean(priced.map((part) => part.latencySeconds)),
    cells: cells.length,
    timedOutCells: cells.filter(({ cell }) => cell.output.kind === "timed-out").length,
  };
}

/** The filters and score of each measured setting, in input order. The filters read the role's best quality and
 *  lowest false measure, and the cost and latency baselines read the passing settings. */
function scoreSettings<Setting extends SettingMeasures>(measured: readonly Setting[], rule: typeof RULE[BenchmarkMode]) {
  const thresholds = measured.length === 0
    ? { quality: 0, false: 0 }
    : { quality: Math.max(...measured.map((setting) => setting.quality)) - 10, false: Math.min(...measured.map((setting) => setting.false)) + rule.slack };
  const filterOf = (setting: SettingMeasures): Filter => setting.quality < thresholds.quality - 1e-9 ? "quality" : setting.false > thresholds.false + 1e-9 ? "false" : "pass";
  const passing = measured.filter((setting) => filterOf(setting) === "pass");
  const base = passing.length > 0 ? passing : measured;
  const cheapest = Math.min(...base.map((setting) => setting.cost));
  const fastest = Math.min(...base.map((setting) => setting.latencySeconds));
  return {
    thresholds,
    scored: measured.map((setting) => ({
      ...setting,
      score: setting.quality - rule.weight * setting.false - 3 * Math.log2(setting.cost / cheapest) - 3 * Math.log2(setting.latencySeconds / fastest),
      filter: filterOf(setting),
    })),
  };
}

/** A role whose records hold no cell that the ranking can pool, with what it left out. `judge` is undefined when no
 *  judge scored a current cell of the role; each campaign's own judge then states its cells' reasons. */
export interface UnpooledRole {
  readonly role: string;
  readonly judge: RecordJudge | undefined;
  readonly notPooled: readonly NotPooled[];
}

/** The resampling strata of a corpus: tasks resample within their stratum, so each resample keeps the corpus's
 *  ranked and floor implementer tasks, and a reviewer corpus's seeded fixtures and controls, at their counts. */
function strata(mode: BenchmarkMode, tasks: readonly ScorableTask[]): ScorableTask[][] {
  const groups = new Map<string, ScorableTask[]>();
  for (const task of tasks) {
    const key = mode === "implement" ? task.tier ?? "" : mode === "reviewer" ? String(task.opportunities > 0) : "";
    groups.set(key, [...groups.get(key) ?? [], task]);
  }
  return [...groups.values()];
}

function rankRole(role: string, campaigns: readonly CampaignRecords[], input: RankingInput): RoleRanking | UnpooledRole {
  const { judge: chosen, pools, notPooled, otherJudges } = poolRoleCells(role, campaigns, input);
  const corpora = pools.map(({ corpus }) => corpus);
  const modes = new Set(corpora.map(({ mode }) => mode));
  const [mode] = modes;
  // Without a chosen judge no cell pools, because no judge scored a current cell.
  if (!chosen || mode === undefined) return { role, judge: chosen, notPooled };
  const judge = chosen;
  if (modes.size !== 1) throw new Error(`Role ${role} pools corpora of several modes: ${[...modes].join(", ")}`);
  const rule = RULE[mode];
  const calibration = mode === "implement" ? input.qualityCalibration(judge) : undefined;
  const combine = calibration?.passed === true;

  // Each setting's first pooled cell names its model and effort.
  const settingCells = new Map<string, PooledCell>();
  for (const pooledCell of pools.flatMap(({ cells }) => cells)) {
    if (!settingCells.has(pooledCell.cell.variant)) settingCells.set(pooledCell.cell.variant, pooledCell);
  }
  const cellsOf = (setting: string, persona: string, task: string) => pools.find(({ corpus }) => corpus.persona === persona)?.cells.filter(({ cell }) => cell.variant === setting && cell.task === task) ?? [];
  const incomplete: { setting: string; missing: string[] }[] = [];
  const notRanked: { setting: string; reason: string }[] = [];
  const measured: MeasuredSetting[] = [];
  // Each measured setting's pooled cells by corpus and task, which the resamples draw from.
  const samples: ReadonlyMap<string, readonly PooledCell[]>[] = [];
  for (const [setting, { model, effort }] of [...settingCells].sort(([a], [b]) => byCodeUnit(a, b))) {
    const perCorpus = pools.map(({ corpus }) => ({
      corpus,
      tasks: corpus.tasks.filter(scorable).flatMap((task) => {
        const cells = cellsOf(setting, corpus.persona, task.id);
        return cells.length > 0 ? [{ task, cells }] : [];
      }),
      scorable: corpus.tasks.filter(scorable).length,
    }));
    const missing = perCorpus.filter((part) => part.tasks.length < part.scorable).map((part) => `${part.corpus.persona}: ${part.tasks.length} of ${part.scorable} tasks`);
    if (missing.length > 0) {
      incomplete.push({ setting, missing });
      continue;
    }
    const unjudged = perCorpus.flatMap(({ tasks }) => tasks.flatMap(({ cells }) => cells)).filter(({ cell, quality }) => cell.output.kind !== "timed-out" && quality === undefined).length;
    if (combine && unjudged > 0) {
      notRanked.push({ setting, reason: `${unjudged} pooled changes have no judged-quality score by ${judgeLabel(judge)}, which a rejudge by that judge adds` });
      continue;
    }
    const measures = settingMeasures(mode, perCorpus, combine);
    if (!measures) {
      notRanked.push({ setting, reason: "cost unavailable" });
      continue;
    }
    const { family, tier } = input.classify(model);
    measured.push({ setting, model, effort, family, tier, ...measures });
    samples.push(new Map(perCorpus.flatMap(({ corpus, tasks }) => tasks.map(({ task, cells }) => [`${corpus.persona}\u0000${task.id}`, cells] as const))));
  }
  const { thresholds, scored } = scoreSettings(measured, rule);

  // Each resample draws tasks with replacement within each stratum of each corpus, the same tasks for every setting,
  // then each setting's repeats of each drawn task with replacement, and scores every setting again under the same
  // formula, filters, and baselines (ARCH-DIRECTORIES-025).
  const random = bootstrapRandom();
  const corpusStrata = pools.map(({ corpus }) => strata(mode, corpus.tasks.filter(scorable)));
  const draws: { quality: number[]; score: number[] }[] = measured.map(() => ({ quality: [], score: [] }));
  for (let index = 0; index < BOOTSTRAP_RESAMPLES; index++) {
    const drawn = corpusStrata.map((groups) => groups.flatMap((group) => resample(group, random)));
    const resampled = samples.map((own) => {
      const perCorpus = pools.map(({ corpus }, position) => ({
        corpus,
        tasks: (drawn[position] ?? []).map((task) => ({ task, cells: resample(own.get(`${corpus.persona}\u0000${task.id}`)!, random) })), // SAFETY: a measured setting covers every scorable task of every corpus, so each drawn task has cells.
      }));
      // SAFETY: a resample holds only cells of a setting whose cost every cell states, so its cost is available.
      return settingMeasures(mode, perCorpus, combine)!;
    });
    for (const [position, setting] of scoreSettings(resampled, rule).scored.entries()) {
      draws[position]?.quality.push(setting.quality);
      draws[position]?.score.push(setting.score);
    }
  }
  const order = scored.map((setting, position) => ({ setting, draws: draws[position] ?? { quality: [], score: [] } })).sort((a, b) => b.setting.score - a.setting.score);
  const settings: RankedSetting[] = order.map(({ setting, draws: own }, position) => {
    const next = order[position + 1];
    return {
      ...setting,
      qualityInterval: interval(own.quality),
      scoreInterval: interval(own.score),
      beatsNext: next ? share(BOOTSTRAP_RESAMPLES, (resampleIndex) => (own.score[resampleIndex] ?? 0) > (next.draws.score[resampleIndex] ?? 0)) : undefined,
    };
  });
  const named = nameDefault(order.filter(({ setting }) => setting.filter === "pass").map(({ setting, draws: own }) => ({ setting: setting.setting, quality: setting.quality, qualitySamples: own.quality })));

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

  const retry = campaigns.flatMap((campaign) => {
    const suite = input.corpora.get(campaign.header.persona)?.tasks ?? [];
    return campaign.failures
      .filter((failure) => suite.some(({ id }) => id === failure.task) && !campaign.cells.some((cell) => cell.variant === failure.variant && cell.task === failure.task && cell.repeat === failure.repeat))
      .map(({ variant, task, repeat, reason }) => ({ setting: variant, task, repeat, persona: campaign.header.persona, stamp: campaign.header.stamp, reason }));
  }).sort((a, b) => byCodeUnit(a.setting, b.setting) || byCodeUnit(a.task, b.task) || a.repeat - b.repeat);

  const guidance = new Map<string, { persona: string; identity: string; cells: number }>();
  for (const { corpus: { persona }, cells } of pools) {
    for (const { campaign } of cells) {
      const key = `${persona}\u0000${campaign.header.personaGuidanceIdentity}`;
      guidance.set(key, { persona, identity: campaign.header.personaGuidanceIdentity, cells: (guidance.get(key)?.cells ?? 0) + 1 });
    }
  }
  return {
    role, entry: input.entryOf(role), mode, judge, calibration,
    otherJudges: [...otherJudges].map(([label, cells]) => ({ judge: label, cells })).sort((a, b) => a.judge.localeCompare(b.judge)),
    corpora: corpora.map((corpus) => {
      const tasks = corpus.tasks.filter(scorable);
      return { persona: corpus.persona, tasks: tasks.length, ...(mode === "implement" ? { floor: tasks.filter(({ tier }) => tier === "floor").length } : {}) };
    }),
    guidance: [...guidance.values()],
    settings, thresholds, incomplete, retry, notRanked, notPooled,
    picks, fallback, named,
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

/** One role's ranking as Markdown lines, without its heading: its inputs, the table, what it left out and why, and
 *  the policy it implies. */
export function renderRoleRanking(ranking: RoleRanking | UnpooledRole): string[] {
  if (!("settings" in ranking)) {
    return [ranking.judge ? `No recorded cell of this role can be pooled under ${judgeLabel(ranking.judge)}.` : "No judge has scored a current cell of this role; each campaign's own judge states the reasons below.", "", ...notPooledTable(ranking.notPooled), ""];
  }
  const rule = RULE[ranking.mode];
  const cost = (setting: RankedSetting) => `${setting.costLowerBound ? ">= " : ""}$${fixed(setting.cost, 3)}${setting.costLowerBound ? ` (${setting.partlyUnpricedCells} of ${setting.cells} cells partly unpriced)` : ""}`;
  const range = ({ low, high }: Interval) => `${fixed(low, 1)} to ${fixed(high, 1)}`;
  const percent = (value: number) => `${fixed(100 * value, 0)}%`;
  const named = ranking.named;
  const namedSetting = ranking.settings.find((setting) => setting.setting === named?.setting);
  const implement = ranking.mode === "implement";
  const optional = (value: number | undefined) => value === undefined ? "n/a" : fixed(value, 1);
  return [
    `Judge: ${judgeLabel(ranking.judge)}${ranking.otherJudges.length > 0 ? ` (other judges in these records: ${ranking.otherJudges.map(({ judge, cells }) => `${judge} ${cells} scores`).join(", ")})` : ""}`,
    `Corpora: ${ranking.corpora.map(({ persona, tasks, floor }) => `${persona} (${tasks} tasks${floor === undefined ? "" : `: ${tasks - floor} ranked, ${floor} floor`})`).join(", ")}${ranking.corpora.length > 1 ? ", averaged with equal weight" : ""}`,
    `Persona guidance: ${ranking.guidance.map(({ persona, identity, cells }) => `${persona} ${identity.slice(0, 8)} (${cells} cells)`).join(", ")}`,
    ...implement ? [
      "Test quality: the mean core quality over the ranked tasks, less each floor task's mean failed share of core and serious checks divided by the ranked task count, so a floor task that fails every check costs as much as one ranked task at 0. Cost and latency read only cells of ranked tasks.",
      `Judged quality: the mean over every task of its mean judged score of a change, 100 less 15 per major and 5 per minor finding that the judge reports in the diff; a timed-out cell scores 0. ${ranking.calibration?.passed
        ? `Quality is the equal-weight mean of test quality and judged quality, because the calibration of ${judgeLabel(ranking.judge)} passes: ${ranking.calibration.summary}.`
        : `Quality is test quality alone, and judged quality is reported beside it, because the calibration of ${judgeLabel(ranking.judge)} does not pass: ${ranking.calibration?.summary ?? "none"}.`}`,
    ] : [],
    `Filters: ${rule.quality} >= ${fixed(ranking.thresholds.quality, 1)}, ${rule.false} <= ${fixed(ranking.thresholds.false, 2)}. Score = quality - ${rule.weight} x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.`,
    `Confidence: each 90% interval spans the 5th to the 95th percentile over ${BOOTSTRAP_RESAMPLES} seeded resamples, which draw tasks with replacement and then each setting's repeats of each drawn task with replacement, and score every setting again. Beats next is the share of resamples in which a setting outscores the setting on the next row.`,
    "",
    `| Setting | Family | Tier | ${rule.quality} | Quality 90% |${implement ? " Test quality | Judged quality |" : ""} ${rule.false} | Cost/cell | Median latency | Score | Score 90% | Beats next | Filter | Cells |`,
    `|---|---|---|---:|---:|${implement ? "---:|---:|" : ""}---:|---:|---:|---:|---:|---:|---|---:|`,
    ...ranking.settings.map((setting) => `| ${setting.setting} | ${setting.family ?? "other"} | ${setting.tier ?? "unpriced"} | ${fixed(setting.quality, 1)} | ${range(setting.qualityInterval)} |${implement ? ` ${optional(setting.testQuality)} | ${optional(setting.judgedQuality)} |` : ""} ${fixed(setting.false, 2)} | ${cost(setting)} | ${fixed(setting.latencySeconds, 0)}s | ${fixed(setting.score, 1)} | ${range(setting.scoreInterval)} | ${setting.beatsNext === undefined ? "-" : percent(setting.beatsNext)} | ${setting.filter} | ${setting.cells}${setting.timedOutCells > 0 ? ` (${setting.timedOutCells} timed out)` : ""} |`),
    ...ranking.settings.some((setting) => setting.costLowerBound) ? ["", "A lower-bound cost enters the score as its bound, which can only flatter that setting."] : [],
    ...ranking.incomplete.length > 0 ? ["", "Incomplete (cells to run next):", ...ranking.incomplete.map(({ setting, missing }) => `- ${setting}: ${missing.join("; ")}`)] : [],
    ...ranking.retry.length > 0 ? ["", "Cells to retry (failed with no result; a resume runs them again):", ...ranking.retry.map(({ setting, task, repeat, persona, stamp, reason }) => `- ${setting} ${task} #${repeat} (${persona} ${stamp}): ${reason}`)] : [],
    ...ranking.notRanked.length > 0 ? ["", "Not ranked:", ...ranking.notRanked.map(({ setting, reason }) => `- ${setting}: ${reason}`)] : [],
    ...ranking.notPooled.length > 0 ? ["", ...notPooledTable(ranking.notPooled)] : [],
    "", "Policy:", "", "```",
    `${ranking.role} (ROLE_MODEL_DEFAULTS entry: ${ranking.entry}${ranking.entry === ranking.role ? "" : ", inherited"})`,
    `  named: ${!named || !namedSetting ? "none (no setting passes the filters)" : `${namedSetting.family ?? "other"} ${namedSetting.model} ${namedSetting.effort} (${named.kind === "lead"
      ? `its quality exceeds every other passing setting's in ${percent(named.share)} of resamples`
      : `no quality lead holds in 90% of resamples; the top scorer of the settings that ${named.leader} does not outscore on quality in 90% of resamples: ${named.tied.join(", ")}`})`}`,
    ...ranking.picks.map((pick, index) => `  ${index + 1}. ${pick.family} ${pick.setting.model} ${pick.setting.effort}${pick.passed ? "" : " (no setting of this family passes the filters)"}`),
    `  fallback: ${ranking.fallback ? `${ranking.fallback.tier}, ${ranking.fallback.effort}` : "none (no setting passes the filters)"}`,
    `  evidence: ${ranking.evidence.join(", ")}`, "```", "",
  ];
}

/** The ranking as Markdown: per role, its heading and `renderRoleRanking`. */
export function renderRanking(rankings: readonly (RoleRanking | UnpooledRole)[]): string {
  return rankings.flatMap((ranking) => [`## ${ranking.role}`, "", ...renderRoleRanking(ranking)]).join("\n");
}
