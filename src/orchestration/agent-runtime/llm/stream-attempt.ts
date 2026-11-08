import { mergeAbortSignals } from "../../../infra/abort.js";
import { StreamIdleTimeoutError } from "./errors.js";
import { normalizeProviderAttemptFailure } from "./provider-failure.js";
import { reasoningRepetitionDetector } from "./reasoning-repetition.js";
import { createStreamDeadline, type StreamDeadlineOptions, type StreamTimeoutEvent, type StreamTimeoutPhase } from "./stream-watchdog.js";
import type { StreamOptions } from "./types.js";

export interface StreamAttemptStartEvent {
  readonly kind: "stream_attempt_start";
  readonly attempt: 1;
  readonly maxAttempts: 1;
  readonly isFinalAttempt: true;
  readonly sawThinkingStall: false;
  readonly disableReasoning: false;
  readonly isRetry: false;
}

interface StreamAttemptDeadlineOptions extends Omit<StreamDeadlineOptions, "onTimeout"> {
  onTimeout?: (event: StreamTimeoutEvent) => void;
  timeoutError?: (event: StreamTimeoutEvent) => Error | undefined;
  timeoutMessage?: (event: StreamTimeoutEvent) => string;
}

export interface StreamAttempt {
  readonly signal: AbortSignal;
  startStreamDeadline(options: StreamAttemptDeadlineOptions): void;
  resetStreamDeadline(timeoutMs?: number, phase?: StreamTimeoutPhase): void;
  recordStreamKeepalive(): void;
  /** Takes one reasoning delta of the response. When the attempt detects repetition and the reasoning collapsed
   *  into it, the attempt aborts and fails with `DegenerateRepetitionError`. */
  observeReasoning(text: string): void;
  throwIfStreamTimedOut(): void;
}

type StreamAttemptOptions = Pick<StreamOptions, "signal" | "detectRepetition">;

/**
 * Owns one adapter stream attempt, from its deadline through iterator cleanup.
 * The adapter generator is created once and is never replayed.
 *
 * A caller's abort ends the attempt with the caller's own reason, whatever
 * error the provider SDK raised for the cancelled request: the
 * OpenAI and Anthropic SDKs reject it with an `APIUserAbortError` of their
 * own. Every reader then tells the abort, which is an outcome, from a
 * failure by the one reason the caller aborted with.
 * @yields {Event | StreamAttemptStartEvent} The attempt-start event, followed by the adapter's stream events.
 */
export async function* withStreamAttempt<Event>(
  run: (attempt: StreamAttempt) => AsyncGenerator<Event>,
  options: StreamAttemptOptions,
): AsyncGenerator<Event | StreamAttemptStartEvent> {
  const abort = new AbortController();
  const signal = mergeAbortSignals(options.signal, abort.signal);
  const failAttempt = (error: unknown): never => { throw options.signal?.aborted ? options.signal.reason : error; };
  let deadline: ReturnType<typeof createStreamDeadline> | undefined;
  let deadlineOptions: StreamAttemptDeadlineOptions | undefined;
  let callbackFailure: { error: unknown } | undefined;
  const repetition = options.detectRepetition ? reasoningRepetitionDetector() : undefined;

  const throwIfStreamTimedOut = (): void => {
    if (callbackFailure) throw callbackFailure.error;
    const timeout = deadline?.timeout;
    if (!timeout) return;
    const error = deadlineOptions?.timeoutError?.(timeout)
      ?? new StreamIdleTimeoutError(
        deadlineOptions?.timeoutMessage?.(timeout)
          ?? `Provider stream ${timeout.phase === "pre-stream" ? "pre-stream timeout" : "idle timeout"}`,
        timeout.phase,
      );
    throw normalizeProviderAttemptFailure(error);
  };

  const attempt: StreamAttempt = {
    signal,
    startStreamDeadline(nextOptions) {
      if (deadline) throw new Error("stream deadline already started for attempt");
      deadlineOptions = nextOptions;
      deadline = createStreamDeadline({
        ...nextOptions,
        onTimeout: (event) => {
          try {
            nextOptions.onTimeout?.(event);
          } catch (error) {
            callbackFailure = { error };
          } finally {
            abort.abort();
          }
        },
      });
    },
    resetStreamDeadline(timeoutMs, phase) {
      deadline?.reset(timeoutMs, phase);
    },
    recordStreamKeepalive() {
      deadline?.keepalive();
    },
    observeReasoning(text) {
      if (callbackFailure) return;
      const detected = repetition?.observe(text);
      if (detected === undefined) return;
      // The adapter's catch reads this failure through `throwIfStreamTimedOut` once the abort ends its stream.
      callbackFailure = { error: normalizeProviderAttemptFailure(detected) };
      abort.abort();
    },
    throwIfStreamTimedOut,
  };

  try {
    yield {
      kind: "stream_attempt_start",
      attempt: 1,
      maxAttempts: 1,
      isFinalAttempt: true,
      sawThinkingStall: false,
      disableReasoning: false,
      isRetry: false,
    };
    try {
      for await (const event of run(attempt)) {
        const resumeDeadline = deadline?.pause();
        try {
          yield event;
        } finally {
          resumeDeadline?.();
        }
      }
      attempt.throwIfStreamTimedOut();
    } catch (error) {
      if (!options.signal?.aborted) throwIfStreamTimedOut();
      failAttempt(error);
    }
  } finally {
    await deadline?.close();
  }
}
