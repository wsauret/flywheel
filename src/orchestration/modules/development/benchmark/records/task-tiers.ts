import type { TaskTier } from "../catalog.js";
import type { RecordJudge } from "./benchmark-records.js";
import { byCodeUnit, cellQuality, poolRoleCells, type RankingInput } from "./ranking-pool.js";

// The committed rule that decides each implementer task's tier from its pilot results (ARCH-DIRECTORIES-022). A
// ranked task separates settings: its mean core quality lies inside the band, and its settings differ by more than
// the noise of their repeats. A floor task almost every setting passes, so it only checks. Every other task is
// "drop": it neither separates settings nor checks a floor, and `bench:tiers` reports it.

/** The band of mean core quality, across settings, that a ranked task lies in. */
const RANKED_BAND = { low: 0.15, high: 0.9 } as const;
/** How many times the noise of a setting mean the variance between setting means must reach. */
const SIGNAL_TO_NOISE = 2;

type TierRuleResult = TaskTier | "drop";

export interface TaskTierMeasures {
  /** Settings with at least one pooled cell of the task. */
  readonly settings: number;
  /** The mean over settings of each setting's mean core quality over its repeats, from 0 to 1. */
  readonly mean: number;
  /** The sample variance of the setting means; undefined with fewer than two settings. */
  readonly between: number | undefined;
  /** The noise of a setting mean: the mean, over settings with at least two repeats, of the sample variance of
   *  their repeats divided by their repeat count. Undefined when no setting has two repeats. */
  readonly noise: number | undefined;
  readonly rule: TierRuleResult;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  const center = mean(values);
  return values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1);
}

/** The tier rule over one task: `repeatsBySetting` holds each setting's core qualities, from 0 to 1, one per pooled
 *  repeat. A task is floor when its mean is above the band, ranked when its mean lies inside the band and the variance
 *  between setting means is at least SIGNAL_TO_NOISE times the noise of a setting mean, and drop otherwise. */
export function taskTierRule(repeatsBySetting: readonly (readonly number[])[]): TaskTierMeasures {
  const repeats = repeatsBySetting.filter((values) => values.length > 0);
  const means = repeats.map(mean);
  const center = mean(means);
  const between = means.length >= 2 ? sampleVariance(means) : undefined;
  const noisy = repeats.filter((values) => values.length >= 2);
  const noise = noisy.length > 0 ? mean(noisy.map((values) => sampleVariance(values) / values.length)) : undefined;
  // A mean of shares can miss an exact bound by rounding error.
  const epsilon = 1e-9;
  const rule: TierRuleResult = means.length === 0 ? "drop"
    : center > RANKED_BAND.high + epsilon ? "floor"
    : center >= RANKED_BAND.low - epsilon && between !== undefined && noise !== undefined && between >= SIGNAL_TO_NOISE * noise - epsilon ? "ranked"
    : "drop";
  return { settings: means.length, mean: center, between, noise, rule };
}

export interface TaskTierRow extends TaskTierMeasures {
  readonly task: string;
  /** The tier that the corpus commits, or undefined when it commits none. */
  readonly committed: TaskTier | undefined;
}

/** The tier rule over each task of every implementer corpus, from the cells that pool under the judge of the
 *  implementer ranking (`input.judge`, or the role's default judge) and the current grader. */
export function implementerTaskTiers(input: RankingInput): { readonly role: string; readonly judge: RecordJudge | undefined; readonly rows: readonly TaskTierRow[] }[] {
  const byRole = new Map<string, typeof input.campaigns[number][]>();
  for (const campaign of input.campaigns) {
    const role = input.roleOf(campaign.header.persona);
    if (campaign.header.mode !== "implement" || role === undefined) continue;
    byRole.set(role, [...byRole.get(role) ?? [], campaign]);
  }
  return [...byRole].sort(([a], [b]) => byCodeUnit(a, b)).map(([role, campaigns]) => {
    const { judge, pools } = poolRoleCells(role, campaigns, input);
    const rows = pools.flatMap(({ corpus, cells }) => corpus.tasks.filter(({ opportunities }) => opportunities !== undefined).map((task): TaskTierRow => {
      const bySetting = new Map<string, number[]>();
      for (const pooled of cells.filter(({ cell }) => cell.task === task.id)) bySetting.set(pooled.cell.variant, [...bySetting.get(pooled.cell.variant) ?? [], cellQuality(pooled)]);
      return { task: task.id, committed: task.tier, ...taskTierRule([...bySetting.values()]) };
    }));
    return { role, judge, rows };
  });
}
