export type MetricDirection = "lower" | "higher";

type ExperimentRunStatus = "keep" | "discard" | "crash" | "checks_failed";

export interface ExperimentMetric {
  name: string;
  unit: string;
}

/** Metric values keyed by metric name, as the measure command reported them. */
export interface ExperimentMetricValues {
  readonly [name: string]: number;
}

/** Actionable side information: free-form diagnostics recorded with one run. */
export interface ExperimentSideInformation {
  readonly [key: string]: unknown;
}

export interface ExperimentRunValue {
  run: number;
  commit: string;
  metric: number;
  metrics: ExperimentMetricValues;
  status: ExperimentRunStatus;
  description: string;
  timestamp: number;
  confidence: number | null;
  durationMs: number | null;
  asi?: ExperimentSideInformation;
}

export interface ExperimentRun extends ExperimentRunValue {
  segment: number;
}

interface ExperimentInitializedValue {
  segment: number;
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: MetricDirection;
}

export type ExperimentStateEntry =
  | { type: "initialized"; value: ExperimentInitializedValue }
  | { type: "run"; value: ExperimentRun };

export interface ExperimentState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: MetricDirection;
  currentSegment: number;
  results: ExperimentRun[];
  secondaryMetrics: ExperimentMetric[];
  baselineMetric: number | null;
  bestMetric: number | null;
  confidence: number | null;
}
