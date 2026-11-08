import type { BoardInputs } from "./board-data.js";
import type { BoardCell } from "./board-scoring.js";
import { fitProjection, leaveOneOut, type ProjectionFit } from "./projection.js";
import { PythonRandom } from "./python-random.js";
import { calibrationUnits } from "./round-score.js";

/** Subset selection from the board's per-task results, the method of the
 *  earlier Terminal-Bench subset: pool the board's full-stage tasks without
 *  its exclusions and without tasks on which every unit scores the same;
 *  split the subset's size over the board's strata in proportion to their
 *  pool counts; cut each stratum, sorted by the units' mean pass rate, into
 *  one band per slot; keep each band's quieter half by run-to-run noise; and
 *  take one task per band, the cheapest list among those whose fit to the
 *  full scores is equal to the best. Holdouts repeat the method on the tasks
 *  that earlier lists did not take. */

interface TaskStats {
  /** The mean over units of the unit's pass rate. */
  readonly field: number;
  /** The population standard deviation of those pass rates. */
  readonly spread: number;
  /** The mean over units of sqrt(p (1 - p)), the run-to-run noise of one attempt. */
  readonly noise: number;
  /** Agent seconds over the pool median plus cost over the pool median: the cheaper, the lower. */
  readonly cost: number;
  readonly stratum: string;
}

interface SubsetFit {
  readonly tasks: readonly string[];
  readonly mae: number;
  readonly maxError: number;
  readonly pearson: number;
  /** The share of random subsets of the same size from the pool whose MAE is no lower. */
  readonly beatsRandom: number;
  readonly fit: ProjectionFit;
  readonly looCovered: number;
}

export interface SubsetProposal {
  readonly pool: number;
  readonly units: number;
  readonly lists: readonly { readonly name: string; readonly report: SubsetFit }[];
}

const RANDOM_DRAWS = 2000;
const RANDOM_SEED = 7;

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function fullCells(cells: Iterable<BoardCell>): BoardCell[] {
  return [...cells].filter((cell) => cell.setup.stage === "full" && cell.rate !== null);
}

/** The statistics of each pooled task over the board's full-stage units. */
function taskStats(board: BoardInputs, cells: readonly BoardCell[]): Map<string, TaskStats> {
  const spec = board.config.benchmarks[board.benchmark]!;
  const full = spec.subsets.full ?? [];
  const excluded = new Set(spec.excluded);
  const raw = new Map<string, { rates: number[]; seconds: number[]; cost: number[] }>();
  for (const task of full) {
    if (excluded.has(task)) continue;
    const entry: { rates: number[]; seconds: number[]; cost: number[] } = { rates: [], seconds: [], cost: [] };
    for (const cell of cells) {
      const counts = cell.tally.get(task);
      if (counts !== undefined) entry.rates.push(counts[0] / counts[1]);
      const cost = cell.taskCost.get(task);
      if (cost?.agentSeconds !== null && cost?.agentSeconds !== undefined) entry.seconds.push(cost.agentSeconds);
      if (cost !== undefined) entry.cost.push(cost.costUsd);
    }
    if (entry.rates.length > 0 && entry.seconds.length > 0) raw.set(task, entry);
  }
  const medianSeconds = new Map([...raw].map(([task, entry]) => [task, median(entry.seconds)]));
  const medianCost = new Map([...raw].map(([task, entry]) => [task, median(entry.cost)]));
  const poolSeconds = median([...medianSeconds.values()]);
  const poolCost = median([...medianCost.values()]);
  const stats = new Map<string, TaskStats>();
  for (const [task, entry] of raw) {
    const field = mean(entry.rates);
    const spread = Math.sqrt(mean(entry.rates.map((rate) => (rate - field) ** 2)));
    if (spread === 0) continue;
    stats.set(task, {
      field,
      spread,
      noise: mean(entry.rates.map((rate) => Math.sqrt(rate * (1 - rate)))),
      cost: medianSeconds.get(task)! / poolSeconds + (poolCost === 0 ? 0 : medianCost.get(task)! / poolCost),
      stratum: spec.taskStrata[task] ?? "all",
    });
  }
  return stats;
}

/** Splits `size` slots over the strata in proportion to their task counts,
 *  the largest remainders taking the leftover slots (stratum name breaks ties). */
function allocate(counts: ReadonlyMap<string, number>, size: number): Map<string, number> {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const shares = [...counts].map(([stratum, count]) => ({ stratum, exact: (size * count) / total, count }));
  const allocation = new Map(shares.map((share) => [share.stratum, Math.min(share.count, Math.floor(share.exact))]));
  let left = size - [...allocation.values()].reduce((sum, value) => sum + value, 0);
  for (const share of [...shares].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.stratum.localeCompare(b.stratum))) {
    if (left === 0) break;
    if (allocation.get(share.stratum)! < share.count) {
      allocation.set(share.stratum, allocation.get(share.stratum)! + 1);
      left -= 1;
    }
  }
  return allocation;
}

/** The bands of a pool for a list of `size` tasks: the size split over the
 *  strata, and each stratum, sorted by field rate, cut into one band per
 *  slot. Each band holds its quieter half by run-to-run noise. */
