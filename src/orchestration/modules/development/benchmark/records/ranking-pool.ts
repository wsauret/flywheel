import type { RankedModelTier } from "../../../../config/models/model-tiers.js";
import { currentGrade, judgeLabel, recordScorer, type CampaignRecords, type CellLine, type QualityScoreLine, type RecordJudge, type ScoreLine } from "./benchmark-records.js";
import type { BenchmarkMode, ImplementTask, ResearchTask, ReviewTask, TaskTier } from "../catalog.js";
import { checkQuality, type CheckGrade } from "../implement-task/check-grade.js";

// What a benchmark ranking pools (ARCH-DIRECTORIES-021, ARCH-DIRECTORIES-022): each persona's current corpus, the
// standing of each recorded cell against it under one judge and the current scoring contract and grader, and the
// cells of a role that pool. The ranking and the tier rule both read the pooled cells from here.

/** One current task of a persona's corpus. */
export interface RankingTask {
  readonly id: string;
  readonly contentIdentity: string;
  /** Seeded defects of a review fixture (0 on a control) or key facts of a research task. Undefined marks a task
   *  that the ranking cannot score: a research task without an answer key, which only pairwise judging scores. */
  readonly opportunities: number | undefined;
  /** An implementation task's split identity: a cell whose candidate identity still matches stays current under a
   *  changed grader once the current grader has graded it. */
  readonly implementation?: { readonly candidateIdentity: string; readonly graderIdentity: string };
  /** An implementer task's committed tier. Every task of an implementer corpus that a ranking measures states one. */
  readonly tier?: TaskTier;
}

export interface RankingCorpus {
  readonly persona: string;
  readonly mode: BenchmarkMode;
  /** The persona's whole catalog corpus: coverage, pooling, and averaging read these tasks. */
  readonly tasks: readonly RankingTask[];
}

/** A persona's current corpus, from its catalog tasks, as a ranking and a rejudge read it. `tiers` holds the
 *  committed tier of each implementer task, which a ranking reads and a rejudge does not. */
export function rankingCorpus(persona: string, mode: BenchmarkMode, tasks: readonly (ResearchTask | ReviewTask | ImplementTask)[], tiers?: ReadonlyMap<string, TaskTier>): RankingCorpus {
  return {
    persona,
    mode,
    tasks: tasks.map((task) => ({
      id: task.id,
      contentIdentity: task.contentIdentity,
      opportunities: "snapshot" in task ? task.answerKey?.facts.length : "fixtureDir" in task ? task.manifest.defects.length : 0,
      ...("candidateIdentity" in task ? { implementation: { candidateIdentity: task.candidateIdentity, graderIdentity: task.graderIdentity } } : {}),
      ...(tiers?.has(task.id) ? { tier: tiers.get(task.id) } : {}),
    })),
  };
}

export type RankingFamily = "openai" | "anthropic";

/** Whether a quality judge's committed calibration passes under the current judge identity, with a one-line summary
 *  of its evidence or of why it does not pass (ARCH-DIRECTORIES-026). */
export interface QualityCalibrationStanding {
  readonly passed: boolean;
  readonly summary: string;
}

export interface RankingInput {
  readonly campaigns: readonly CampaignRecords[];
  /** Every persona's role, from persona frontmatter. */
  readonly roleOf: (persona: string) => string | undefined;
  /** The current corpus of a persona that has records. */
  readonly corpora: ReadonlyMap<string, RankingCorpus>;
  /** The current scoring contract of a mode. */
  readonly scoringVersion: (mode: BenchmarkMode) => string;
  /** The current judged-quality judge identity, which a judged-quality score line records as its scoring version. */
  readonly qualityScoringVersion: string;
  /** The committed calibration of a quality judge: its judged quality enters an implementer ranking only when it passes. */
  readonly qualityCalibration: (judge: RecordJudge) => QualityCalibrationStanding;
  /** The coded family whose models document prices `model`, with its price tier there; both undefined for neither. */
  readonly classify: (model: string) => { family: RankingFamily | undefined; tier: RankedModelTier | undefined };
  /** The ROLE_MODEL_DEFAULTS entry that a role reads. */
  readonly entryOf: (role: string) => string;
  readonly roles?: readonly string[];
  readonly judge?: RecordJudge;
}
export interface NotPooled {
  readonly persona: string;
  readonly stamp: string;
  readonly reason: string;
  readonly cells: number;
  readonly command?: string;
}

/** A task that the ranking can score: it states its opportunities. */
export type ScorableTask = RankingTask & { readonly opportunities: number };

export function scorable(task: RankingTask): task is ScorableTask {
  return task.opportunities !== undefined;
}

/** Why a cell cannot join a ranking. `unscored` marks the reasons that a rejudge by the judge removes: the cell is
 *  current, and only its score under the current contract is missing. */
interface StaleCell {
  readonly reason: string;
  readonly unscored?: true;
}

/** Where a current cell pools: its corpus, its scorable task, its pinned setting, its score under the contract, and
 *  an implementation cell's grade by the current grader. A timed-out implementer cell pools with no score and no
 *  grade: it made no change for a judge to read or a grader to run. */
interface CellPlace {
  readonly corpus: RankingCorpus;
  readonly task: ScorableTask;
  readonly model: string;
  readonly effort: string;
  readonly score: ScoreLine | undefined;
  readonly grade?: CheckGrade;
}

