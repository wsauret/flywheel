import { describe, expect, it } from "bun:test";
import {
  renderImplementReport as renderPersonaImplementReport,
  type ImplementCandidate,
} from "../../../src/orchestration/modules/development/benchmark/implement-scoring.js";
import { formatAccountingObservation } from "../../../src/orchestration/modules/development/benchmark/report-accounting.js";
import { judgeOverhead, judgeOverheadNote, renderReport, unsuccessfulOverhead } from "../../../src/orchestration/modules/development/benchmark/reports.js";
import type { ImplementTask } from "../../../src/orchestration/modules/development/benchmark/catalog.js";

const ACCOUNTING = {
  estimatedUsd: { kind: "observed", value: 0.75 },
  billedUsd: { kind: "observed", value: 0.25 },
  tokens: { kind: "observed", value: 999 },
  providers: { kind: "observed", value: ["openai_subscription"] },
  pricedEntryCount: 1,
  unpricedEntryCount: 0,
} as const;

describe("canonical report accounting", () => {
  it("distinguishes an empty average from an empty total", () => {
    expect(formatAccountingObservation([], "estimatedUsd", "average")).toBe("n/a");
    expect(formatAccountingObservation([], "estimatedUsd", "total")).toBe("$0.0000");
  });

  it("marks a sum as a lower bound when a record has one, and as unavailable when a record states no amount", () => {
    const lowerBound = { ...ACCOUNTING, estimatedUsd: { kind: "unavailable", reason: "one attempt reported no usage", atLeast: 0.25 }, tokens: { kind: "unavailable", reason: "one attempt reported no usage", atLeast: 1 } } as const;
    const unknown = { ...ACCOUNTING, estimatedUsd: { kind: "unavailable", reason: "no committed usage" } } as const;
    expect(formatAccountingObservation([ACCOUNTING, lowerBound], "estimatedUsd", "total")).toBe("at least $1.0000");
    expect(formatAccountingObservation([ACCOUNTING, lowerBound], "estimatedUsd", "average")).toBe("at least $0.5000");
    expect(formatAccountingObservation([ACCOUNTING, lowerBound], "tokens", "total")).toBe("at least 1000");
    expect(formatAccountingObservation([ACCOUNTING, lowerBound], "billedUsd", "total")).toBe("$0.5000");
    expect(formatAccountingObservation([lowerBound, unknown], "estimatedUsd", "total")).toBe("unavailable");
  });

  it("reports unsuccessful-attempt and judge overhead as a lower bound when one record has only a lower bound", () => {
    const exact = { accounting: { ...ACCOUNTING, estimatedUsd: { kind: "observed", value: 1 }, billedUsd: { kind: "observed", value: 1 }, tokens: { kind: "observed", value: 100 } } } as const;
    const lowerBound = { accounting: { ...ACCOUNTING, estimatedUsd: { kind: "unavailable", reason: "attempt a1 reported no usage", atLeast: 2 }, billedUsd: { kind: "observed", value: 2 }, tokens: { kind: "unavailable", reason: "attempt a1 reported no usage", atLeast: 200 } } } as const;
    const unknown = { accounting: { ...ACCOUNTING, billedUsd: { kind: "unavailable", reason: "no committed usage" } } } as const;
    const report = renderReport({ persona: "explorer", variants: [{ id: "a" }, { id: "b" }] }, [], [], [], "stamp", {
      failedJudgeCalls: 0,
      unsuccessfulAttempts: 2,
      ...unsuccessfulOverhead([exact, lowerBound]),
      ...judgeOverhead([lowerBound, unknown]),
    });
    expect(report).toContain("Their separate cumulative accounting is at least $3.0000 estimated equivalent, $3.0000 billed, and at least 300 tokens. Accounting was unavailable for 1 attempt(s).");
    expect(report).toContain("Judge overhead, excluded from every candidate total above: at least $2.7500 estimated equivalent, at least $2.0000 billed, and at least 1199 tokens, from the campaign ledger. Accounting was unavailable for 2 judge calls.");
    const noAmount = judgeOverhead([{ accounting: { ...ACCOUNTING, tokens: { kind: "unavailable", reason: "no committed usage" } } }]);
    expect(judgeOverheadNote({ failedJudgeCalls: 0, unsuccessfulAttempts: 0, ...unsuccessfulOverhead([]), ...noAmount })).toContain("$0.7500 estimated equivalent, $0.2500 billed, and unavailable tokens");
  });

  it("sums the shared implementer Totals row", () => {
    const task: ImplementTask = {
      mode: "implement",
      id: "task",
      prompt: "implement",
      stratum: "small",
      timeoutMs: 1_000,
      taskDir: "/task",
      plan: {},
      sandbox: { fixtureRepo: "/project" },
      acceptanceDir: "/acceptance",
      manifest: { traps: [], judgment: [] },
      contentIdentity: "task-identity",
    };
    const candidate = (repeat: number, estimatedUsd: number): ImplementCandidate => ({
      variant: "model@low",
      task: task.id,
      repeat,
      accounting: { ...ACCOUNTING, estimatedUsd: { kind: "observed", value: estimatedUsd } },
      durationMs: 10,
      summary: "done",
      diff: "diff",
      linesAdded: 1,
      linesRemoved: 0,
      filesTouched: 1,
      acceptancePassed: 1,
      acceptanceFailed: 0,
      acceptanceTotal: 1,
    });
    const report = renderPersonaImplementReport(
      { persona: "implementer", variants: [{ id: "model@low", model: "model", effort: "low" }] },
      [task, {
        mode: "implement", kind: "native", id: "native", stratum: "small", prompt: "Original bug", timeoutMs: 1000,
        taskDir: "/native", instruction: "Original bug", family: "python", split: "development",
        native: { command: ["python3", "/native/adapter.py"], timeoutMs: 1000 },
        manifest: { traps: [], judgment: [] }, contentIdentity: "native-identity",
      }],
      [candidate(0, 1), candidate(1, 3)],
      [],
      [],
      "stamp",
      {
        failedJudgeCalls: 0,
        unsuccessfulAttempts: 0,
        ...unsuccessfulOverhead([]),
        ...judgeOverhead([]),
      },
    );
    expect(report.split("\n").find((line) => line.startsWith("| task (small)"))).toContain("$2.0000");
    expect(report.split("\n").find((line) => line.startsWith("| All tasks"))).toContain("$4.0000");
    expect(report).toContain("Plan acceptance");
    expect(report).toContain("Native acceptance");
    expect(report).toContain("original grader counts");
    expect(report).toContain("unsuccessful attempts, not failed test outcomes");
  });
});
