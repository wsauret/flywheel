import type { HarborBenchmark } from "../benchmarks.js";
import type { BoardInputs } from "./board-data.js";
import { pairedDiff, publicCells, publishedLeader, setupKey, type BoardCell } from "./board-scoring.js";
import { fitProjection, leaveOneOut, project, type CalibrationUnit, type Projection, type ProjectionFit } from "./projection.js";
import type { RoundTrial } from "./round-trials.js";

/** The split whose score projects to the full benchmark. */
export const PROJECTED_SPLIT = "subset";

interface SplitScore {
  readonly split: string;
  readonly tasks: number;
  /** The mean over the split's tasks of each task's pass rate; a task with no scored attempt counts 0. */
  readonly score: number;
  /** The same mean over the tasks with a scored attempt only. */
  readonly scoredScore: number | null;
  readonly scoredTasks: number;
  /** `score` without the benchmark's hub-broken tasks, which no agent can pass on Harbor Hub. */
  readonly withoutHubBroken: number;
  readonly hubBrokenTasks: number;
}

export interface RoundScore {
  /** Per task: passed and scored attempts, over every run of the round. */
  readonly tasks: ReadonlyMap<string, readonly [number, number]>;
  readonly splits: readonly SplitScore[];
  readonly costUsd: number;
  readonly infra: number;
  readonly graderLost: number;
  /** Passing trials that a confirmed answer-key verdict turned into fails. */
  readonly answerKeyFails: number;
}

/** Scores a round with the board's rules: a scored trial passes iff its
 *  reward is at least 1 and no confirmed answer-key verdict names it;
 *  infrastructure and grader-lost trials are not scored; every scored
 *  attempt of every run pools into its task. Each measured split, such as
 *  `measuredSplits` reads, gets a score over its tasks. */
export function scoreRound(benchmark: HarborBenchmark, trials: readonly RoundTrial[], confirmed: ReadonlySet<string>, measured: ReadonlyMap<string, readonly string[]>): RoundScore {
  const tasks = new Map<string, [number, number]>();
  let costUsd = 0;
  let infra = 0;
  let graderLost = 0;
  let answerKeyFails = 0;
  for (const trial of trials) {
    costUsd += trial.cost;
    if (trial.standing === "infra") infra += 1;
    if (trial.standing === "grader_lost") graderLost += 1;
    if (trial.standing !== "scored") continue;
    const rewarded = (trial.reward ?? 0) >= 1;
    if (rewarded && confirmed.has(trial.id)) answerKeyFails += 1;
    const [passed, total] = tasks.get(trial.task) ?? [0, 0];
    tasks.set(trial.task, [passed + (rewarded && !confirmed.has(trial.id) ? 1 : 0), total + 1]);
  }
  const broken = new Set(benchmark.hubBroken.map((entry) => entry.task));
  const rate = (task: string): number | undefined => {
    const counts = tasks.get(task);
    return counts === undefined ? undefined : counts[0] / counts[1];
  };
  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  const splits = [...measured].map(([split, list]): SplitScore => {
    const scored = list.flatMap((task) => rate(task) ?? []);
    const working = list.filter((task) => !broken.has(task));
    return {
      split,
      tasks: list.length,
      score: mean(list.map((task) => rate(task) ?? 0)),
      scoredScore: scored.length === 0 ? null : mean(scored),
      scoredTasks: scored.length,
      withoutHubBroken: mean(working.map((task) => rate(task) ?? 0)),
      hubBrokenTasks: list.length - working.length,
    };
  });
  return { tasks, splits, costUsd, infra, graderLost, answerKeyFails };
}

/** The board's view of a round's setup: the model and effort whose cells it compares with. */
export interface BoardSetupChoice { readonly model: string; readonly effort: string }

export interface BoardComparison {
  /** The projection of the round's subset score, when the round measured the subset split. */
  readonly projection?: { readonly fit: ProjectionFit; readonly looCovered: number; readonly looRmse: number; readonly projected: Projection };
  readonly setup: BoardSetupChoice;
  /** Every harness that the board scores at the round's model and effort on the full stage, best rate first. */
  readonly field: readonly { readonly harness: string; readonly rate: number | null; readonly ci: readonly [number, number] | null }[];
  /** The board's leader of that setup and the paired difference on the tasks both scored, when the board ranks the setup. */
  readonly leader?: { readonly harness: string; readonly rate: number | null; readonly diff: ReturnType<typeof pairedDiff> };
}

/** The calibration units of a benchmark's projection: every public full-stage
 *  cell, with its subset score as the mean pass rate over the subset tasks it scored. */
export function calibrationUnits(cells: Iterable<BoardCell>, subset: readonly string[]): CalibrationUnit[] {
  const units: CalibrationUnit[] = [];
  for (const cell of cells) {
    if (cell.setup.stage !== "full" || cell.rate === null) continue;
    const rates = subset.flatMap((task) => {
      const counts = cell.tally.get(task);
      return counts === undefined ? [] : [counts[0] / counts[1]];
    });
    if (rates.length === 0) continue;
    units.push({ label: `${cell.setup.model} ${cell.setup.effort} ${cell.setup.harness}`, subset: rates.reduce((sum, value) => sum + value, 0) / rates.length, full: cell.rate });
  }
  return units;
}

/** Compares a round with the board at the round's model and effort: the
 *  board's field of harnesses, the paired per-task difference with its
 *  leader, and, when the round measured the subset split, the projection of
 *  that score to the full benchmark with a fit over the board's units. */
export function compareWithBoard(benchmark: HarborBenchmark, score: RoundScore, board: BoardInputs, setup: BoardSetupChoice): BoardComparison {
  const cells = publicCells(board);
  const subset = benchmark.splits[PROJECTED_SPLIT];
  const subsetScore = score.splits.find((split) => split.split === PROJECTED_SPLIT);
  const leader = publishedLeader(board, setup.model, setup.effort);
  const leaderCell = leader === undefined ? undefined : cells.get(setupKey({ model: setup.model, stage: "full", effort: setup.effort, harness: leader }));
  const field = [...cells.values()]
    .filter((cell) => cell.setup.model === setup.model && cell.setup.effort === setup.effort && cell.setup.stage === "full")
    .map((cell) => ({ harness: cell.setup.harness, rate: cell.rate, ci: cell.ci }))
    .sort((left, right) => (right.rate ?? -1) - (left.rate ?? -1));
  let projection: BoardComparison["projection"];
  if (subset !== undefined && subsetScore !== undefined) {
    const units = calibrationUnits(cells.values(), subset);
    const fit = fitProjection(units);
    const loo = leaveOneOut(units);
    projection = { fit, looCovered: loo.covered, looRmse: loo.rmse, projected: project(fit, subsetScore.score) };
  }
  return {
    ...(projection === undefined ? {} : { projection }),
    setup,
    field,
    ...(leader === undefined || leaderCell === undefined ? {} : { leader: { harness: leader, rate: leaderCell.rate, diff: pairedDiff(board.benchmark, score.tasks, leaderCell.tally) } }),
  };
}

/** The board model that a run's model name names: the board model id whose
 *  last path segment equals it, ignoring case. */
export function boardModel(board: BoardInputs, model: string): string | undefined {
  return Object.keys(board.config.models).find((id) => id.split("/").at(-1)!.toLowerCase() === model.toLowerCase());
}
