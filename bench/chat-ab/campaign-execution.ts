import type { HeadlessBenchmarkExecution } from "../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { unavailableBenchmarkAccounting } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import { campaignArtifactReference } from "./campaign-artifacts.js";
import type { CampaignAttempt, CampaignExecutionOutcome } from "./campaign-store.js";

export type CampaignSettlement<Grade extends object> = (
  outcome: CampaignExecutionOutcome & Grade,
  executions: readonly HeadlessBenchmarkExecution[],
  controllerFailed: boolean,
) => CampaignExecutionOutcome & Grade;

/** Project ordered invocations without adding cumulative session-tree accounting twice.
 * What the subject settles on is the cell's result: a run that ends without a handoff
 * is graded like any other, because retrying it would keep only the runs that hand off.
 * A harness failure or an interrupted attempt is retryable, with no
 * inferred usage or completion. */
export function campaignHeadlessOutcome<Grade extends object>(
  directory: string,
  attempt: CampaignAttempt,
  executions: readonly HeadlessBenchmarkExecution[],
  approvals: number,
  artifacts: Grade & Pick<CampaignExecutionOutcome, "report" | "diff">,
  controllerFailed = false,
  questionArtifacts: ReadonlyMap<number, HeadlessBenchmarkExecution["artifacts"]> = new Map(),
  settle?: CampaignSettlement<Grade>,
): CampaignExecutionOutcome & Grade {
  const last = executions.at(-1);
  const reason = controllerFailed ? "cell controller or capture failed" : last?.reason ?? (last ? null : "attempt interrupted before outcome");
  const unavailable = unavailableBenchmarkAccounting(reason ?? "No canonical evidence was observed");
  const outcome: CampaignExecutionOutcome & Grade = {
    kind: "outcome", version: 2, attemptId: attempt.attemptId, cell: attempt.cell, at: new Date().toISOString(),
    status: !controllerFailed && (last?.outcome === "complete" || last?.outcome === "input_required" || last?.outcome === "incomplete") ? "completed" : "failed",
    reason, approvals,
    runs: executions.map((run, index) => {
      if (run.outcome === "preflight") throw new Error("A preflight is not a cell invocation");
      const evidence = run.evidence.kind === "observed" ? {
        kind: "observed" as const, requestCount: run.evidence.requestCount,
        parentRequestCount: run.evidence.parentRequestCount, childSessionCount: run.evidence.childSessionCount,
      } : run.evidence;
      return {
        outcome: run.outcome, exitCode: run.exitCode, wallMs: run.wallMs, sessionId: run.sessionId ?? null,
        ...(run.models ? { models: run.models } : {}),
        ...(run.workflowsMode ? { workflowsMode: run.workflowsMode } : {}),
        reason: run.reason ?? null, evidence,
        artifacts: [...Object.values(run.artifacts), ...Object.values(questionArtifacts.get(index) ?? {})].map(({ path, sha256 }) => ({ path: campaignArtifactReference(directory, path), sha256 })),
      };
    }),
    accounting: last?.totalAccounting ?? unavailable,
    parentAccounting: last?.parentAccounting ?? unavailable,
    ...artifacts,
  };
  return settle ? settle(outcome, executions, controllerFailed) : outcome;
}
