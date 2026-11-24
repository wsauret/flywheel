import { describe, expect, test } from "bun:test";
import {
  createStreamLiveness,
  isHeartbeatStreamEvent,
  STREAM_IDLE_TIMEOUT_FAST_MS,
  STREAM_REASONING_IDLE_TIMEOUT_MS,
  STREAM_TTFT_TIMEOUT_MS,
  type StreamLivenessOptions,
} from "../../../../../src/orchestration/agent-runtime/llm/stream-liveness.js";
import { throwIfLivenessFailure, type StreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";
import type { StreamTelemetryObservation } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { ThinkingStallError } from "../../../../../src/orchestration/agent-runtime/llm/thinking-stall.js";
import { controlledClock } from "./_stream-deadline-clock.js";

/** One liveness owner on a controlled clock, with the watchdog observations it reports. */
function ownedLiveness(options: Partial<StreamLivenessOptions> = {}) {
  const time = controlledClock();
  const observed: StreamTelemetryObservation[] = [];
  let expiredCount = 0;
  const liveness = createStreamLiveness({
    label: "test",
    provider: "Test",
    telemetry: { observe: (observation) => { observed.push(observation); } },
    clock: time.clock,
    ...options,
  }, { onExpired: () => { expiredCount += 1; }, onReasoning: () => {} });
  const watchdog = (kind: string) => observed.filter((observation) => observation.source === "watchdog" && observation.kind === kind).map((observation) => observation.metadata);
  return {
    time,
    liveness,
    timeouts: () => watchdog("timeout"),
    stalls: () => watchdog("stall").map((metadata) => (typeof metadata === "function" ? metadata() : metadata)?.lastChunkAgeMs),
    thinkingStalls: () => watchdog("thinking_stall"),
    expiredCount: () => expiredCount,
  };
}

describe("isHeartbeatStreamEvent", () => {
  test("classifies OpenAI Responses keepalive frames as heartbeats", () => {
    expect(isHeartbeatStreamEvent("keepalive")).toBe(true);
  });

  test("real progress events are not heartbeats", () => {
    expect(isHeartbeatStreamEvent("response.output_text.delta")).toBe(false);
    expect(isHeartbeatStreamEvent("response.created")).toBe(false);
  });
});

describe("stream liveness deadline", () => {
  test("a stream silent past its deadline still fails with the stall error, once", async () => {
    const { time, liveness, timeouts, expiredCount } = ownedLiveness({ idleTimeoutMs: 100, timeoutMessage: () => "Test stream idle timeout" });
    liveness.frame();
    await time.advance(99);
    expect(liveness.failure).toBeUndefined();
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 100 }]);
    expect(expiredCount()).toBe(1);
    const failure = liveness.failure?.error;
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    expect(failure).toMatchObject({ message: "Test stream idle timeout" });
    await time.advance(1_000);
    expect(expiredCount()).toBe(1);
  });

  test("frames that only extend the deadline still time out from the last frame", async () => {
    // Each frame moves the deadline later and leaves the pending timer alone;
    // the timeout is still measured from the last frame.
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 100 });
    liveness.frame();
    await time.advance(60);
    liveness.frame();
    await time.advance(60);
    liveness.frame();
    await time.advance(99);
    expect(timeouts()).toEqual([]);
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 100 }]);
  });

  test("a frame that moves the deadline earlier fires at the earlier time", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 50 });
    liveness.preStream();
    await time.advance(100);
    liveness.frame();
    await time.advance(49);
    expect(timeouts()).toEqual([]);
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 50 }]);
  });

  test("a pause holds the deadline", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 100 });
    liveness.frame();
    await time.advance(30);
    const resume = liveness.pause();
    await time.advance(1_000);
    expect(timeouts()).toEqual([]);
    resume();
    await time.advance(69);
    expect(timeouts()).toEqual([]);
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 100 }]);
  });

  test("frames during a pause do not count: they arm from the pause start, so the paused time gives no credit", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 20 });
    liveness.frame();
    await time.advance(5);
    const resume = liveness.pause();
    await time.advance(100);
    liveness.frame();
    liveness.keepalive();
    await time.advance(100);
    resume();
    await time.advance(19);
    expect(timeouts()).toEqual([]);
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 20 }]);
  });

  test("retains TTFT time across nested pauses with idempotent releases", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 20 });
    liveness.preStream();
    await time.advance(40);
    const outer = liveness.pause();
    await time.advance(100);
    const inner = liveness.pause();
    outer();
    outer();
    await time.advance(100);
    expect(liveness.failure).toBeUndefined();
    inner();
    await time.advance(STREAM_TTFT_TIMEOUT_MS - 41);
    expect(liveness.failure).toBeUndefined();
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "pre-stream", idleTimeoutMs: STREAM_TTFT_TIMEOUT_MS }]);
  });

  test("preserves the progress cap while paused heartbeats cannot time out", async () => {
    // The progress cap (five minutes of real-event silence) is shorter than the
    // frame clock that the keepalives keep re-arming.
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 200_000 });
    liveness.frame();
    await time.advance(150_000);
    liveness.keepalive();
    const resume = liveness.pause();
    await time.advance(1_000_000);
    expect(timeouts()).toEqual([]);
    resume();
    await time.advance(100_000);
    expect(timeouts()).toEqual([]);
    liveness.keepalive();
    await time.advance(49_999);
    expect(timeouts()).toEqual([]);
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 200_000 }]);
  });

  test("excludes local wait from stall thresholds and reported chunk age", async () => {
    const { time, liveness, stalls } = ownedLiveness({ idleTimeoutMs: 100, stallThresholds: [20, 40] });
    liveness.frame();
    await time.advance(15);
    const resume = liveness.pause();
    await time.advance(1_000);
    expect(stalls()).toEqual([]);
    resume();
    await time.advance(5);
    expect(stalls()).toEqual([20]);
    await time.advance(20);
    expect(stalls()).toEqual([20, 40]);
  });

  test("reuses the pending timer across frames and fast pause and resume pairs", async () => {
    const { time, liveness } = ownedLiveness({ idleTimeoutMs: 100 });
    liveness.frame();
    await time.advance(10);
    const timers = time.sleepCalls;
    expect(timers).toBeGreaterThan(0);
    for (let index = 0; index < 100; index += 1) {
      liveness.frame();
      liveness.pause()();
    }
    await time.advance(1);
    expect(time.sleepCalls).toBe(timers);
    expect(time.pendingSleeps).toBe(1);
  });

  test("closing a paused owner cancels its timer and ignores later releases", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 20 });
    liveness.frame();
    const resume = liveness.pause();
    await time.advance(100);
    liveness.close();
    expect(time.pendingSleeps).toBe(0);
    resume();
    liveness.pause()();
    liveness.frame();
    await time.advance(100);
    expect(timeouts()).toEqual([]);
  });

  test("keepalives re-arm the frame clock so a quiet stream survives", async () => {
    const { time, liveness } = ownedLiveness({ idleTimeoutMs: 20 });
    liveness.frame();
    await time.advance(15);
    liveness.keepalive();
    await time.advance(15);
    expect(liveness.failure).toBeUndefined();
  });

  test("frame silence after a keepalive still fires the idle deadline", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 20 });
    liveness.frame();
    await time.advance(5);
    liveness.keepalive();
    await time.advance(20);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 20 }]);
  });

  test("keepalives alone cannot extend real-event silence past the progress cap", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 100_000 });
    liveness.frame();
    for (let i = 0; i < 6; i++) {
      await time.advance(50_000);
      liveness.keepalive();
    }
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: 100_000 }]);
  });

  test("a TTFT-length deadline is never shortened by the progress cap", async () => {
    const { time, liveness, timeouts } = ownedLiveness({ idleTimeoutMs: 200 });
    liveness.preStream();
    await time.advance(STREAM_TTFT_TIMEOUT_MS - 1);
    expect(timeouts()).toEqual([]);
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "pre-stream", idleTimeoutMs: STREAM_TTFT_TIMEOUT_MS }]);
  });
});

