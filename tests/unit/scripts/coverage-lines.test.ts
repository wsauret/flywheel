import { describe, expect, test } from "bun:test";
import { assertCoverageSources, coverageDecision, coverageReportSchema, coverageSummary, compareLines, mergeLcov, productionPath } from "../../../scripts/coverage-lines.js";

const root = "/repo";

function report(covered = 100) {
  return coverageReportSchema.parse({
    version: 1, kind: "baseline", bunVersion: "1.4", lane: "unit",
    sources: { "src/one.ts": "hash" },
    lines: { "src/one.ts": Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i + 1, i < covered])) },
    unmeasured: [], incompleteScopes: [], tests: { passed: 1, failed: 0 }, failed: false,
  });
}

describe("measured production lines", () => {
  test("excludes established test support but retains runner tooling", () => {
    expect(productionPath("scripts/test-temp-guard.ts", root)).toBeNull();
    expect(productionPath("webview/src/app/composer-status-fixture.ts", root)).toBeNull();
    expect(productionPath("webview/src/app/render-ownership-loader-fixture.ts", root)).toBeNull();
    expect(productionPath("scripts/test-parallel.ts", root)).toBe("scripts/test-parallel.ts");
  });
  test("unions shard hits by path and line, excluding test files", () => {
    const lines = mergeLcov([
      "SF:/repo/src/one.ts\nDA:3,0\nDA:4,1\nend_of_record\nSF:/repo/src/one.test.ts\nDA:3,1\nend_of_record",
      "SF:/repo/src/one.ts\nDA:3,2\nDA:4,0\nend_of_record",
    ], root);
    expect(lines).toEqual({ "src/one.ts": { 3: true, 4: true } });
    expect(productionPath("/repo/tests/unit/a.ts", root)).toBeNull();
  });

  test("keeps frozen baseline lines when a candidate no longer loads a file", () => {
    const baseline = { "src/one.ts": { 3: true, 4: false }, "src/two.ts": { 2: true } };
    const result = compareLines(baseline, { "src/one.ts": { 3: true } });
    expect(result.baselinePercent).toBeCloseTo(66.6667, 3);
    expect(result.candidatePercent).toBeCloseTo(33.3333, 3);
    expect(result.lossPoints).toBeCloseTo(33.3333, 3);
    expect(result.missing).toEqual({ "src/one.ts": [4], "src/two.ts": [2] });
  });

  test("allows exactly two points but fails greater loss in the report decision", () => {
    expect(coverageDecision({ ...report(98), kind: "candidate" }, report()).failed).toBe(false);
    expect(coverageDecision({ ...report(97), kind: "candidate" }, report()).failed).toBe(true);
  });

  test("never passes failed baseline, candidate, tests, or incomplete scopes", () => {
    expect(coverageDecision(report(), { ...report(), failed: true }).failed).toBe(true);
    expect(coverageDecision({ ...report(), failed: true }, report()).failed).toBe(true);
    expect(coverageDecision({ ...report(), tests: { passed: 1, failed: 1 } }, report()).failed).toBe(true);
    expect(coverageDecision({ ...report(), incompleteScopes: ["unit"] }, report()).failed).toBe(true);
  });

  test("rejects candidate baselines and mismatched source, lane, or Bun", () => {
    expect(() => coverageDecision(report(), { ...report(), kind: "candidate" })).toThrow("baseline report");
    expect(() => coverageDecision({ ...report(), sources: { "src/one.ts": "changed" } }, report())).toThrow("source");
    expect(() => coverageDecision({ ...report(), lane: "integration" }, report())).toThrow("lane");
    expect(() => coverageDecision({ ...report(), bunVersion: "other" }, report())).toThrow("Bun");
  });

  test("rejects source edits, additions, and removals at settlement without depending on key order", () => {
    expect(() => assertCoverageSources({ a: "1" }, { a: "2" })).toThrow("manifest changed");
    expect(() => assertCoverageSources({ a: "1" }, { a: "1", b: "2" })).toThrow("manifest changed");
    expect(() => assertCoverageSources({ a: "1" }, {})).toThrow("manifest changed");
    expect(() => assertCoverageSources({ a: "1", b: "2" }, { b: "2", a: "1" })).not.toThrow();
  });

  test("streams chunked summaries using the lane's aggregation and ignores long diagnostic lines", () => {
    const unit = coverageSummary("unit");
    unit.push("2 pass\n1 fail\n" + "x".repeat(300));
    unit.push("12 pass\n123 pa");
    unit.push("ss\n0 fail");
    expect(unit.finish()).toEqual({ passed: 123, failed: 0 });
    const integration = coverageSummary("integration");
    integration.push("1200 pass\n1 fail\n");
    integration.push("25 pass\n0 fail\n");
    expect(integration.finish()).toEqual({ passed: 1225, failed: 1 });
  });
});
