export interface Percentiles {
  p50: number;
  p95: number;
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("Cannot compute a percentile of an empty collection");
  return value;
}

export function computePercentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
  };
}
