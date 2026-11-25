import type { ExperimentRun, MetricDirection } from "./types.js";

function isBetter(current: number, best: number, direction: MetricDirection): boolean {
  return direction === "lower" ? current < best : current > best;
}

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // SAFETY: values is non-empty, so mid and mid - 1 (only read for even lengths >= 2) are in range.
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function currentResults(results: ExperimentRun[], segment: number): ExperimentRun[] {
  return results.filter((result) => result.segment === segment);
}

export function findBaselineMetric(results: ExperimentRun[], segment: number): number | null {
  return currentResults(results, segment)[0]?.metric ?? null;
}

export function findBestMetric(
  results: ExperimentRun[],
  segment: number,
  direction: MetricDirection,
): number | null {
  const kept = currentResults(results, segment)
    .filter((result) => result.status === "keep")
    .map((result) => result.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

export function computeConfidence(
  results: ExperimentRun[],
  segment: number,
  direction: MetricDirection,
): number | null {
  const current = currentResults(results, segment).filter((result) => result.metric > 0);
  if (current.length < 3) return null;

  const values = current.map((result) => result.metric);
  const median = sortedMedian(values);
  const mad = sortedMedian(values.map((value) => Math.abs(value - median)));
  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const result of current) {
    if (
      result.status === "keep"
      && (bestKept === null || isBetter(result.metric, bestKept, direction))
    ) {
      bestKept = result.metric;
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  return Math.abs(bestKept - baseline) / mad;
}
