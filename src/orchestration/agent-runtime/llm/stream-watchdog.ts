import { Clock, Deferred, Effect, Fiber, Ref } from "effect";
import { Log } from "../../../infra/log.js";

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
 * reports them to the deadline via `keepalive()` - re-arming the frame clock
 * but not the progress clock - and otherwise skips them. (Anthropic `ping`
 * heartbeats never reach the adapter loop; its SDK drops them while parsing
 * the SSE stream.)
 */
const HEARTBEAT_EVENT_KINDS = new Set(["keepalive"]);

export function isHeartbeatStreamEvent(kind: string): boolean {
  return HEARTBEAT_EVENT_KINDS.has(kind);
}

export type StreamTimeoutPhase = "pre-stream" | "idle";

export interface StreamTimeoutEvent {
  readonly phase: StreamTimeoutPhase;
  readonly idleTimeoutMs: number;
}

/**
 * Stream deadline: fails a stalled stream after neither clock is re-armed.
 * One Effect fiber owns the request-scoped lifecycle; resets and keepalives
 * only update a Ref and wake that fiber.
 */
export interface StreamDeadlineOptions {
  idleTimeoutMs: number;
  ttftTimeoutMs?: number;
  /** Bound on real-event silence while heartbeats keep the frame clock
   *  alive. Effective cap is max(activeDeadlineMs, progressCapMs), so a
   *  longer TTFT or PATIENT base deadline is never shortened. Defaults to
   *  STREAM_IDLE_TIMEOUT_PATIENT_MS; injectable for tests. */
  progressCapMs?: number;
  onTimeout: (event: StreamTimeoutEvent) => void;
  onStall?: (event: { lastChunkAgeMs: number; idleDeadlineMs: number; thresholdMs: number }) => void;
  stallThresholds?: readonly number[];
  /** Log service label (e.g. "llm-anthropic"). Defaults to "llm-stream". */
  label?: string;
  /** Clock seam for deterministic deadline tests. Production uses the
   *  monotonic runtime clock. */
  clock?: Clock.Clock;
}

export interface StreamDeadline {
  readonly timeout: StreamTimeoutEvent | undefined;
  reset(timeoutMs?: number, phase?: StreamTimeoutPhase): void;
  /** Heartbeat frame observed: re-arms the frame clock only. */
  keepalive(): void;
  /** Exclude local consumer work from every deadline clock. Nested leases
   *  keep the clocks paused until each idempotent release has run. */
  pause(): () => void;
  close(): Promise<void>;
}

interface StreamDeadlineState {
  readonly timedOut: boolean;
  readonly timeout: StreamTimeoutEvent | undefined;
  readonly closed: boolean;
  readonly generation: number;
  /** Last real-event reset; starts the progress clock. 0 until first armed. */
  readonly lastResetAt: number;
  /** Last heartbeat frame; frame clock runs from max(lastResetAt, lastKeepaliveAt). */
  readonly lastKeepaliveAt: number;
  readonly activeDeadlineMs: number;
  readonly activePhase: StreamTimeoutPhase;
  readonly stallIndex: number;
  readonly pauseCount: number;
  readonly pausedAt: number | undefined;
  readonly waitingWhilePaused: boolean;
  readonly wake: Deferred.Deferred<void>;
}

type DeadlineTarget =
  | { kind: "stall"; atMs: number; thresholdMs: number }
  | { kind: "timeout"; atMs: number };

