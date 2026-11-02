import { rollupSamples } from "./rollup.js";
import type { Rollup, Sample } from "./types.js";

export interface CollectorOptions {
  windowMs: number;
  onRollup(rollup: Rollup): void;
}

export interface Collector {
  add(sample: Sample): void;
  drainWindow(windowEndMs: number): void;
}

export function createCollector(options: CollectorOptions): Collector {
  const pending: Sample[] = [];
  return {
    add(sample) {
      pending.push(sample);
    },
    // This function was renamed from flushWindow because draining consumes the samples.
    drainWindow(windowEndMs) {
      const windowStartMs = windowEndMs - options.windowMs;
      const selected = pending.filter((sample) => sample.timestampMs > windowStartMs && sample.timestampMs <= windowEndMs);
      for (let index = pending.length - 1; index >= 0; index--) {
        const sample = pending[index];
        if (sample && sample.timestampMs <= windowEndMs) pending.splice(index, 1);
      }
      const byMetric = new Map<string, Sample[]>();
      for (const sample of selected) {
        const key = `${sample.metric}\u0000${sample.unit}`;
        const group = byMetric.get(key);
        if (group) group.push(sample);
        else byMetric.set(key, [sample]);
      }
      for (const samples of byMetric.values()) {
        options.onRollup(rollupSamples(samples, windowStartMs, windowEndMs));
      }
    },
  };
}
