import { describe, expect, test } from "bun:test";
import { parseMetricLines } from "../../../../../src/orchestration/modules/experiments/metric-lines.js";

describe("parseMetricLines", () => {
  test("parses the exact structured line format and preserves first insertion order", () => {
    const metrics = parseMetricLines([
      "noise METRIC ignored=1",
      "METRIC total_µs=15200",
      "METRIC compile.ms=4200.5",
      "METRIC total_µs=14900",
      "METRIC spaced =2",
      "METRIC invalid=Infinity",
      "METRIC hex=0x10",
      "METRIC __proto__=1",
    ].join("\n"));

    expect([...metrics]).toEqual([
      ["total_µs", 14900],
      ["compile.ms", 4200.5],
      ["hex", 16],
    ]);
  });

  test("accepts CRLF output and rejects unsupported names and non-finite values", () => {
    expect([...parseMetricLines("METRIC ok=1\r\nMETRIC bad-name=2\r\nMETRIC nan=NaN\r\n")]).toEqual([
      ["ok", 1],
    ]);
  });
});
