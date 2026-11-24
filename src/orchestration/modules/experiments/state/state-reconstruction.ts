import { computeConfidence, findBestMetric } from "./result-analysis.js";
import type {
  ExperimentMetric,
  ExperimentMetricValues,
  ExperimentRun,
  ExperimentState,
  MetricDirection,
} from "./types.js";

function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function withSecondaryMetrics(
  known: readonly ExperimentMetric[],
  metrics: ExperimentMetricValues,
): readonly ExperimentMetric[] {
  const added = Object.keys(metrics).filter((name) => !known.some((metric) => metric.name === name));
  return added.length === 0 ? known : [...known, ...added.map((name) => ({ name, unit: inferMetricUnit(name) }))];
}

export function emptyExperimentState(): ExperimentState {
  return {
    bestDirection: "lower",
    currentSegment: 0,
    results: [],
    segmentRuns: new Map(),
    secondaryMetrics: [],
    baselineMetric: null,
    bestMetric: null,
    confidence: null,
  };
}

/** Starts the analysis of an initialized segment: its secondary metrics,
 *  baseline, best, and confidence stay empty until its next run. */
export function startExperimentSegment(state: ExperimentState, segment: number, direction: MetricDirection): void {
  state.currentSegment = segment;
  state.bestDirection = direction;
  state.secondaryMetrics = [];
  state.baselineMetric = null;
  state.bestMetric = null;
  state.confidence = null;
}

/** Adds one strictly decoded run and analyses the current segment again,
 *  once, from the runs of that segment only. */
export function recordExperimentRun(state: ExperimentState, run: ExperimentRun): void {
  state.results = [...state.results, run];
  const segmentRuns = state.segmentRuns.get(run.segment);
  if (segmentRuns) segmentRuns.push(run);
  else state.segmentRuns.set(run.segment, [run]);
  state.secondaryMetrics = withSecondaryMetrics(state.secondaryMetrics, run.metrics);
  const current = state.segmentRuns.get(state.currentSegment) ?? [];
  state.baselineMetric = current[0]?.metric ?? null;
  state.bestMetric = findBestMetric(current, state.currentSegment, state.bestDirection);
  state.confidence = computeConfidence(current, state.currentSegment, state.bestDirection);
}
