// The confidence of a benchmark ranking (ARCH-DIRECTORIES-025): a seeded bootstrap draws the same resamples on
// every clone, so a results page stays byte-stable, and the default that a ranking names rests on a quality lead
// that holds in at least LEAD_CONFIDENCE of the resamples.

/** Resamples per ranking: enough for stable 5% and 95% bounds, few enough to regenerate every page in seconds. */
export const BOOTSTRAP_RESAMPLES = 1000;
const BOOTSTRAP_SEED = 0x5eed_2026;
/** The share of resamples in which a quality lead must hold. */
const LEAD_CONFIDENCE = 0.9;

/** A deterministic generator of uniform numbers in [0, 1) (mulberry32), seeded once per ranking. */
export function bootstrapRandom(): () => number {
  let state = BOOTSTRAP_SEED;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** As many items as `items` holds, each drawn from it with replacement. */
export function resample<T>(items: readonly T[], random: () => number): T[] {
  // SAFETY: the index is below items.length, because random() is below 1.
  return items.map(() => items[Math.floor(random() * items.length)]!);
}

/** The 5% and 95% bounds of a measure over the resamples, each the nearest-rank value. */
export interface Interval {
  readonly low: number;
  readonly high: number;
}

export function interval(samples: readonly number[]): Interval {
  const sorted = [...samples].sort((a, b) => a - b);
  // SAFETY: both indexes lie in 0 to length - 1 of a nonempty sample list.
  const at = (fraction: number) => sorted[Math.round(fraction * (sorted.length - 1))]!;
  return { low: at(0.05), high: at(0.95) };
}

/** The share of resamples in which `holds` is true. */
export function share(resamples: number, holds: (resample: number) => boolean): number {
  let count = 0;
  for (let index = 0; index < resamples; index++) if (holds(index)) count++;
  return count / resamples;
}

/** A passing setting that the default naming weighs, with its quality in each resample. */
export interface NamingCandidate {
  readonly setting: string;
  readonly quality: number;
  readonly qualitySamples: readonly number[];
}

/** The setting that a ranking names for its role, and why. `lead`: the top scorer's quality exceeds every other
 *  passing setting's quality in `share` of the resamples. `tied`: no such lead holds, so it is the top scorer of the
 *  settings that `leader`, the top-quality setting, does not outscore on quality in LEAD_CONFIDENCE of the resamples. */
export type DefaultNaming =
  | { readonly kind: "lead"; readonly setting: string; readonly share: number }
  | { readonly kind: "tied"; readonly setting: string; readonly leader: string; readonly tied: readonly string[] };

/** Name the default among `passing`, which lists the passing settings in descending point score; undefined when
 *  none passes. */
export function nameDefault(passing: readonly NamingCandidate[]): DefaultNaming | undefined {
  const [top, ...others] = passing;
  if (!top) return undefined;
  const resamples = top.qualitySamples.length;
  const beats = (a: NamingCandidate, b: NamingCandidate) => share(resamples, (index) => (a.qualitySamples[index] ?? 0) > (b.qualitySamples[index] ?? 0));
  const lead = share(resamples, (index) => others.every((other) => (top.qualitySamples[index] ?? 0) > (other.qualitySamples[index] ?? 0)));
  if (others.length === 0 || lead >= LEAD_CONFIDENCE) return { kind: "lead", setting: top.setting, share: others.length === 0 ? 1 : lead };
  // The first of the highest point quality is the higher scorer of a quality tie.
  const leader = passing.reduce((best, candidate) => candidate.quality > best.quality ? candidate : best);
  const tied = passing.filter((candidate) => candidate === leader || beats(leader, candidate) < LEAD_CONFIDENCE);
  // SAFETY: `tied` holds the leader, and it keeps the descending score order of `passing`.
  return { kind: "tied", setting: tied[0]!.setting, leader: leader.setting, tied: tied.map(({ setting }) => setting) };
}
