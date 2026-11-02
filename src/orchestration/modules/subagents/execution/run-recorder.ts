import { buildSubagentCompleted } from "../history/subagent-run-fact-writers.js";
import type { EndedWorkResult } from "../../../agent-runtime/background-work.js";
import type { InFlightWrite } from "../../../../infra/event-store-types.js";
import type { SessionFactWriter } from "../../../session/session-fact-writer.js";

/** Records the run's completion. `inFlight` retires state the completion
 *  settles, such as returned messages, in the same append. */
export async function recordSubagentCompletion(
  writer: Pick<SessionFactWriter, "record"> | null | undefined,
  input: {
    childRunId: string;
    result: EndedWorkResult;
  },
  inFlight?: readonly InFlightWrite[],
): Promise<void> {
  if (!writer) return;
  const usage = input.result.usage;
  await writer.record(buildSubagentCompleted({
    childRunId: input.childRunId,
    status: input.result.status,
    // A person's Stop fails the parent's call, as a failure does.
    isError: input.result.status === "failed" || input.result.status === "stopped",
    ...(input.result.modelFailure ? { modelFailure: true } : {}),
    content: input.result.content,
    durationMs: usage?.durationMs ?? 0,
    ...(usage ? {
      totalTokens: usage.totalTokens,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheCreateTokens !== undefined ? { cacheCreationInputTokens: usage.cacheCreateTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.totalCostUsd !== undefined ? { totalCostUsd: usage.totalCostUsd } : {}),
      toolUses: usage.toolUses,
    } : {}),
  }), undefined, inFlight);
}
