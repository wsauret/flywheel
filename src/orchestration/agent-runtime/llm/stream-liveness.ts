/** Shared provider-stream liveness policy. Adapters decode transport events;
 * this controller owns the single deadline and its timeout classification. */

import { Log } from "../../../infra/log.js";
import type { StreamAttempt } from "./stream-attempt.js";
import { STREAM_IDLE_TIMEOUT_FAST_MS, STREAM_REASONING_IDLE_TIMEOUT_MS, STREAM_TTFT_TIMEOUT_MS, type StreamTimeoutEvent } from "./stream-watchdog.js";
import { ThinkingStallError } from "./thinking-stall.js";
import { observeThinkingStall, observeWatchdogStall, observeWatchdogTimeout } from "./stream-observe.js";
import type { StreamTelemetrySink } from "./types.js";

interface StreamLivenessOptions {
  /** Watchdog label; matches the adapter's log service tag (e.g. "llm-openai"). */
  label: string;
  /** Display name for timeout log lines. */
  provider: string;
  telemetry: StreamTelemetrySink | undefined;
  idleTimeoutMs?: number;
  stallThresholds?: readonly number[];
  timeoutMessage?: (event: StreamTimeoutEvent) => string;
}

interface ActiveThinking {
  readonly blockKey: string | undefined;
  summary: string;
}

export interface StreamLiveness {
  preStream(): void;
  frame(): void;
  keepalive(): void;
  begin(blockKey?: string): void;
  append(text: string): void;
  complete(blockKey?: string): void;
}

export function armStreamLiveness(attempt: StreamAttempt, opts: StreamLivenessOptions): StreamLiveness {
  const log = Log.create({ service: opts.label });
  const idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_FAST_MS;
  const reasoningIdleTimeoutMs = configuredReasoningIdleTimeoutMs();
  let activeThinking: ActiveThinking | undefined;
  let thinkingTimeout: ThinkingStallError | undefined;

  attempt.startStreamDeadline({
    idleTimeoutMs,
    ttftTimeoutMs: STREAM_TTFT_TIMEOUT_MS,
    label: opts.label,
    stallThresholds: opts.stallThresholds,
    onStall: (event) => { observeWatchdogStall(opts.telemetry, event); },
    onTimeout: (event) => {
      if (activeThinking) {
        thinkingTimeout = new ThinkingStallError({
          blockKey: activeThinking.blockKey,
          elapsedMs: reasoningIdleTimeoutMs,
          summary: activeThinking.summary,
        });
        log.warn("thinking block stalled", {
          blockKey: activeThinking.blockKey,
          elapsedMs: reasoningIdleTimeoutMs,
          summaryChars: activeThinking.summary.length,
        });
        observeThinkingStall(opts.telemetry, thinkingTimeout);
        return;
      }
      log.warn(`${opts.provider} stream ${event.phase} for ${event.idleTimeoutMs}ms, aborting`);
      observeWatchdogTimeout(opts.telemetry, { ...event });
    },
    timeoutError: () => thinkingTimeout,
    timeoutMessage: opts.timeoutMessage,
  });

  const resetForCurrentState = () => {
    attempt.resetStreamDeadline(activeThinking ? reasoningIdleTimeoutMs : idleTimeoutMs);
  };

  return {
    preStream() {
      attempt.resetStreamDeadline(STREAM_TTFT_TIMEOUT_MS, "pre-stream");
    },
    frame() {
      resetForCurrentState();
    },
    keepalive() {
      attempt.recordStreamKeepalive();
    },
    begin(blockKey) {
      activeThinking = { blockKey, summary: "" };
      thinkingTimeout = undefined;
      resetForCurrentState();
    },
    append(text) {
      if (!activeThinking || thinkingTimeout) return;
      activeThinking.summary += text;
      resetForCurrentState();
    },
    complete(blockKey) {
      if (!activeThinking) return;
      if (blockKey !== undefined && activeThinking.blockKey !== undefined && blockKey !== activeThinking.blockKey) return;
      activeThinking = undefined;
      resetForCurrentState();
    },
  };
}

/** Replaces the abort caused by the deadline with its typed timeout error before
 * provider classification. A caller-initiated abort passes through unchanged. */
export function throwIfLivenessFailure(
  err: unknown,
  attempt: StreamAttempt,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) throw err;
  attempt.throwIfStreamTimedOut();
}

function configuredReasoningIdleTimeoutMs(): number {
  const raw = process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
  if (!raw) return STREAM_REASONING_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : STREAM_REASONING_IDLE_TIMEOUT_MS;
}