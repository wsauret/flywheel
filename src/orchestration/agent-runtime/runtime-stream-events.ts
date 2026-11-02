import { boundProviderDetail, classifyApiError } from "../../infra/llm/provider-error-copy.js";
import { createRuntimeEvent } from "../../infra/runtime-event-factory.js";
import { PROVIDER_NOTICE_SCOPE, resolveProviderNotices } from "./agent-resilience.js";
import type { StreamEvent } from "./llm/types.js";
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js";
import { emitAgentStreamEvent } from "./runner-stream-events.js";
import type { ThinkingAccumulator } from "./emit.js";
import type { TurnUsageTracker } from "./turn-usage-tracker.js";
import type { AgentOptions } from "./types.js";

const NON_STREAM_EVENT_KINDS = new Set(["context_update", "compaction_start", "compaction_done", "stream_abandoned"]);

export function createRuntimeStreamEventHandler(input: {
  options: AgentOptions;
  contextWindow: () => number;
  costTracker: TurnUsageTracker;
  providerSessionKey: string;
  sessionId: string | undefined;
  parentToolUseId: string | undefined;
  thinking: ThinkingAccumulator;
  surface: RequestToolSurfaceOwner;
}): (streamEvent: StreamEvent) => void {
  const { options, contextWindow, costTracker, providerSessionKey, sessionId, parentToolUseId, thinking, surface } = input;
  return (streamEvent) => {
    if (isProviderNoticeStreamEvent(streamEvent)) {
      handleProviderNoticeEvent(streamEvent, options, sessionId);
      return;
    }
    if (!NON_STREAM_EVENT_KINDS.has(streamEvent.kind)) {
      options.lifecycle.onConnectionState?.("connected");
      options.onNotice?.(resolveProviderNotices());
    }
    emitAgentStreamEvent(streamEvent, {
      options, contextWindow: contextWindow(), costTracker, providerSessionKey, parentToolUseId, thinking,
      tools: surface.current().tools,
    });
  };
}

type ProviderNoticeStreamEvent = Extract<StreamEvent, {
  kind: "provider_status" | "stream_retry" | "stream_attempt_start";
}>;

function isProviderNoticeStreamEvent(streamEvent: StreamEvent): streamEvent is ProviderNoticeStreamEvent {
  return streamEvent.kind === "provider_status"
    || streamEvent.kind === "stream_retry"
    || streamEvent.kind === "stream_attempt_start";
}

const PROVIDER_RETRY_NOTICE_ID = `${PROVIDER_NOTICE_SCOPE}:retry`;
const PROVIDER_STATUS_NOTICE_ID = `${PROVIDER_NOTICE_SCOPE}:status`;
const providerStatusConditions = new WeakSet<AgentOptions>();

function handleProviderNoticeEvent(streamEvent: ProviderNoticeStreamEvent, options: AgentOptions, sessionId: string | undefined): void {
  switch (streamEvent.kind) {
    case "provider_status": {
      if (streamEvent.level === "error") {
        providerStatusConditions.add(options);
        options.onNotification?.({
          type: "raise",
          occurrence: {
            sourceId: PROVIDER_STATUS_NOTICE_ID,
            title: "Model provider unavailable",
            message: "The model provider needs attention. Open Settings to review the provider configuration.",
            severity: "warning",
            action: { kind: "open-settings" },
            ...(sessionId ? { sourceSessionId: sessionId } : {}),
          },
        });
      } else {
        if (providerStatusConditions.has(options)) options.onNotification?.({ type: "resolve", sourceId: PROVIDER_STATUS_NOTICE_ID });
        providerStatusConditions.delete(options);
      }
      options.onNotice?.({
        type: "upsert",
        notice: {
          id: PROVIDER_STATUS_NOTICE_ID,
          scope: PROVIDER_NOTICE_SCOPE,
          presentation: streamEvent.level === "error" ? "provider.status_alert" as const : "provider.status_progress" as const,
          severity: streamEvent.level === "error" ? "error" : "info",
          title: "Provider status",
          message: streamEvent.message,
        },
      });
      return;
    }
    case "stream_retry": {
      options.lifecycle.onConnectionState?.("retrying");
      options.onEvent(createRuntimeEvent("model.stream.retried", {
        attempt: streamEvent.attempt,
        reason: streamEvent.reason,
        ...(options.purpose.kind === "subagent" ? { parent_tool_use_id: options.purpose.parentToolUseId } : {}),
      }));
      const copy = classifyApiError(streamEvent.reason);
      options.onNotice?.({
        type: "upsert",
        notice: {
          id: PROVIDER_RETRY_NOTICE_ID,
          scope: PROVIDER_NOTICE_SCOPE,
          presentation: "provider.reconnect_progress",
          severity: "warning",
          title: "Reconnecting to model provider",
          message: copy.detail === undefined ? copy.message : boundProviderDetail(copy.detail),
          retry: {
            count: streamEvent.attempt,
            maxRetries: streamEvent.maxAttempts,
            delayMs: streamEvent.delayMs,
            nextAttemptAt: Date.now() + streamEvent.delayMs,
          },
        },
      });
      return;
    }
    case "stream_attempt_start":
      emitAttemptNotice(streamEvent, options);
      return;
  }
}

function emitAttemptNotice(
  streamEvent: Extract<StreamEvent, { kind: "stream_attempt_start" }>,
  options: AgentOptions,
): void {
  if (!streamEvent.isRetry) return;
  options.lifecycle.onConnectionState?.("connecting");
  options.onNotice?.({
    type: "upsert",
    notice: {
      id: PROVIDER_RETRY_NOTICE_ID,
      scope: PROVIDER_NOTICE_SCOPE,
      presentation: "provider.reconnect_progress",
      severity: "warning",
      title: "Reconnecting to model provider",
      message: `Starting retry ${streamEvent.attempt} of ${streamEvent.maxAttempts}.`,
      retry: {
        count: streamEvent.attempt,
        maxRetries: streamEvent.maxAttempts,
      },
    },
  });
}
