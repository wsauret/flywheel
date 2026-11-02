/** Wilson score interval for a binomial success count. No trials means no estimate. */
export function wilson95(successes: number, trials: number): readonly [number, number] | null {
  if (trials === 0) return null;
  const z = 1.959963984540054;
  const rate = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = (rate + z * z / (2 * trials)) / denominator;
  const radius = z * Math.sqrt(rate * (1 - rate) / trials + z * z / (4 * trials * trials)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Student t 0.95 quantiles for 1 to 30 degrees of freedom. */
const T_95 = [6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.74, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
const Z_95 = 1.6448536;

/** The 0.95 quantile of Student's t. Above 30 degrees of freedom, the
 *  Cornish-Fisher expansion matches the table to three decimals. */
export function tQuantile95(degrees: number): number {
  if (degrees <= T_95.length) return T_95[degrees - 1]!;
  const z = Z_95;
  return z + (z ** 3 + z) / (4 * degrees) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * degrees ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * degrees ** 3);
}

/** Percentile interval over tasks, not trials. A fixed PRNG makes an offline report reproducible.
 * Each input is one paired task-level effect; unknown effects must stay outside this sample. */
export function taskBootstrap95(differences: readonly number[]) {
  if (!differences.length) return null;
  const seed = new Uint32Array([0x43504e]);
  const samples = Array.from({ length: 10_000 }, () => {
    let sum = 0;
    for (let i = 0; i < differences.length; i++) {
      seed[0] = Math.imul(1664525, seed[0]!) + 1013904223;
      sum += differences[Math.floor(seed[0]! / 0x100000000 * differences.length)]!;
    }
    return sum / differences.length;
  }).sort((a, b) => a - b);
  return { tasks: differences.length, mean: mean(differences)!, interval: [samples[249]!, samples[9749]!] as const };
}
