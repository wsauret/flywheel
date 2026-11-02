import type { Rollup } from "./types.js";

export interface ReaderOptions {
  readRollups(): readonly Rollup[];
  retentionMs: number;
}

export interface MetricsReader {
  latest(metric: string, nowMs: number): Rollup | undefined;
}

export function createReader(options: ReaderOptions): MetricsReader {
  return {
    latest(metric, nowMs) {
      const cutoffMs = nowMs - options.retentionMs;
      return options.readRollups()
        .filter((rollup) => rollup.metric === metric && rollup.windowEndMs >= cutoffMs)
        .sort((left, right) => right.windowEndMs - left.windowEndMs)[0];
    },
  };
}