describe("stream liveness reasoning policy", () => {
  test("uses one five-minute deadline only while a reasoning block is active", async () => {
    expect(STREAM_REASONING_IDLE_TIMEOUT_MS).toBe(300_000);
    const { time, liveness, timeouts, thinkingStalls } = ownedLiveness();
    liveness.begin("reasoning:0");
    liveness.append("working");
    await time.advance(STREAM_REASONING_IDLE_TIMEOUT_MS - 1);
    liveness.frame();
    await time.advance(STREAM_REASONING_IDLE_TIMEOUT_MS - 1);
    expect(liveness.failure).toBeUndefined();
    liveness.complete("reasoning:0");
    await time.advance(STREAM_IDLE_TIMEOUT_FAST_MS - 1);
    expect(liveness.failure).toBeUndefined();
    await time.advance(1);
    expect(timeouts()).toEqual([{ phase: "idle", idleTimeoutMs: STREAM_IDLE_TIMEOUT_FAST_MS }]);
    expect(thinkingStalls()).toEqual([]);
  });

  test("uses the configured reasoning timeout as the active stream deadline", async () => {
    const previous = process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
    process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS = "420000";
    try {
      const { time, liveness, thinkingStalls } = ownedLiveness();
      liveness.begin("reasoning:0");
      await time.advance(419_999);
      expect(liveness.failure).toBeUndefined();
      await time.advance(1);
      expect(thinkingStalls()).toEqual([{ blockKey: "reasoning:0", elapsedMs: 420_000, summaryChars: 0 }]);
    } finally {
      if (previous === undefined) delete process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
      else process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS = previous;
    }
  });

  test("a thinking stall reports summaryChars equal to the streamed reasoning length", async () => {
    const { time, liveness, timeouts, thinkingStalls } = ownedLiveness();
    liveness.begin("reasoning:0");
    liveness.append("working");
    liveness.append(" on it");
    await time.advance(STREAM_REASONING_IDLE_TIMEOUT_MS);
    expect(thinkingStalls()).toEqual([{ blockKey: "reasoning:0", elapsedMs: STREAM_REASONING_IDLE_TIMEOUT_MS, summaryChars: "working on it".length }]);
    expect(timeouts()).toEqual([]);
    const failure = liveness.failure?.error;
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error(`expected a provider attempt failure, got ${String(failure)}`);
    expect(failure.cause).toBeInstanceOf(ThinkingStallError);
    expect(failure.cause).toMatchObject({ blockKey: "reasoning:0" });
  });

  test("preserves caller cancellation when it races a deadline", () => {
    const caller = new AbortController();
    caller.abort();
    const attempt = {
      signal: new AbortController().signal,
      armLiveness: () => { throw new Error("not armed in this test"); },
      throwIfStreamTimedOut: () => { throw new ThinkingStallError({ elapsedMs: 300_000 }); },
    } satisfies StreamAttempt;

    expect(() => throwIfLivenessFailure(new Error("caller cancelled"), attempt, caller.signal)).toThrow("caller cancelled");
  });
});
