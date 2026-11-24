/** The one liveness owner of a provider stream attempt. Adapters decode
 *  transport events and report frames to it; it owns the deadline, the
 *  thinking-stall policy, and the classification of a timeout. */

import { Log } from "../../../../infra/log.js";
import { StreamIdleTimeoutError } from "../errors.js";
import { normalizeProviderAttemptFailure } from "./provider-failure.js";
import { ThinkingStallError } from "./thinking-stall.js";
import { observeThinkingStall, observeWatchdogStall, observeWatchdogTimeout } from "./stream-observe.js";
import type { StreamTelemetrySink } from "../types.js";

/**
 * Stream idle deadline profiles. The deadline runs two clocks:
 *
 *   Frame clock (FAST or PATIENT base): time since the last frame of any
 *              kind, heartbeats included. Silence here means the connection
 *              or server is dead. FAST covers steady token-stream providers
 *              (OpenAI Responses, Gemini); PATIENT covers Anthropic, whose
 *              SDK drops its ping heartbeats before they reach the adapter,
 *              so extended-thinking gaps arrive as total frame silence.
 *
 *   Progress clock (PATIENT cap): time since the last real event. Heartbeats
 *              prove the connection is alive and the response job is open,
 *              not that the model is making progress - a stalled response
 *              behind a warm connection would otherwise re-arm forever. The
 *              cap bounds how long heartbeats alone can keep a stream alive.
 *
 * TTFT is a separate, longer deadline applied only to the first chunk of a
 * stream; covers slow provider routing and long-prompt prefill before any
 * tokens are emitted. The Claude agent host's dispatcher, which emits only
 * complete messages, uses the same bound for each gap of a dispatch frame.
 */
export const STREAM_IDLE_TIMEOUT_FAST_MS = 45_000;
export const STREAM_REASONING_IDLE_TIMEOUT_MS = 300_000;
export const STREAM_IDLE_TIMEOUT_PATIENT_MS = 300_000;
export const STREAM_TTFT_TIMEOUT_MS = 600_000;

/**
 * Provider heartbeat frames (OpenAI Responses `keepalive`). The adapter loop
 * reports them through `keepalive()` - re-arming the frame clock but not the
 * progress clock - and otherwise skips them. (Anthropic `ping` heartbeats
 * never reach the adapter loop; its SDK drops them while parsing the SSE
 * stream.)
 */
const HEARTBEAT_EVENT_KINDS = new Set(["keepalive"]);

export function isHeartbeatStreamEvent(kind: string): boolean {
  return HEARTBEAT_EVENT_KINDS.has(kind);
}

type StreamTimeoutPhase = "pre-stream" | "idle";

interface StreamTimeoutEvent {
  readonly phase: StreamTimeoutPhase;
  readonly idleTimeoutMs: number;
}

/** Monotonic time and one-shot timers. Production uses `performance.now()`
 *  and `setTimeout`; a deadline test injects a controlled clock. */
interface LivenessClock {
  now(): number;
  /** Runs `callback` once after `delayMs`; the returned function cancels it. */
  setTimer(callback: () => void, delayMs: number): () => void;
}

const systemClock: LivenessClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => { clearTimeout(timer); };
  },
};

export interface StreamLivenessOptions {
  /** Log service label; matches the adapter's log service tag (e.g. "llm-openai"). */
  label: string;
  /** Display name for timeout log lines. */
  provider: string;
  telemetry: StreamTelemetrySink | undefined;
  idleTimeoutMs?: number;
  /** Silences shorter than the deadline that each report one partial stall. */
  stallThresholds?: readonly number[];
  timeoutMessage?: (event: StreamTimeoutEvent) => string;
  clock?: LivenessClock;
}

/** What an adapter reports while it reads its transport. */
export interface StreamLiveness {
  /** The request is sent: the first frame gets the TTFT deadline. */
  preStream(): void;
  /** A real frame arrived: both clocks re-arm. */
  frame(): void;
  /** A heartbeat frame arrived: only the frame clock re-arms. */
  keepalive(): void;
  /** A reasoning block opened: the reasoning deadline applies until it completes. */
  begin(blockKey?: string): void;
  append(text: string): void;
  complete(blockKey?: string): void;
}

