import { contentDeclinedCopy } from "../../infra/llm/provider-error-copy.js"
import type { AgentRuntimeError } from "./llm/runtime-errors.js"
import type { AgentFailureReason } from "./types.js"

export function toFailureReason(error: AgentRuntimeError): AgentFailureReason {
  switch (error._tag) {
    case "ContextOverflow": return { kind: "context_overflow" }
    case "OutputOverflow": return { kind: "output_overflow" }
    case "ApiError": return { kind: "api_error", message: error.message, ...(error.copy === undefined ? {} : { copy: error.copy }), recovery: error.recovery }
    case "ModelUnavailable": return { kind: "model_unavailable", message: error.message, missing: error.missing }
    case "AllCandidatesExhausted": return {
      kind: "api_error",
      message: error.message,
      ...(error.copy === undefined ? {} : { copy: error.copy }),
      recovery: error.recovery,
      candidatesExhausted: true,
      ...(error.unserved === undefined ? {} : { unserved: error.unserved }),
    }
    case "TransientDisconnect": return { kind: "transient_disconnect", message: error.message }
    case "StreamStalled": return { kind: "stream_stalled", message: error.message, attribution: error.attribution }
    case "ApiOverloaded": return { kind: "api_overloaded", message: error.message }
    // A refusal that the repair inside the run could not clear meets the same
    // content on every later run.
    case "ContentRefused": return { kind: "api_error", message: error.message, ...(error.policy === undefined ? {} : { copy: contentDeclinedCopy(error.reason) }), recovery: { kind: "none" }, contentRefused: true }
    // The assistant boundary settles a content filter as a response, so only a
    // caller outside it meets this; a later run can be served.
    case "ContentFiltered": return { kind: "api_error", message: error.message, recovery: { kind: "retry" } }
    case "AgentAborted": return { kind: "aborted" }
    case "ProviderAuditSettlementError": return { kind: "api_error", message: error.message, recovery: { kind: "retry" } }
    case "ThinkingStall": return { kind: "stream_stalled", message: error.message, attribution: { kind: "unattributed" } }
    // The walk resamples a repeating response and accepts its last attempt, so only a turn that settled during a
    // resampled attempt, such as one that took new input, ends on it; a later run samples again.
    case "DegenerateRepetition": return { kind: "api_error", message: error.message, recovery: { kind: "retry" } }
    // No failure kind states quota coordination, so the account that could not
    // be coordinated has to survive in the message the user reads.
    case "QuotaCoordination": return { kind: "api_error", message: `${error.provider}: ${error.message}`, recovery: { kind: "retry" } }
  }
}