function quietBands(stats: ReadonlyMap<string, TaskStats>, pool: readonly string[], size: number): string[][] {
  if (size > pool.length) throw new Error(`a list of ${size} tasks needs a pool of at least ${size}; ${pool.length} are left`);
  const byStratum = new Map<string, string[]>();
  for (const task of pool) byStratum.set(stats.get(task)!.stratum, [...(byStratum.get(stats.get(task)!.stratum) ?? []), task]);
  const allocation = allocate(new Map([...byStratum].map(([stratum, tasks]) => [stratum, tasks.length])), size);
  const bands: string[][] = [];
  for (const [stratum, tasks] of [...byStratum].sort(([left], [right]) => left.localeCompare(right))) {
    const slots = allocation.get(stratum) ?? 0;
    const order = [...tasks].sort((left, right) => stats.get(left)!.field - stats.get(right)!.field || left.localeCompare(right));
    for (let band = 0; band < slots; band++) {
      const members = order.slice(Math.floor((band * order.length) / slots), Math.floor(((band + 1) * order.length) / slots));
      bands.push([...members].sort((left, right) => stats.get(left)!.noise - stats.get(right)!.noise || left.localeCompare(right)).slice(0, Math.max(1, Math.ceil(members.length / 2))));
    }
  }
  return bands;
}

/** Fits within this many points of MAE count as equal, and the cheaper list wins. */
const EQUAL_FIT = 0.01;
const CANDIDATE_DRAWS = 2000;
const CANDIDATE_SEED = 20261108;

/** One list of `size` tasks from `pool`: one task from each quiet band. Of
 *  the cheapest such list and seeded random draws of one task per band, the
 *  lists whose MAE against the units' full scores is within EQUAL_FIT of the
 *  best count as equal fits, and the cheapest of them wins. */
function selectTasks(stats: ReadonlyMap<string, TaskStats>, cells: readonly BoardCell[], pool: readonly string[], size: number): string[] {
  const bands = quietBands(stats, pool, size);
  const cost = (tasks: readonly string[]): number => tasks.reduce((sum, task) => sum + stats.get(task)!.cost, 0);
  const cheapest = bands.map((band) => [...band].sort((left, right) => stats.get(left)!.cost - stats.get(right)!.cost || left.localeCompare(right))[0]!);
  const random = new PythonRandom(CANDIDATE_SEED);
  const candidates = [cheapest, ...Array.from({ length: CANDIDATE_DRAWS }, () => bands.map((band) => band[Math.floor(random.random() * band.length)]!))];
  const scored = candidates.map((tasks) => ({ tasks, mae: maeOf(cells, tasks), cost: cost(tasks) }));
  const best = Math.min(...scored.map((candidate) => candidate.mae));
  return scored.filter((candidate) => candidate.mae <= best + EQUAL_FIT).sort((left, right) => left.cost - right.cost || left.mae - right.mae)[0]!.tasks;
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  const sxy = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index]! - my), 0);
  return sxy / Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) * ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
}

function maeOf(cells: readonly BoardCell[], tasks: readonly string[]): number {
  return mean(calibrationUnits(cells, tasks).map((unit) => Math.abs(unit.subset - unit.full)));
}

/** How well a list tracks the full score over the board's units. */
function subsetFit(cells: readonly BoardCell[], pool: readonly string[], tasks: readonly string[]): SubsetFit {
  const units = calibrationUnits(cells, tasks);
  const errors = units.map((unit) => unit.subset - unit.full);
  const mae = mean(errors.map(Math.abs));
  const random = new PythonRandom(RANDOM_SEED);
  let notBetter = 0;
  for (let draw = 0; draw < RANDOM_DRAWS; draw++) {
    const shuffled = [...pool];
    for (let index = 0; index < tasks.length; index++) {
      const swap = index + Math.floor(random.random() * (shuffled.length - index));
      [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    if (maeOf(cells, shuffled.slice(0, tasks.length)) >= mae) notBetter += 1;
  }
  return {
    tasks,
    mae,
    maxError: Math.max(...errors.map(Math.abs)),
    pearson: pearson(units.map((unit) => unit.subset), units.map((unit) => unit.full)),
    beatsRandom: notBetter / RANDOM_DRAWS,
    fit: fitProjection(units),
    looCovered: leaveOneOut(units).covered,
  };
}

/** Proposes a `subset` of `size` tasks and one holdout list for each entry
 *  of `holdouts`, disjoint, from the board's public full-stage cells. */
export function proposeSubset(board: BoardInputs, cells: Iterable<BoardCell>, size: number, holdouts: readonly number[]): SubsetProposal {
  const full = fullCells(cells);
  const stats = taskStats(board, full);
  const pool = [...stats.keys()].sort();
  const lists: { name: string; report: SubsetFit }[] = [];
  let left = pool;
  for (const [index, count] of [size, ...holdouts].entries()) {
    const tasks = selectTasks(stats, full, left, count);
    lists.push({ name: index === 0 ? "subset" : index === 1 ? "holdout" : `holdout${index}`, report: subsetFit(full, pool, tasks) });
    const taken = new Set(tasks);
    left = left.filter((task) => !taken.has(task));
  }
  return { pool: pool.length, units: full.length, lists };
}
