import { mergeAbortSignals } from "../../../infra/abort.js";
import { normalizeProviderAttemptFailure } from "./provider-failure.js";
import { reasoningRepetitionDetector } from "./reasoning-repetition.js";
import { createStreamLiveness, type AttemptLiveness, type StreamLiveness, type StreamLivenessOptions } from "./stream-liveness.js";
import type { StreamOptions } from "./types.js";

export interface StreamAttemptStartEvent {
  readonly kind: "stream_attempt_start";
  /** The attempt requests reasoning off because it is the last resample of a response that repeated itself
   *  (`RepetitionGuard`). */
  readonly disableReasoning: boolean;
}

export interface StreamAttempt {
  readonly signal: AbortSignal;
  /** Arms the attempt's one liveness owner. The deadline starts at the first report (`preStream` or `frame`);
   *  when it expires the attempt aborts and fails with its typed timeout. Each reasoning delta also feeds the
   *  attempt's repetition guard. An attempt arms liveness at most once. */
  armLiveness(options: StreamLivenessOptions): StreamLiveness;
  throwIfStreamTimedOut(): void;
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

type StreamAttemptOptions = Pick<StreamOptions, "signal" | "repetitionGuard">;

/**
 * Owns one adapter stream attempt, from its liveness through iterator cleanup.
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
  let liveness: AttemptLiveness | undefined;
  let repetitionFailure: { error: unknown } | undefined;
  const repetition = options.repetitionGuard === "detect" ? reasoningRepetitionDetector() : undefined;

  const observeReasoning = (text: string): void => {
    if (repetitionFailure) return;
    const detected = repetition?.observe(text);
    if (detected === undefined) return;
    // The adapter's catch reads this failure through `throwIfStreamTimedOut` once the abort ends its stream.
    repetitionFailure = { error: normalizeProviderAttemptFailure(detected) };
    abort.abort();
  };

  const throwIfStreamTimedOut = (): void => {
    const failure = repetitionFailure ?? liveness?.failure;
    if (failure) throw failure.error;
  };

  const attempt: StreamAttempt = {
    signal,
    armLiveness(livenessOptions) {
      if (liveness) throw new Error("stream liveness already armed for attempt");
      liveness = createStreamLiveness(livenessOptions, { onExpired: () => { abort.abort(); }, onReasoning: observeReasoning });
      return liveness;
    },
    throwIfStreamTimedOut,
  };

  try {
    yield { kind: "stream_attempt_start", disableReasoning: options.repetitionGuard === "reasoning_off" };
    try {
      for await (const event of run(attempt)) {
        const resume = liveness?.pause();
        try {
          yield event;
        } finally {
          resume?.();
        }
      }
      attempt.throwIfStreamTimedOut();
    } catch (error) {
      if (!options.signal?.aborted) throwIfStreamTimedOut();
      failAttempt(error);
    }
  } finally {
    liveness?.close();
  }
}
