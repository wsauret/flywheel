import type { StoredFact } from "../../../../infra/event-store-types.js"
import type { ChildExecutionMetrics } from "../../../module-diagnostics.js"
import { loadSubagentRunsFromEvents } from "./subagent-run-projection.js"

/** Publish only the retained measurements needed for request attribution. */
export function readChildExecutionMetrics(events: readonly StoredFact[]): readonly ChildExecutionMetrics[] {
  return loadSubagentRunsFromEvents(events).map((run) => ({
    runId: run.childRunId,
    status: run.status,
    ...(run.toolUseId === undefined ? {} : { toolUseId: run.toolUseId }),
    ...(run.modelRequestId === undefined ? {} : { modelRequestId: run.modelRequestId }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.inputTokens === undefined ? {} : { inputTokens: run.inputTokens }),
    ...(run.outputTokens === undefined ? {} : { outputTokens: run.outputTokens }),
    ...(run.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: run.cacheReadInputTokens }),
    ...(run.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: run.cacheCreationInputTokens }),
    ...(run.reasoningTokens === undefined ? {} : { reasoningTokens: run.reasoningTokens }),
    ...(run.totalCostUsd === undefined ? {} : { totalCostUsd: run.totalCostUsd }),
  }))
}
