import { describe, expect, it } from "bun:test";
import {
  renderImplementReport as renderPersonaImplementReport,
  type ImplementCandidate,
} from "../../../src/orchestration/modules/development/benchmark/implement-scoring.js";
import { formatAccountingObservation } from "../../../src/orchestration/modules/development/benchmark/report-accounting.js";
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
        taskDir: "/native", instruction: "Original bug", family: "python", split: "development", sandbox: "greenfield",
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
        unsuccessfulEstimatedUsd: 0,
        unsuccessfulBilledUsd: 0,
        unsuccessfulTokens: 0,
        unsuccessfulAccountingUnavailable: 0,
        judgeEstimatedUsd: 0,
        judgeBilledUsd: 0,
        judgeTokens: 0,
        judgeAccountingUnavailable: 0,
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