export function createStreamDeadline(opts: StreamDeadlineOptions): StreamDeadline {
  const { idleTimeoutMs, label } = opts;
  const deadlineLog = Log.create({ service: label ?? "llm-stream" });
  const state = Ref.makeUnsafe<StreamDeadlineState>({
    timedOut: false,
    timeout: undefined,
    closed: false,
    generation: 0,
    lastResetAt: 0,
    lastKeepaliveAt: 0,
    activeDeadlineMs: idleTimeoutMs,
    activePhase: "idle",
    stallIndex: 0,
    pauseCount: 0,
    pausedAt: undefined,
    waitingWhilePaused: false,
    wake: Deferred.makeUnsafe<void>(),
  });
  const loop = streamDeadlineLoop(state, opts, deadlineLog);
  const fiber = Effect.runFork(opts.clock ? Effect.provideService(loop, Clock.Clock, opts.clock) : loop);
  let closePromise: Promise<void> | null = null;

  // A change that only moves the armed deadline later leaves the fiber asleep:
  // when its sleep ends it finds the generation changed and re-arms from the
  // new state. Every stream chunk resets the deadline, so waking the fiber per
  // chunk cost one fiber resume per token in every streaming session. The
  // fiber is woken when it waits on the deferred itself (nothing armed yet, or
  // paused), when the deadline moves earlier, and when the deadline closes.
  function wake(update: (current: StreamDeadlineState) => StreamDeadlineState): void {
    const deferred = Effect.runSync(Ref.modify(state, (current) => {
      const next = update(current);
      const sleepsUndisturbed = current.lastResetAt !== 0 && current.pauseCount === 0 && !current.closed && !next.closed
        && next.lastResetAt !== 0 && next.pauseCount === 0
        && deadlineTarget(next, opts).atMs >= deadlineTarget(current, opts).atMs;
      if (sleepsUndisturbed) return [undefined, next] as const;
      return [current.wake, { ...next, wake: Deferred.makeUnsafe<void>() }] as const;
    }));
    if (deferred) Effect.runSync(Deferred.succeed(deferred, undefined));
  }

  return {
    get timeout() { return Ref.getUnsafe(state).timeout; },
    reset(timeoutMs?: number, phase: StreamTimeoutPhase = "idle") {
      wake((current) => ({
        ...current,
        generation: current.generation + 1,
        lastResetAt: current.pausedAt ?? currentTimeMs(opts),
        activeDeadlineMs: timeoutMs ?? idleTimeoutMs,
        activePhase: phase,
        stallIndex: 0,
      }));
    },
    keepalive() {
      wake((current) => ({
        ...current,
        generation: current.generation + 1,
        lastKeepaliveAt: current.pausedAt ?? currentTimeMs(opts),
      }));
    },
    pause() {
      Effect.runSync(Ref.update(state, (current) => current.closed || current.timedOut ? current : {
        ...current,
        generation: current.generation + 1,
        pauseCount: current.pauseCount + 1,
        pausedAt: current.pausedAt ?? currentTimeMs(opts),
      }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const deferred = Effect.runSync(Ref.modify(state, (current) => resumeDeadline(current, currentTimeMs(opts))));
        if (deferred) Effect.runSync(Deferred.succeed(deferred, undefined));
      };
    },
    close(): Promise<void> {
      wake((current) => ({ ...current, closed: true }));
      closePromise ??= Effect.runPromise(Fiber.interrupt(fiber));
      return closePromise;
    },
  };
}

function resumeDeadline(current: StreamDeadlineState, now: number): readonly [Deferred.Deferred<void> | undefined, StreamDeadlineState] {
  if (current.closed || current.timedOut || current.pausedAt === undefined) return [undefined, current];
  if (current.pauseCount > 1) return [undefined, { ...current, pauseCount: current.pauseCount - 1 }];
  const elapsed = now - current.pausedAt;
  return [current.waitingWhilePaused ? current.wake : undefined, {
    ...current,
    generation: current.generation + 1,
    pauseCount: 0,
    pausedAt: undefined,
    waitingWhilePaused: false,
    lastResetAt: current.lastResetAt === 0 ? 0 : current.lastResetAt + elapsed,
    lastKeepaliveAt: current.lastKeepaliveAt === 0 ? 0 : current.lastKeepaliveAt + elapsed,
    // Keep a sleeping deadline in place across fast consumer yields. Only
    // resume the fiber if it already woke and parked for a longer pause.
    wake: current.waitingWhilePaused ? Deferred.makeUnsafe<void>() : current.wake,
  }];
}

function streamDeadlineLoop(
  state: Ref.Ref<StreamDeadlineState>,
  opts: StreamDeadlineOptions,
  deadlineLog: ReturnType<typeof Log.create>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const snapshot = yield* Ref.get(state);
      if (snapshot.closed || snapshot.timedOut) return;
      if (snapshot.pauseCount > 0) {
        const pausedWake = yield* Ref.modify(state, (current) => current.pauseCount > 0 && !current.closed && !current.timedOut
          ? [current.wake, { ...current, waitingWhilePaused: true }] as const
          : [undefined, current] as const);
        if (pausedWake) yield* Deferred.await(pausedWake);
        continue;
      }
      if (snapshot.lastResetAt === 0) {
        yield* Deferred.await(snapshot.wake);
        continue;
      }

      const target = deadlineTarget(snapshot, opts);
      const woke = yield* Effect.raceFirst(
        Deferred.await(snapshot.wake).pipe(Effect.as("wake" as const)),
        Effect.sleep(Math.max(0, target.atMs - currentTimeMs(opts))).pipe(Effect.as("deadline" as const)),
      );
      if (woke === "wake") continue;

      const keepWatching = yield* handleExpiredDeadline(state, opts, deadlineLog, snapshot.generation, target);
      if (!keepWatching) return;
    }
  });
}

