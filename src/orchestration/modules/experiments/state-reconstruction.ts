import { computeConfidence, findBaselineMetric, findBestMetric } from "./result-analysis.js";
import type {
  ExperimentMetric,
  ExperimentMetricValues,
  ExperimentRun,
  ExperimentState,
  ExperimentStateEntry,
} from "./types.js";

function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function registerSecondaryMetrics(
  secondaryMetrics: ExperimentMetric[],
  metrics: ExperimentMetricValues,
): void {
  for (const name of Object.keys(metrics)) {
    if (secondaryMetrics.some((metric) => metric.name === name)) continue;
    secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

function emptyExperimentState(): ExperimentState {
  return {
    name: null,
    metricName: "metric",
    metricUnit: "",
    bestDirection: "lower",
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
    baselineMetric: null,
    bestMetric: null,
    confidence: null,
  };
}

/**
 * Reconstructs the experiment view from strict, already decoded fact values.
 */
export function reconstructExperimentState(entries: ExperimentStateEntry[]): ExperimentState {
  const state = emptyExperimentState();

  for (const entry of entries) {
    if (entry.type === "initialized") {
      state.currentSegment = entry.value.segment;
      state.secondaryMetrics = [];
      state.name = entry.value.name;
      state.metricName = entry.value.metricName;
      state.metricUnit = entry.value.metricUnit;
      state.bestDirection = entry.value.bestDirection;
      state.baselineMetric = null;
      state.bestMetric = null;
      state.confidence = null;
      continue;
    }

    const result: ExperimentRun = {
      ...entry.value,
      metrics: { ...entry.value.metrics },
    };
    state.results.push(result);
    registerSecondaryMetrics(state.secondaryMetrics, result.metrics);
    state.baselineMetric = findBaselineMetric(state.results, state.currentSegment);
    state.bestMetric = findBestMetric(state.results, state.currentSegment, state.bestDirection);
    state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
  }

  return state;
}
