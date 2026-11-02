import { describe, expect, test } from "bun:test";
import { createCollector } from "../collector.js";
import { computePercentiles } from "../percentiles.js";
import { createReportSource } from "../report.js";
import type { Rollup, Sample } from "../types.js";

// The baseline has no store module. Import it inside each dependent test so Bun reports every outcome.
function rollup(metric: string, windowEndMs: number, p95 = 10, unit: Rollup["unit"] = "ms"): Rollup {
  return {
    metric,
    windowStartMs: windowEndMs - 100,
    windowEndMs,
    count: 1,
    min: p95,
    max: p95,
    p50: p95,
    p95,
    unit,
  };
}

function sample(metric: string, timestampMs: number, value: number): Sample {
  return { metric, timestampMs, value, unit: "ms" };
}

describe("keyed store", () => {
  test("retains every rollup for a metric in append order and keeps metric keys independent", async () => {
    const { MetricsStore } = await import("../store.js");
    const store = new MetricsStore();
    const first = rollup("latency", 100, 11);
    const second = rollup("latency", 200, 22);
    const requests = rollup("requests", 300, 3, "count");
    store.append(first);
    store.append(second);
    store.append(requests);

    expect(store.read("latency")).toEqual([first, second]);
    expect(store.read("requests")).toEqual([requests]);
    expect(store.read("missing")).toEqual([]);
  });
});

describe("collector integration", () => {
  test("drainWindow writes rollups to the store", async () => {
    const { MetricsStore } = await import("../store.js");
    const store = new MetricsStore();
    const collector = createCollector({ windowMs: 100, store });
    collector.add(sample("latency", 25, 20));
    collector.add(sample("latency", 75, 40));
    collector.drainWindow(100);
    expect(store.read("latency")).toHaveLength(1);
    expect(store.read("latency")[0]).toMatchObject({ count: 2, p50: 20, p95: 40 });
    expect(Reflect.has(collector, "flushWindow")).toBe(false);
  });

  test("one drain groups the same metric with different units into independent rollups", async () => {
    const { MetricsStore } = await import("../store.js");
    const store = new MetricsStore();
    const collector = createCollector({ windowMs: 100, store });
    collector.add(sample("latency", 50, 12));
    collector.add({ metric: "latency", timestampMs: 60, value: 2, unit: "count" });
    collector.drainWindow(100);
    expect(store.read("latency")).toEqual([
      rollup("latency", 100, 12),
      { ...rollup("latency", 100, 2, "count"), windowStartMs: 0 },
    ]);
  });

  test("uses (windowStartMs, windowEndMs], retains future samples, and publishes each sample once", async () => {
    const { MetricsStore } = await import("../store.js");
    const store = new MetricsStore();
    const collector = createCollector({ windowMs: 100, store });
    collector.add(sample("latency", 0, 1));
    collector.add(sample("latency", 1, 2));
    collector.add(sample("latency", 100, 3));
    collector.add(sample("latency", 101, 4));
    collector.drainWindow(100);
    collector.drainWindow(100);
    collector.drainWindow(200);
    collector.drainWindow(200);
    expect(store.read("latency")).toEqual([
      {
        metric: "latency",
        windowStartMs: 0,
        windowEndMs: 100,
        count: 2,
        min: 2,
        max: 3,
        p50: 2,
        p95: 3,
        unit: "ms",
      },
      rollup("latency", 200, 4),
    ]);
  });

  test("out-of-order samples still produce numeric percentiles", async () => {
    const { MetricsStore } = await import("../store.js");
    const store = new MetricsStore();
    const collector = createCollector({ windowMs: 100, store });
    collector.add(sample("latency", 90, 90));
    collector.add(sample("latency", 10, 10));
    collector.add(sample("latency", 50, 50));
    collector.drainWindow(100);
    expect(store.read("latency")[0]).toMatchObject({ p50: 50, p95: 90 });
  });

  test("computePercentiles accepts unsorted values directly", () => {
    expect(computePercentiles([100, 1, 50, 2, 25])).toEqual({ p50: 25, p95: 100 });
  });
});

describe("reports", () => {
  test("uses an inclusive 60,000 ms cutoff and selects newest in either insertion order", async () => {
    const { MetricsStore } = await import("../store.js");
    const nowMs = 100_000;
    const cutoff = rollup("latency", nowMs - 60_000, 40);
    const newest = rollup("latency", nowMs - 1, 99);

    for (const retained of [[cutoff, newest], [newest, cutoff]]) {
      const store = new MetricsStore();
      for (const value of retained) store.append(value);
      expect(createReportSource(store).report("latency", nowMs)).toEqual({
        metric: "latency",
        count: 1,
        p95: 99,
      });
      store.append(rollup("latency", nowMs + 1, 111));
      expect(createReportSource(store).report("latency", nowMs)).toEqual({
        metric: "latency",
        count: 1,
        p95: 111,
      });
    }

    const boundaryStore = new MetricsStore();
    boundaryStore.append(cutoff);
    boundaryStore.append(rollup("expired", nowMs - 60_001, 39));
    const reports = createReportSource(boundaryStore);
    expect(reports.report("latency", nowMs)).toEqual({
      metric: "latency",
      count: 1,
      p95: 40,
    });
    expect(reports.report("expired", nowMs)).toBeUndefined();
    expect(reports.report("missing", nowMs)).toBeUndefined();
  });

  test.each([
    { unit: "s" as const, storedP95: 0.25, expectedP95: 250 },
    { unit: "ms" as const, storedP95: 17, expectedP95: 17 },
    { unit: "count" as const, storedP95: 7, expectedP95: 7 },
  ])("preserves the exact report shape for $unit values", async ({ unit, storedP95, expectedP95 }) => {
    const { MetricsStore } = await import("../store.js");
    const store = new MetricsStore();
    store.append({ ...rollup("metric", 1_000, storedP95, unit), count: 4 });
    expect(createReportSource(store).report("metric", 2_000)).toEqual({
      metric: "metric",
      count: 4,
      p95: expectedP95,
    });
  });
});

// Freeze the original passing percentile case without retaining the removed callback API.
test("computes percentiles for sorted input", () => {
  expect(computePercentiles([1, 2, 3, 4, 5])).toEqual({ p50: 3, p95: 5 });
});
