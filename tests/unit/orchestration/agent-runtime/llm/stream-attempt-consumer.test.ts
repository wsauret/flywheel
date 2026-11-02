import { describe, expect, test } from "bun:test";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { withStreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";
import { controlledClock } from "./_stream-deadline-clock.js";

describe("stream attempt consumer time", () => {
  test("excludes a held consumer and resumes the remaining provider deadline", async () => {
    const time = controlledClock();
    let timedOut = false;
    const stream = withStreamAttempt(async function* (attempt) {
      attempt.startStreamDeadline({ idleTimeoutMs: 20, clock: time.clock, onTimeout: () => { timedOut = true; } });
      attempt.resetStreamDeadline();
      await time.advance(7);
      yield { kind: "text_delta", text: "first" } as const;
      await new Promise<void>((resolve) => { attempt.signal.addEventListener("abort", () => resolve(), { once: true }); });
      attempt.throwIfStreamTimedOut();
    }, {});

    try {
      expect(await stream.next()).toMatchObject({ value: { kind: "stream_attempt_start" } });
      expect(await stream.next()).toMatchObject({ value: { kind: "text_delta", text: "first" } });
      await time.advance(100);
      expect(timedOut).toBe(false);
      const next = stream.next().then(() => undefined, (error: unknown) => error);
      await time.advance(12);
      expect(timedOut).toBe(false);
      await time.advance(1);
      expect(timedOut).toBe(true);
      expect(await next).toBeInstanceOf(ProviderAttemptFailure);
    } finally {
      await stream.return(undefined);
    }
  });

  test("caller cancellation while consuming still closes the adapter", async () => {
    const time = controlledClock();
    const abort = new AbortController();
    const closed: string[] = [];
    const stream = withStreamAttempt(async function* (attempt) {
      attempt.startStreamDeadline({ idleTimeoutMs: 20, clock: time.clock });
      attempt.resetStreamDeadline();
      try {
        yield { kind: "text_delta", text: "first" } as const;
      } finally {
        await Promise.resolve();
        closed.push("adapter");
      }
    }, {
      signal: abort.signal,
    });

    await stream.next();
    await stream.next();
    abort.abort();
    await stream.return(undefined);
    expect(closed).toEqual(["adapter"]);
    await time.advance(100);
    expect(closed).toEqual(["adapter"]);
  });
});
