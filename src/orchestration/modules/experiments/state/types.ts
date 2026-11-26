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

export interface ExperimentRun {
  segment: number;
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

/** The analysis of the recorded runs, advanced one fact at a time. */
export interface ExperimentState {
  bestDirection: MetricDirection;
  currentSegment: number;
  /** Every run in recording order. A new run replaces the array, so a
   *  snapshot that holds it keeps the runs it was taken with. */
  results: readonly ExperimentRun[];
  /** The runs of each segment, which the analysis of one segment reads. */
  readonly segmentRuns: Map<number, ExperimentRun[]>;
  secondaryMetrics: readonly ExperimentMetric[];
  baselineMetric: number | null;
  bestMetric: number | null;
  confidence: number | null;
}
