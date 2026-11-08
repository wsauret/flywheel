import { describe, expect, test } from "bun:test";
import { createStreamDeadline, isHeartbeatStreamEvent, STREAM_IDLE_TIMEOUT_FAST_MS, STREAM_REASONING_IDLE_TIMEOUT_MS } from "../../../../../src/orchestration/agent-runtime/llm/stream-watchdog.js";
import { armStreamLiveness, throwIfLivenessFailure } from "../../../../../src/orchestration/agent-runtime/llm/stream-liveness.js";
import type { StreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";
import { ThinkingStallError } from "../../../../../src/orchestration/agent-runtime/llm/thinking-stall.js";
import { controlledClock } from "./_stream-deadline-clock.js";

describe("isHeartbeatStreamEvent", () => {
  test("classifies OpenAI Responses keepalive frames as heartbeats", () => {
    expect(isHeartbeatStreamEvent("keepalive")).toBe(true);
  });

  test("real progress events are not heartbeats", () => {
    expect(isHeartbeatStreamEvent("response.output_text.delta")).toBe(false);
    expect(isHeartbeatStreamEvent("response.created")).toBe(false);
  });
});

describe("createStreamDeadline", () => {
  test("resets that only extend the deadline still time out from the last reset", async () => {
    // Each stream chunk resets the deadline; a reset that moves it later leaves
    // the watchdog asleep, and the timeout must still be measured from the last
    // reset, never from the one the watchdog went to sleep on.
    const time = controlledClock();
    const timeouts: unknown[] = [];
    const deadline = createStreamDeadline({ idleTimeoutMs: 100, clock: time.clock, onTimeout: (event) => timeouts.push(event) });
    try {
      deadline.reset();
      await time.advance(60);
      deadline.reset();
      await time.advance(60);
      deadline.reset();
      await time.advance(99);
      expect(timeouts).toEqual([]);
      await time.advance(1);
      expect(timeouts).toEqual([{ phase: "idle", idleTimeoutMs: 100 }]);
    } finally { await deadline.close(); }
  });

  test("a reset that moves the deadline earlier fires at the earlier time", async () => {
    const time = controlledClock();
    const timeouts: unknown[] = [];
    const deadline = createStreamDeadline({ idleTimeoutMs: 100, clock: time.clock, onTimeout: (event) => timeouts.push(event) });
    try {
      deadline.reset(500, "pre-stream");
      await time.advance(100);
      deadline.reset(50);
      await time.advance(49);
      expect(timeouts).toEqual([]);
      await time.advance(1);
      expect(timeouts).toEqual([{ phase: "idle", idleTimeoutMs: 50 }]);
    } finally { await deadline.close(); }
  });

  test("excludes consumer wait from the remaining idle deadline", async () => {
    const time = controlledClock();
    const timeouts: unknown[] = [];
    const deadline = createStreamDeadline({ idleTimeoutMs: 100, clock: time.clock, onTimeout: (event) => timeouts.push(event) });
    try {
      deadline.reset();
      await time.advance(30);
      const resume = deadline.pause();
      await time.advance(1_000);
      expect(timeouts).toEqual([]);
      resume();
      await time.advance(69);
      expect(timeouts).toEqual([]);
      await time.advance(1);
      expect(timeouts).toEqual([{ phase: "idle", idleTimeoutMs: 100 }]);
    } finally { await deadline.close(); }
  });

  test("retains TTFT time across nested pauses with idempotent releases", async () => {
    const time = controlledClock();
    const deadline = createStreamDeadline({ idleTimeoutMs: 20, clock: time.clock, onTimeout: () => {} });
    try {
      deadline.reset(100, "pre-stream");
      await time.advance(40);
      const outer = deadline.pause();
      await time.advance(100);
      const inner = deadline.pause();
      outer();
      outer();
      await time.advance(100);
      expect(deadline.timeout).toBeUndefined();
      inner();
      await time.advance(59);
      expect(deadline.timeout).toBeUndefined();
      await time.advance(1);
      expect(deadline.timeout).toEqual({ phase: "pre-stream", idleTimeoutMs: 100 });
    } finally { await deadline.close(); }
  });

  test("preserves the progress cap while paused heartbeats cannot time out", async () => {
    const time = controlledClock();
    const deadline = createStreamDeadline({ idleTimeoutMs: 20, progressCapMs: 40, clock: time.clock, onTimeout: () => {} });
    try {
      deadline.reset();
      await time.advance(15);
      deadline.keepalive();
      const resume = deadline.pause();
      await time.advance(1_000);
      expect(deadline.timeout).toBeUndefined();
      resume();
      await time.advance(15);
      expect(deadline.timeout).toBeUndefined();
      deadline.keepalive();
      await time.advance(9);
      expect(deadline.timeout).toBeUndefined();
      await time.advance(1);
      expect(deadline.timeout?.phase).toBe("idle");
    } finally { await deadline.close(); }
  });

  test("excludes local wait from stall thresholds and reported chunk age", async () => {
    const time = controlledClock();
    const stalls: number[] = [];
    const deadline = createStreamDeadline({ idleTimeoutMs: 100, clock: time.clock, stallThresholds: [20, 40], onTimeout: () => {}, onStall: (event) => stalls.push(event.lastChunkAgeMs) });
    try {
      deadline.reset();
      await time.advance(15);
      const resume = deadline.pause();
      await time.advance(1_000);
      expect(stalls).toEqual([]);
      resume();
      await time.advance(5);
      expect(stalls).toEqual([20]);
      await time.advance(20);
      expect(stalls).toEqual([20, 40]);
    } finally { await deadline.close(); }
  });

  test("resets observed while paused arm from the resumed clock", async () => {
    const time = controlledClock();
    const deadline = createStreamDeadline({ idleTimeoutMs: 20, clock: time.clock, onTimeout: () => {} });
    try {
      deadline.reset();
      await time.advance(5);
      const resume = deadline.pause();
      await time.advance(100);
      deadline.reset(30, "pre-stream");
      deadline.keepalive();
      await time.advance(100);
      resume();
      await time.advance(29);
      expect(deadline.timeout).toBeUndefined();
      await time.advance(1);
      expect(deadline.timeout).toEqual({ phase: "pre-stream", idleTimeoutMs: 30 });
    } finally { await deadline.close(); }
  });

  test("reuses the active timer across fast pause and resume pairs", async () => {
    const time = controlledClock();
    const deadline = createStreamDeadline({ idleTimeoutMs: 100, clock: time.clock, onTimeout: () => {} });
    try {
      deadline.reset();
      await time.advance(10);
      const sleeps = time.sleepCalls;
      expect(sleeps).toBeGreaterThan(0);
      for (let index = 0; index < 100; index += 1) deadline.pause()();
      await time.advance(1);
      expect(time.sleepCalls).toBe(sleeps);
      expect(time.pendingSleeps).toBe(1);
    } finally { await deadline.close(); }
  });

  test("closes and joins a paused watcher without waiting for release", async () => {
    const time = controlledClock();
    const timeouts: unknown[] = [];
    const deadline = createStreamDeadline({ idleTimeoutMs: 20, clock: time.clock, onTimeout: (event) => timeouts.push(event) });
    deadline.reset();
    const resume = deadline.pause();
    await time.advance(100);
    const closed = deadline.close();
    expect(deadline.close()).toBe(closed);
    await closed;
    expect(time.pendingSleeps).toBe(0);
    resume();
    deadline.pause()();
    await time.advance(100);
    expect(timeouts).toEqual([]);
  });

  test("keepalives re-arm the frame clock so a thinking pause survives", async () => {
    const time = controlledClock();
    let timedOut = false;
    const deadline = createStreamDeadline({
      idleTimeoutMs: 20,
      progressCapMs: 200,
      clock: time.clock,
      onTimeout: () => {
        timedOut = true;
      },
    });
    deadline.reset();
    await time.advance(15);
    deadline.keepalive();
    await time.advance(15);
    expect(timedOut).toBe(false);
    await deadline.close();
  });

  test("frame silence after a keepalive still fires the idle deadline", async () => {
    const time = controlledClock();
    let timedOut = false;
    const deadline = createStreamDeadline({
      idleTimeoutMs: 20,
      progressCapMs: 200,
      clock: time.clock,
      onTimeout: () => {
        timedOut = true;
      },
    });
    deadline.reset();
    await time.advance(5);
    deadline.keepalive();
    await time.advance(20);
    expect(timedOut).toBe(true);
    await deadline.close();
  });

  test("keepalives alone cannot extend real-event silence past the progress cap", async () => {
    const time = controlledClock();
    let timedOut = false;
    const deadline = createStreamDeadline({
      idleTimeoutMs: 20,
      progressCapMs: 40,
      clock: time.clock,
      onTimeout: () => {
        timedOut = true;
      },
    });
    deadline.reset();
    for (let i = 0; i < 6; i++) {
      await time.advance(10);
      deadline.keepalive();
    }
    expect(timedOut).toBe(true);
    await deadline.close();
  });

  test("a TTFT-length reset is never shortened by a smaller progress cap", async () => {
    const time = controlledClock();
    let timedOut = false;
    const deadline = createStreamDeadline({
      idleTimeoutMs: 200,
      ttftTimeoutMs: 600,
      progressCapMs: 300,
      clock: time.clock,
      onTimeout: () => {
        timedOut = true;
      },
    });
    deadline.reset(600, "pre-stream");
    await time.advance(250);
    await time.advance(250);
    expect(timedOut).toBe(false);
    await time.advance(250);
    expect(timedOut).toBe(true);
    expect(deadline.timeout?.phase).toBe("pre-stream");
    await deadline.close();
  });
});

describe("armStreamLiveness", () => {
  test("uses one five-minute deadline only while a reasoning block is active", () => {
    const resets: number[] = [];
    const attempt = {
      signal: new AbortController().signal,
      startStreamDeadline: () => {},
      resetStreamDeadline: (timeoutMs) => { resets.push(timeoutMs ?? -1); },
      recordStreamKeepalive: () => {},
      observeReasoning: () => {},
      throwIfStreamTimedOut: () => {},
    } satisfies StreamAttempt;
    const liveness = armStreamLiveness(attempt, { label: "test", provider: "Test", telemetry: undefined });

    liveness.begin("reasoning:0");
    liveness.append("working");
    liveness.frame();
    liveness.complete("reasoning:0");

    expect(STREAM_REASONING_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(resets).toEqual([
      STREAM_REASONING_IDLE_TIMEOUT_MS,
      STREAM_REASONING_IDLE_TIMEOUT_MS,
      STREAM_REASONING_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_FAST_MS,
    ]);
  });

  test("uses the configured reasoning timeout as the active stream deadline", () => {
    const previous = process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
    const resets: number[] = [];
    process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS = "420000";
    try {
      const attempt = {
        signal: new AbortController().signal,
        startStreamDeadline: () => {},
        resetStreamDeadline: (timeoutMs) => { resets.push(timeoutMs ?? -1); },
        recordStreamKeepalive: () => {},
        observeReasoning: () => {},
        throwIfStreamTimedOut: () => {},
      } satisfies StreamAttempt;
      armStreamLiveness(attempt, { label: "test", provider: "Test", telemetry: undefined }).begin("reasoning:0");
      expect(resets).toEqual([420_000]);
    } finally {
      if (previous === undefined) delete process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
      else process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS = previous;
    }
  });

  test("classifies deadline expiry during reasoning as a thinking stall", () => {
    let deadlineOptions: Parameters<StreamAttempt["startStreamDeadline"]>[0] | undefined;
    const attempt = {
      signal: new AbortController().signal,
      startStreamDeadline: (options) => { deadlineOptions = options; },
      resetStreamDeadline: () => {},
      recordStreamKeepalive: () => {},
      observeReasoning: () => {},
      throwIfStreamTimedOut: () => {},
    } satisfies StreamAttempt;
    const liveness = armStreamLiveness(attempt, { label: "test", provider: "Test", telemetry: undefined });
    liveness.begin("reasoning:0");
    liveness.append("working");

    if (!deadlineOptions) throw new Error("stream deadline was not armed");
    const event = { phase: "idle", idleTimeoutMs: STREAM_REASONING_IDLE_TIMEOUT_MS } as const;
    deadlineOptions.onTimeout?.(event);

    const timeout = deadlineOptions.timeoutError?.(event);
    expect(timeout).toBeInstanceOf(ThinkingStallError);
    expect(timeout).toMatchObject({ blockKey: "reasoning:0", summary: "working" });
  });

  test("preserves caller cancellation when it races a deadline", () => {
    const caller = new AbortController();
    caller.abort();
    const attempt = {
      signal: new AbortController().signal,
      startStreamDeadline: () => {},
      resetStreamDeadline: () => {},
      recordStreamKeepalive: () => {},
      observeReasoning: () => {},
      throwIfStreamTimedOut: () => { throw new ThinkingStallError({ elapsedMs: 300_000, summary: "working" }); },
    } satisfies StreamAttempt;

    expect(() => throwIfLivenessFailure(new Error("caller cancelled"), attempt, caller.signal)).toThrow("caller cancelled");
  });
});
