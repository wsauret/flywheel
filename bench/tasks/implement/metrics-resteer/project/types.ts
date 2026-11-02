export type MetricUnit = "ms" | "s" | "count";

export interface Sample {
  metric: string;
  timestampMs: number;
  value: number;
  unit: MetricUnit;
}

export interface Rollup {
  metric: string;
  windowStartMs: number;
  windowEndMs: number;
  count: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  unit: MetricUnit;
}
