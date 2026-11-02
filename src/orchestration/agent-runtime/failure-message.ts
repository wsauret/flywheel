/**
 * The single description authority for an `AgentFailureReason`.
 *
 * `describeAgentFailure` returns the structured copy - title, standalone
 * body, optional provider detail, optional command action - that the blocked
 * session notice and the one-line transcript record render. `formatAgentFailure`
 * composes the same copy into neutral prose for surfaces that embed a failure
 * into a larger sentence ("Subagent 'x' failed: <detail>", "Worker failed:
 * <detail>"), so an identical failure reads identically regardless of which
 * surface reports it. That prose keeps the whole provider detail because a
 * workflow attempt stores it as its durable failure reason; each display bounds
 * the detail where a person reads it.
 *
 * The retryable kinds (`transient_disconnect`, `api_overloaded`) surface
 * through `runWithResilience`'s exhaustion path with an already-humanized
 * message, which `extractProviderErrorDetail` passes through unchanged.
 * Chat turns, workflow workers, and subagent dispatches all run inside that
 * resilience layer.
 */

import {
  boundProviderDetail,
  classifyApiError,
  extractProviderErrorDetail,
  providerErrorProse,
  type ProviderErrorCopy,
} from "../../infra/llm/provider-error-copy.js";
import type { AgentFailureReason } from "./types.js";

export type AgentFailureCopy = ProviderErrorCopy;

export function describeAgentFailure(reason: AgentFailureReason): AgentFailureCopy {
  switch (reason.kind) {
    case "local_persistence_error": {
      const stage = reason.error.stage
      const sentence = stage === "preparation" ? "No file changes were applied."
        : stage === "publication" ? "A file change may already be applied. Its durable settlement is unresolved; Flywheel will inspect it during recovery."
          : stage === "final-result" ? "The file changes already settled. Their final tool result could not be saved." : undefined
      return {
        presentation: "runtime.persistence_write_refused",
        title: "Local persistence limit exceeded",
        message: reason.error.message,
        ...(sentence ? { guidance: sentence } : {}),
      }
    }
    case "api_error":
      return reason.copy ?? classifyApiError(reason.message);
    case "model_unavailable":
      if (reason.missing === "provider") {
        return {
          presentation: "provider.unavailable",
          title: "No model provider",
          message: "No model provider is set up, so no model can answer.",
          guidance: "Set one up with /auth, then send the message again.",
          action: { label: "Set up providers", command: "/auth" },
        };
      }
      if (reason.missing === "access") {
        // A pending check ends by itself, and nothing resends the failed message.
        return {
          presentation: "provider.unavailable",
          title: "Model access still being checked",
          message: "Flywheel is still checking which models your provider account can use.",
          guidance: "Try again in a moment; the chat does not send the message again by itself.",
        };
      }
      return {
        presentation: "provider.unavailable",
        title: "Model unavailable",
        message: "No configured provider offers this model.",
        guidance: "Choose an available model with /model.",
        detail: reason.message,
        action: { label: "Switch models", command: "/model" },
      };
    case "transient_disconnect":
      return {
        presentation: "provider.connection_lost",
        title: "Connection lost",
        message: "The connection to the model provider dropped. This is usually temporary.",
        guidance: "Check your network, then send a message to retry.",
        detail: extractProviderErrorDetail(reason.message),
      };
    case "stream_stalled":
      return {
        presentation: "provider.connection_lost",
        title: "Model response stalled",
        message: "The model stopped sending progress while composing its response.",
        guidance: "Send a message to retry, or switch models with /model.",
        detail: extractProviderErrorDetail(reason.message),
        action: { label: "Switch models", command: "/model" },
      };
    case "api_overloaded":
      return {
        presentation: "provider.overloaded",
        title: "Provider overloaded",
        message: "The model provider is temporarily overloaded. Nothing is wrong on your end.",
        guidance: "Send a message to retry, or switch models with /model.",
        detail: extractProviderErrorDetail(reason.message),
        action: { label: "Switch models", command: "/model" },
      };
    case "output_overflow":
      return {
        presentation: "provider.output_overflow",
        title: "Output limit exceeded",
        message: "The model response exceeded the output limit.",
        guidance: "Ask for a smaller result or split the request.",
      };
    case "context_overflow":
      return { presentation: "provider.context_overflow", title: "Context window exceeded", message: "The conversation exceeded the model's context window." };
    case "aborted":
      return { presentation: "provider.request_aborted", title: "Aborted", message: "The request was aborted." };
  }
}

/** The one message recording a terminal failure: the problem, the user's
 *  next step, the command affordance when the guidance does not already name
 *  it, then the raw provider detail. A failure renders on one channel, so
 *  this message must be complete on its own wherever it lands. */
export function blockedFailureMessage(copy: AgentFailureCopy): string {
  const action = copy.action && copy.guidance?.includes(copy.action.command) !== true
    ? `${copy.action.label} with ${copy.action.command}.`
    : undefined
  return [copy.message, copy.guidance, action, copy.detail ? `Provider detail: ${boundProviderDetail(copy.detail)}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" ")
}

/** The titled line a transcript records for a terminal failure, and the line
 *  a surface without a transcript prints, so both name the same remedy. */
export function blockedFailureRecord(copy: AgentFailureCopy): string {
  return `${copy.title}. ${blockedFailureMessage(copy)}`
}

export function formatAgentFailure(reason: AgentFailureReason): string {
  switch (reason.kind) {
    case "local_persistence_error": return blockedFailureRecord(describeAgentFailure(reason));
    case "api_error":
      return providerErrorProse(describeAgentFailure(reason));
    case "model_unavailable":
      return reason.missing === "offering" ? reason.message : providerErrorProse(describeAgentFailure(reason));
    case "transient_disconnect":
    case "stream_stalled":
    case "api_overloaded":
      return extractProviderErrorDetail(reason.message);
    case "context_overflow":
      return "Context window exceeded";
    case "output_overflow":
      return "Output overflow";
    case "aborted":
      return "Aborted";
  }
}
