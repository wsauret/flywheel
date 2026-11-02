import { relative, resolve, sep } from "node:path";
import { z } from "zod";

export const coverageReportSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["baseline", "candidate"]),
  bunVersion: z.string(),
  lane: z.enum(["unit", "integration", "combined"]),
  sources: z.record(z.string(), z.string()),
  lines: z.record(z.string(), z.record(z.string().regex(/^[1-9]\d*$/), z.boolean())),
  unmeasured: z.array(z.string()),
  incompleteScopes: z.array(z.enum(["unit", "integration"])),
  tests: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
  failed: z.boolean(),
});

type CoverageReport = z.infer<typeof coverageReportSchema>;

/** Reject source drift before publishing a report or comparing measured bytes. */
export function assertCoverageSources(before: CoverageReport["sources"], after: CoverageReport["sources"]): void {
  if (Object.keys(before).length !== Object.keys(after).length
    || Object.entries(before).some(([path, hash]) => after[path] !== hash)) {
    throw new Error("Production source manifest changed; coverage requires identical source files");
  }
}

/** Validate the baseline identity before running a candidate. Failed baselines remain diagnostic evidence. */
export function assertCoverageBaseline(baseline: CoverageReport, identity: Pick<CoverageReport, "sources" | "lane" | "bunVersion">): void {
  if (baseline.kind !== "baseline") throw new Error("--against requires a baseline report, not a candidate");
  if (baseline.lane !== identity.lane || baseline.bunVersion !== identity.bunVersion) {
    throw new Error("Comparison requires identical Bun version and measured test lane");
  }
  assertCoverageSources(baseline.sources, identity.sources);
}

/** Decide the complete report result; failed tests or incomplete lanes cannot pass comparison. */
export function coverageDecision(report: CoverageReport, baseline?: CoverageReport) {
  if (baseline) assertCoverageBaseline(baseline, report);
  const comparison = baseline ? compareLines(baseline.lines, report.lines) : undefined;
  return {
    comparison,
    failed: report.failed || report.tests.failed > 0 || report.incompleteScopes.length > 0
      || Boolean(baseline && (baseline.failed || baseline.tests.failed > 0 || baseline.incompleteScopes.length > 0))
      || Boolean(comparison && comparison.lossPoints > 2),
  };
}

/** Consume bounded summary lines: unit stdout uses its final aggregate; integration stderr sums invocations. */
export function coverageSummary(lane: "unit" | "integration") {
  let pending = "";
  let oversized = false;
  let passed = 0;
  let failed = 0;
  const consume = () => {
    const match = oversized ? null : /^\s*(\d+)\s+(pass|fail)\s*$/.exec(pending);
    if (match?.[2] === "pass") passed = (lane === "unit" ? 0 : passed) + Number(match[1]);
    if (match?.[2] === "fail") failed = (lane === "unit" ? 0 : failed) + Number(match[1]);
    pending = "";
    oversized = false;
  };
  return {
    push(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!oversized) {
          pending += part;
          if (pending.length > 128) { pending = ""; oversized = true; }
        }
        if (part.endsWith("\n")) consume();
      }
    },
    finish() { consume(); return { passed, failed }; },
  };
}

export interface CoverageLines {
  [path: string]: { [line: string]: boolean };
}

export const productionRoots = ["src", "scripts", "vscode/src", "webview/src", "webview/phone", "relay/worker/src", "relay/app", "website/src"];

/** Return a production source path or null for paths outside the measured scope. */
export function productionPath(path: string, root: string): string | null {
  const name = relative(root, resolve(root, path)).split(sep).join("/");
  if (!productionRoots.some((prefix) => name.startsWith(`${prefix}/`))) return null;
  if (name.startsWith("relay/app/dist/")) return null;
  if (name === "scripts/test-temp-guard.ts" || (name.startsWith("webview/") && /-fixture\.tsx?$/.test(name))) return null;
  if (!/\.[cm]?[jt]sx?$/.test(name) || /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)/.test(name)) return null;
  if (/(?:^|\/)[^/]+\.(?:test|spec)\.[jt]sx?$/.test(name) || /(?:^|\/)test-(?:helpers?|support)(?:\/|$)/.test(name)) return null;
  return name;
}

/** Union LCOV line hits by source path and line number. Reject malformed line records. */
export function mergeLcov(chunks: readonly string[], root: string): CoverageLines {
  const lines: CoverageLines = {};
  for (const chunk of chunks) {
    let path: string | null = null;
    for (const entry of chunk.split(/\r?\n/)) {
      if (entry.startsWith("SF:")) path = productionPath(entry.slice(3), root);
      else if (entry === "end_of_record") path = null;
      else if (path && entry.startsWith("DA:")) {
        const match = /^DA:(\d+),(\d+)(?:,\S+)?$/.exec(entry);
        if (!match || Number(match[1]) < 1) throw new Error(`Invalid LCOV line: ${entry}`);
        const file = (lines[path] ??= {});
        file[match[1]!] ||= Number(match[2]) > 0;
      }
    }
  }
  return lines;
}

/** Compare a candidate against the frozen baseline line universe, in percentage points. */
export function compareLines(baseline: CoverageLines, candidate: CoverageLines) {
  let total = 0;
  let before = 0;
  let after = 0;
  const missing: { [path: string]: number[] } = {};
  for (const [path, lines] of Object.entries(baseline)) {
    for (const [line, hit] of Object.entries(lines)) {
      total++;
      if (hit) before++;
      if (candidate[path]?.[line]) after++;
      else (missing[path] ??= []).push(Number(line));
    }
  }
  if (!total) throw new Error("Baseline has no measured production lines");
  return {
    baselinePercent: before * 100 / total,
    candidatePercent: after * 100 / total,
    lossPoints: (before - after) * 100 / total,
    missing,
  };
}