export interface PooledCell extends CellPlace {
  readonly campaign: CampaignRecords;
  readonly cell: CellLine;
  /** The cell's judged-quality score by the pooling judge under the current judge identity, if it has one. */
  readonly quality: QualityScoreLine | undefined;
}

/** The judged-quality score line of `cell` by `judge` under judge identity `version`. */
export function qualityScoreOf(campaign: CampaignRecords, cell: Pick<CellLine, "variant" | "task" | "repeat">, judge: RecordJudge, version: string): QualityScoreLine | undefined {
  return campaign.scores.find((line): line is QualityScoreLine => line.scorer === "quality" && line.scoringVersion === version && sameJudge(line.judge, judge)
    && line.score.variant === cell.variant && line.score.task === cell.task && line.score.repeat === cell.repeat);
}

/** Strings in code-unit order, as `Array.prototype.sort` orders them by default. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameJudge(a: RecordJudge, b: RecordJudge): boolean {
  return a.model === b.model && a.effort === b.effort;
}

/** The grade of an implementation cell by the task's current grader: the grade it recorded while its task is
 *  unchanged, otherwise the grade of a regrade by the current grader. Undefined when neither exists. */
export function currentCellGrade(campaign: CampaignRecords, cell: CellLine, task: RankingTask): CheckGrade | undefined {
  if (cell.output.kind !== "implementation") return undefined;
  if (task.contentIdentity === cell.taskIdentity) return "grade" in cell.output ? cell.output.grade : undefined;
  return task.implementation ? currentGrade(campaign, cell, task.implementation.graderIdentity) : undefined;
}

/** Why the task of a cell no longer matches the cell, or undefined while it does. */
function taskChange(campaign: CampaignRecords, cell: CellLine, task: RankingTask): string | undefined {
  if (cell.output.kind === "review" || cell.output.kind === "answer") return task.contentIdentity === cell.taskIdentity ? undefined : "task content changed";
  if (task.contentIdentity !== cell.taskIdentity && cell.output.candidateIdentity !== task.implementation?.candidateIdentity) return "task content changed";
  // A timed-out cell is a failed attempt under every grader.
  if (cell.output.kind === "timed-out") return undefined;
  return currentCellGrade(campaign, cell, task) ? undefined : "task grader changed (--regrade grades it with the current grader)";
}

/** Why a cell no longer answers its corpus task: the task left the corpus, or it changed in a way that no current
 *  grade covers. Undefined while the cell is current. */
export function staleTask(cell: CellLine, campaign: CampaignRecords, corpus: RankingCorpus | undefined): string | undefined {
  const task = corpus?.tasks.find(({ id }) => id === cell.task);
  return task ? taskChange(campaign, cell, task) : "task removed from corpus";
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
  if (cell.output.kind === "timed-out") return { corpus, task, model, effort, score: undefined };
  const scores = campaign.scores.filter((line) => sameJudge(line.judge, judge) && line.scorer === recordScorer(campaign.header.mode) && line.score.variant === cell.variant && line.score.task === cell.task && line.score.repeat === cell.repeat);
  const score = scores.find((line) => line.scoringVersion === version);
  const grade = currentCellGrade(campaign, cell, task);
  if (score) return { corpus, task, model, effort, score, ...(grade === undefined ? {} : { grade }) };
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

/** The core quality of one implementer cell, from 0 to 1: a timed-out cell passed no check (ARCH-DIRECTORIES-024). */
export function cellQuality({ cell, grade }: PooledCell): number {
  if (cell.output.kind === "timed-out") return 0;
  if (!grade) throw new Error("An implement corpus holds a non-implementation cell");
  return checkQuality(grade);
}

/** The pooled cells of one corpus of a role. */
export interface CorpusPool {
  readonly corpus: RankingCorpus;
  readonly cells: PooledCell[];
}

/** The cells of a role that pool under its judge, by corpus in persona order, with what did not pool and the other
 *  judges' score counts. The judge is `input.judge`, or the default judge of the role. */
export function poolRoleCells(role: string, campaigns: readonly CampaignRecords[], input: RankingInput) {
  const judge = input.judge ?? defaultJudge(role, campaigns, input);
  const notPooledCounts = new Map<string, NotPooled>();
  const pooled = new Map<string, CorpusPool>();
  const otherJudges = new Map<string, number>();
  for (const campaign of campaigns) {
    const { persona, mode } = campaign.header;
    const corpus = input.corpora.get(persona);
    const version = input.scoringVersion(mode);
    // Without a chosen judge, each campaign's own judge states why its cells do not pool.
    const cellJudge = judge ?? campaign.header.judge;
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
      pool.cells.push({ ...standing, campaign, cell, quality: qualityScoreOf(campaign, cell, cellJudge, input.qualityScoringVersion) });
      pooled.set(persona, pool);
    }
    for (const line of campaign.scores) {
      if (judge && !sameJudge(line.judge, judge)) otherJudges.set(judgeLabel(line.judge), (otherJudges.get(judgeLabel(line.judge)) ?? 0) + 1);
    }
  }
  return {
    judge,
    pools: [...pooled.values()].sort((a, b) => byCodeUnit(a.corpus.persona, b.corpus.persona)),
    notPooled: [...notPooledCounts.values()],
    otherJudges,
  };
}
