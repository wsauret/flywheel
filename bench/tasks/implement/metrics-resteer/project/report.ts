import { createReader } from "./reader.js";
import type { Rollup } from "./types.js";
import { UNIT_NORMALIZERS } from "./units.js";

export const RETENTION_MS = 60_000;

export interface MetricReport {
  metric: string;
  count: number;
  p95: number;
}

export interface ReportSource {
  report(metric: string, nowMs: number): MetricReport | undefined;
}

export function createReportSource(readRollups: () => readonly Rollup[]): ReportSource {
  const reader = createReader({ readRollups, retentionMs: RETENTION_MS });
  return {
    report(metric, nowMs) {
      const rollup = reader.latest(metric, nowMs);
      if (!rollup) return undefined;
      return {
        metric,
        count: rollup.count,
        p95: UNIT_NORMALIZERS[rollup.unit](rollup.p95),
      };
    },
  };
}