/** What the attempt that armed the liveness owner reads and controls. */
export interface AttemptLiveness extends StreamLiveness {
  /** Excludes local consumer work from every deadline clock. Nested leases
   *  keep the clocks paused until each idempotent release has run. */
  pause(): () => void;
  /** The error that ends the attempt once the deadline expired: the typed
   *  thinking stall or idle timeout as a provider attempt failure, or the
   *  unchanged failure of the timeout's own reporting. */
  readonly failure: { readonly error: unknown } | undefined;
  close(): void;
}

interface AttemptLivenessHooks {
  /** Runs once when the deadline expires, after the timeout is reported. */
  readonly onExpired: () => void;
  /** Takes each reasoning delta, also outside a tracked reasoning block. */
  readonly onReasoning: (text: string) => void;
}

type DeadlineTarget =
  | { readonly kind: "stall"; readonly atMs: number; readonly thresholdMs: number }
  | { readonly kind: "timeout"; readonly atMs: number };

/**
 * Creates the liveness owner of one attempt. Frames write plain numbers; one
 * timer rechecks the deadline when it fires, so a frame that only moves the
 * deadline later never touches the timer.
 *
 * Times are kept on an active clock that stops while the consumer holds an
 * event (`pause`): active time is wall time less every pause. A frame that
 * arrives during a pause counts at the time the pause began, so neither a
 * pause nor a frame inside one extends the remaining deadline.
 */
