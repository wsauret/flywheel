import { computePercentiles } from "./percentiles.js";
import type { Rollup, Sample } from "./types.js";

export function rollupSamples(samples: readonly Sample[], windowStartMs: number, windowEndMs: number): Rollup {
  const first = samples[0];
  if (!first) throw new Error("Cannot roll up an empty window");
  if (samples.some((sample) => sample.metric !== first.metric || sample.unit !== first.unit)) {
    throw new Error("A rollup window must contain one metric and unit");
  }
  const values = samples.map((sample) => sample.value);
  const percentiles = computePercentiles(values);
  return {
    metric: first.metric,
    windowStartMs,
    windowEndMs,
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    ...percentiles,
    unit: first.unit,
  };
}
