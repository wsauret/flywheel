import type { AgentFailureKind, AgentOutcome } from "../../workflows/vm/agent-outcome.js"
import type { AgentRunResult } from "../agent-runtime/types.js"
import { formatAgentFailure } from "../agent-runtime/failure-message.js"

/** Maps the runner's terminal result to workflow completion, preserving typed failures and persistence errors. */
export function workerOutcome(result: AgentRunResult): AgentOutcome {
  const terminal = result.terminal
  switch (terminal.kind) {
    case "local_persistence_error": throw new Error(formatAgentFailure(terminal), { cause: terminal.error })
    case "completed": return { output: "completed" }
    case "context_overflow": return { output: "context_overflow" }
    case "budget_exhausted": return failed(terminal.kind, "LLM-call budget exhausted before the attempt completed")
    case "interrupted": return failed(terminal.kind, "Interrupted before the attempt completed")
    case "input_closed": return failed(terminal.kind, "Worker input source closed mid-run. This indicates a runtime bug: an agent's input queue must outlive its worker.")
    case "output_overflow":
    case "aborted": return failed(terminal.kind, formatAgentFailure(terminal))
    case "api_error":
    case "model_unavailable":
    case "transient_disconnect":
    case "stream_stalled":
    case "api_overloaded": return failed(terminal.kind, formatAgentFailure(terminal), terminal.message)
  }
}

function failed(failureKind: AgentFailureKind, failureMessage: string, failureDetail?: string): Extract<AgentOutcome, { output: "failed" }> {
  return { output: "failed", failureKind, failureMessage, failureDetail: failureDetail ?? failureMessage }
}
