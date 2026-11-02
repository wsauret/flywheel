/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createCollector } from "./collector.js";
import { computePercentiles } from "./percentiles.js";
import { createReportSource } from "./report.js";
import type { Rollup } from "./types.js";

function sample(value: number, timestampMs: number) {
  return { metric: "latency", value, timestampMs, unit: "ms" as const };
}

describe("callback metrics pipeline", () => {
  test("computes percentiles for sorted input", () => {
    expect(computePercentiles([1, 2, 3, 4, 5])).toEqual({ p50: 3, p95: 5 });
  });

  test("collector handles samples that arrive out of timestamp order", () => {
    const rollups: Rollup[] = [];
    const collector = createCollector({ windowMs: 100, onRollup: (rollup) => rollups.push(rollup) });
    collector.add(sample(90, 90));
    collector.add(sample(10, 10));
    collector.add(sample(50, 50));
    collector.drainWindow(100);
    expect(rollups).toHaveLength(1);
  });

  test("report reads retained rollups and normalizes seconds", () => {
    const rollups: Rollup[] = [{
      metric: "latency",
      windowStartMs: 1_900,
      windowEndMs: 1_980,
      count: 2,
      min: 0.1,
      max: 0.2,
      p50: 0.1,
      p95: 0.2,
      unit: "s",
    }];
    expect(createReportSource(() => rollups).report("latency", 2_000)).toEqual({ metric: "latency", count: 2, p95: 200 });
  });
});