function deadlineTarget(snapshot: StreamDeadlineState, opts: StreamDeadlineOptions): DeadlineTarget {
  const thresholdMs = opts.stallThresholds?.[snapshot.stallIndex];
  if (thresholdMs !== undefined && thresholdMs < snapshot.activeDeadlineMs) {
    return { kind: "stall", atMs: snapshot.lastResetAt + thresholdMs, thresholdMs };
  }
  const frameAt = Math.max(snapshot.lastResetAt, snapshot.lastKeepaliveAt);
  const progressCapMs = Math.max(snapshot.activeDeadlineMs, opts.progressCapMs ?? STREAM_IDLE_TIMEOUT_PATIENT_MS);
  return { kind: "timeout", atMs: Math.min(frameAt + snapshot.activeDeadlineMs, snapshot.lastResetAt + progressCapMs) };
}

function handleExpiredDeadline(
  state: Ref.Ref<StreamDeadlineState>,
  opts: StreamDeadlineOptions,
  deadlineLog: ReturnType<typeof Log.create>,
  expectedGeneration: number,
  target: DeadlineTarget,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.closed || current.timedOut || current.pauseCount > 0 || current.generation !== expectedGeneration) return true;
    const now = currentTimeMs(opts);

    if (target.kind === "stall") return yield* handleStallDeadline(state, opts, deadlineLog, current, now - current.lastResetAt, target.thresholdMs);
    if (deadlineShouldRearm(current, now, target)) {
      yield* rearmDeadline(state, deadlineLog, current.generation, now);
      return true;
    }

    const timeout = timeoutEvent(current);
    // The mark is atomic with a re-check of the generation: the fiber may
    // yield between the read above and this write, and a racing reset() or
    // keepalive() must win over the now-stale expiry.
    const marked = yield* Ref.modify(state, (next) => next.generation === expectedGeneration && !next.closed && !next.timedOut && next.pauseCount === 0
      ? [true as const, { ...next, timedOut: true, timeout }]
      : [false as const, next]);
    if (!marked) return true;
    deadlineLog.warn("stream idle timeout", { phase: timeout.phase, idleMs: current.activeDeadlineMs, lateMs: Math.round(now - target.atMs) });
    yield* Effect.sync(() => opts.onTimeout(timeout));
    return false;
  });
}

function handleStallDeadline(
  state: Ref.Ref<StreamDeadlineState>,
  opts: StreamDeadlineOptions,
  deadlineLog: ReturnType<typeof Log.create>,
  current: StreamDeadlineState,
  actual: number,
  thresholdMs: number,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (actual < thresholdMs / 2) return true;
    const marked = yield* Ref.modify(state, (next) => next.generation === current.generation && !next.closed && !next.timedOut && next.pauseCount === 0
      ? [true as const, { ...next, stallIndex: next.stallIndex + 1 }]
      : [false as const, next]);
    if (!marked) return true;
    deadlineLog.warn("stream idle partial", {
      lastChunkAgeMs: Math.round(actual),
      idleDeadlineMs: current.activeDeadlineMs,
    });
    yield* Effect.sync(() => opts.onStall?.({
      lastChunkAgeMs: Math.round(actual),
      idleDeadlineMs: current.activeDeadlineMs,
      thresholdMs,
    }));
    return true;
  });
}

/** The sleep woke far earlier on the monotonic clock than the deadline
 *  requires (wall clock advanced during system sleep or skewed); re-arm
 *  instead of firing. */
function deadlineShouldRearm(current: StreamDeadlineState, now: number, target: Extract<DeadlineTarget, { kind: "timeout" }>): boolean {
  return Math.round(now - target.atMs) < -(current.activeDeadlineMs / 2);
}

function rearmDeadline(
  state: Ref.Ref<StreamDeadlineState>,
  deadlineLog: ReturnType<typeof Log.create>,
  generation: number,
  now: number,
): Effect.Effect<void> {
  deadlineLog.warn("stream deadline suppressed (clock skew / system sleep), re-arming");
  return Ref.update(state, (next) => next.generation === generation
    ? { ...next, generation: next.generation + 1, lastResetAt: now, stallIndex: 0 }
    : next);
}

function currentTimeMs(opts: StreamDeadlineOptions): number {
  return opts.clock?.currentTimeMillisUnsafe() ?? performance.now();
}

function timeoutEvent(current: StreamDeadlineState): StreamTimeoutEvent {
  return {
    phase: current.activePhase,
    idleTimeoutMs: current.activeDeadlineMs,
  };
}
