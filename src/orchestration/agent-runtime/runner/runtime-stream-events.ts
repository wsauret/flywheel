import { boundProviderDetail, classifyApiError } from "../../../infra/llm/errors/provider-error-copy.js";
import { createRuntimeEvent } from "../../../infra/runtime-facts/runtime-event-factory.js";
import type { SessionNoticeOperation } from "../../../infra/session-notice.js";
import { PROVIDER_NOTICE_SCOPE, resolveProviderNotices } from "./agent-resilience.js";
import type { StreamEvent } from "../llm/types.js";
import type { RequestToolSurfaceOwner } from "../request/request-tool-surface.js";
import { emitAgentStreamEvent, type StreamedThinking } from "./runner-stream-events.js";
import type { TurnUsageTracker } from "../request/usage/turn-usage-tracker.js";
import type { AgentOptions } from "../types.js";

const NON_STREAM_EVENT_KINDS = new Set(["context_update", "compaction_start", "compaction_done", "stream_abandoned", "stream_attempt_start"]);

type ProviderNotice = Extract<SessionNoticeOperation, { type: "upsert" }>["notice"];

/** The stream events of one run, mapped to its session state and runtime events. */
export interface RuntimeStreamEvents {
  readonly onEvent: (streamEvent: StreamEvent) => void;
  /** The response's assistant message is committed, so the next response starts with no streamed thinking. */
  readonly assistantCommitted: () => void;
}

export function createRuntimeStreamEvents(input: {
  options: AgentOptions;
  contextWindow: () => number;
  costTracker: TurnUsageTracker;
  providerSessionKey: string;
  sessionId: string | undefined;
  parentToolUseId: string | undefined;
  surface: RequestToolSurfaceOwner;
}): RuntimeStreamEvents {
  const { options, contextWindow, costTracker, providerSessionKey, sessionId, parentToolUseId, surface } = input;
  const thinking: StreamedThinking = { sawDelta: false };
  // Connection state and the provider notice scope change only on a
  // transition. The run starts with one pending, and each notice upserted
  // into the scope makes another: this handler is the only producer that
  // moves the connection away from "connected", always with such a notice.
  // The first stream event after it settles both once, so a streamed token
  // resolves nothing.
  let settlePending = true;
  const upsertNotice = (notice: ProviderNotice): void => {
    settlePending = true;
    options.onNotice?.({ type: "upsert", notice });
  };
  return {
    onEvent: (streamEvent) => {
      if (isProviderNoticeStreamEvent(streamEvent)) {
        handleProviderNoticeEvent(streamEvent, options, sessionId, upsertNotice);
        return;
      }
      if (settlePending && !NON_STREAM_EVENT_KINDS.has(streamEvent.kind)) {
        settlePending = false;
        options.lifecycle.onConnectionState?.("connected");
        options.onNotice?.(resolveProviderNotices());
      }
      emitAgentStreamEvent(streamEvent, {
        options, contextWindow: contextWindow(), costTracker, providerSessionKey, parentToolUseId, thinking,
        tools: surface.current().tools,
      });
    },
    assistantCommitted: () => { thinking.sawDelta = false; },
  };
}

type ProviderNoticeStreamEvent = Extract<StreamEvent, {
  kind: "provider_status" | "stream_retry" | "stream_resample";
}>;

function isProviderNoticeStreamEvent(streamEvent: StreamEvent): streamEvent is ProviderNoticeStreamEvent {
  return streamEvent.kind === "provider_status"
    || streamEvent.kind === "stream_retry"
    || streamEvent.kind === "stream_resample";
}

const PROVIDER_RETRY_NOTICE_ID = `${PROVIDER_NOTICE_SCOPE}:retry`;
const PROVIDER_STATUS_NOTICE_ID = `${PROVIDER_NOTICE_SCOPE}:status`;
const providerStatusConditions = new WeakSet<AgentOptions>();

function handleProviderNoticeEvent(
  streamEvent: ProviderNoticeStreamEvent,
  options: AgentOptions,
  sessionId: string | undefined,
  upsertNotice: (notice: ProviderNotice) => void,
): void {
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
      upsertNotice({
        id: PROVIDER_STATUS_NOTICE_ID,
        scope: PROVIDER_NOTICE_SCOPE,
        presentation: streamEvent.level === "error" ? "provider.status_alert" as const : "provider.status_progress" as const,
        severity: streamEvent.level === "error" ? "error" : "info",
        title: "Provider status",
        message: streamEvent.message,
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
      upsertNotice({
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
      });
      return;
    }
    // The connection is fine, so the connection state stays as it is: only the response is sampled again.
    case "stream_resample":
      upsertNotice({
        id: PROVIDER_RETRY_NOTICE_ID,
        scope: PROVIDER_NOTICE_SCOPE,
        presentation: "provider.reconnect_progress",
        severity: "warning",
        title: "Model repeated itself",
        message: `Requesting a fresh response${streamEvent.nextAttemptDisablesReasoning ? " without reasoning" : ""} (${streamEvent.attempt}/${streamEvent.maxAttempts}).`,
        retry: { count: streamEvent.attempt, maxRetries: streamEvent.maxAttempts },
      });
      return;
  }
}