export function createStreamLiveness(options: StreamLivenessOptions, hooks: AttemptLivenessHooks): AttemptLiveness {
  const clock = options.clock ?? systemClock;
  const log = Log.create({ service: options.label });
  const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_FAST_MS;
  const reasoningIdleTimeoutMs = configuredReasoningIdleTimeoutMs();
  const stallThresholds = options.stallThresholds ?? [];

  let armed = false;
  let closed = false;
  // Set once, when the deadline expires; every later report is then ignored.
  let failure: { readonly error: unknown } | undefined;
  let lastResetAt = 0;
  let lastKeepaliveAt = 0;
  let activeDeadlineMs = idleTimeoutMs;
  let activePhase: StreamTimeoutPhase = "idle";
  let stallIndex = 0;
  let pauseCount = 0;
  let pausedAt = 0;
  let pausedTotal = 0;
  let cancelTimer: (() => void) | undefined;
  let timerDueAt = 0;
  let activeThinking: { readonly blockKey: string | undefined; summaryChars: number } | undefined;

  const activeNow = (): number => (pauseCount > 0 ? pausedAt : clock.now()) - pausedTotal;

  const target = (): DeadlineTarget => {
    const thresholdMs = stallThresholds[stallIndex];
    if (thresholdMs !== undefined && thresholdMs < activeDeadlineMs) return { kind: "stall", atMs: lastResetAt + thresholdMs, thresholdMs };
    const frameAt = Math.max(lastResetAt, lastKeepaliveAt);
    // A longer TTFT or reasoning deadline is never shortened by the cap.
    const progressCapMs = Math.max(activeDeadlineMs, STREAM_IDLE_TIMEOUT_PATIENT_MS);
    return { kind: "timeout", atMs: Math.min(frameAt + activeDeadlineMs, lastResetAt + progressCapMs) };
  };

  // A pending timer that is due no later than the deadline stays: when it
  // fires early it rechecks and arms the remainder.
  const schedule = (): void => {
    if (!armed || closed || failure || pauseCount > 0) return;
    const delayMs = Math.max(0, target().atMs - activeNow());
    const dueAt = clock.now() + delayMs;
    if (cancelTimer && timerDueAt <= dueAt) return;
    cancelTimer?.();
    timerDueAt = dueAt;
    cancelTimer = clock.setTimer(onTimer, delayMs);
  };

  const reportStall = (lastChunkAgeMs: number, thresholdMs: number): void => {
    log.warn("stream idle partial", { lastChunkAgeMs, idleDeadlineMs: activeDeadlineMs });
    observeWatchdogStall(options.telemetry, { lastChunkAgeMs, idleDeadlineMs: activeDeadlineMs, thresholdMs });
  };

  const expire = (event: StreamTimeoutEvent, lateMs: number): void => {
    const thinking = activeThinking;
    const thinkingStall = thinking
      ? new ThinkingStallError({ ...(thinking.blockKey === undefined ? {} : { blockKey: thinking.blockKey }), elapsedMs: reasoningIdleTimeoutMs })
      : undefined;
    const error = thinkingStall ?? new StreamIdleTimeoutError(
      options.timeoutMessage?.(event) ?? `Provider stream ${event.phase === "pre-stream" ? "pre-stream timeout" : "idle timeout"}`,
      event.phase,
    );
    failure = { error: normalizeProviderAttemptFailure(error) };
    try {
      if (thinking && thinkingStall) {
        log.warn("thinking block stalled", { blockKey: thinking.blockKey, elapsedMs: reasoningIdleTimeoutMs, summaryChars: thinking.summaryChars, lateMs });
        observeThinkingStall(options.telemetry, thinkingStall, thinking.summaryChars);
      } else {
        log.warn("stream idle timeout", { provider: options.provider, phase: event.phase, idleMs: event.idleTimeoutMs, lateMs });
        observeWatchdogTimeout(options.telemetry, { ...event });
      }
    } catch (telemetryError) {
      failure = { error: telemetryError };
    } finally {
      hooks.onExpired();
    }
  };

  function onTimer(): void {
    cancelTimer = undefined;
    // A paused deadline waits for its release, which arms the timer again.
    if (closed || failure || pauseCount > 0) return;
    const now = activeNow();
    const due = target();
    if (now < due.atMs) {
      schedule();
      return;
    }
    if (due.kind === "timeout") {
      expire({ phase: activePhase, idleTimeoutMs: activeDeadlineMs }, Math.round(now - due.atMs));
      return;
    }
    stallIndex += 1;
    reportStall(Math.round(now - lastResetAt), due.thresholdMs);
    schedule();
  }

  const reset = (timeoutMs: number, phase: StreamTimeoutPhase): void => {
    armed = true;
    lastResetAt = activeNow();
    activeDeadlineMs = timeoutMs;
    activePhase = phase;
    stallIndex = 0;
    schedule();
  };

  const resetForCurrentState = (): void => {
    reset(activeThinking ? reasoningIdleTimeoutMs : idleTimeoutMs, "idle");
  };

  return {
    preStream() {
      reset(STREAM_TTFT_TIMEOUT_MS, "pre-stream");
    },
    frame: resetForCurrentState,
    keepalive() {
      lastKeepaliveAt = activeNow();
    },
    begin(blockKey) {
      activeThinking = { blockKey, summaryChars: 0 };
      resetForCurrentState();
    },
    append(text) {
      hooks.onReasoning(text);
      if (!activeThinking || failure) return;
      activeThinking.summaryChars += text.length;
      resetForCurrentState();
    },
    complete(blockKey) {
      if (!activeThinking) return;
      if (blockKey !== undefined && activeThinking.blockKey !== undefined && blockKey !== activeThinking.blockKey) return;
      activeThinking = undefined;
      resetForCurrentState();
    },
    pause() {
      if (closed || failure) return () => {};
      if (pauseCount === 0) pausedAt = clock.now();
      pauseCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pauseCount -= 1;
        if (pauseCount > 0) return;
        pausedTotal += clock.now() - pausedAt;
        schedule();
      };
    },
    get failure() {
      return failure;
    },
    close() {
      closed = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}

function configuredReasoningIdleTimeoutMs(): number {
  const raw = process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
  if (!raw) return STREAM_REASONING_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : STREAM_REASONING_IDLE_TIMEOUT_MS;
}
