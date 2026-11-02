import { describe, expect, test } from "bun:test";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { withStreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";

describe("stream attempt watchdog", () => {
  test("maps a watchdog timeout to ProviderAttemptFailure", async () => {
    let timedOut = false;
    const stream = withStreamAttempt(async function* (attempt) {
      attempt.startStreamDeadline({
        idleTimeoutMs: 1,
        onTimeout: () => { timedOut = true; },
        timeoutMessage: () => "stream deadline elapsed",
      });
      attempt.resetStreamDeadline();
      await new Promise<void>((resolve) => {
        attempt.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { kind: "unreachable" as const };
    }, {});

    let caught: unknown;
    try {
      for await (const _event of stream) {}
    } catch (error) {
      caught = error;
    }

    expect(timedOut).toBe(true);
    expect(caught).toBeInstanceOf(ProviderAttemptFailure);
    expect(caught).toMatchObject({ message: "stream deadline elapsed" });
  });

  test("detects a watchdog timeout after the adapter iterator completes", async () => {
    const stream = withStreamAttempt(async function* (attempt) {
      attempt.startStreamDeadline({
        idleTimeoutMs: 1,
        onTimeout: () => {},
        timeoutMessage: () => "completion raced timeout",
      });
      attempt.resetStreamDeadline();
      await new Promise<void>((resolve) => {
        attempt.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }, {});

    const drain = async () => {
      for await (const _event of stream) {}
    };
    await expect(drain()).rejects.toBeInstanceOf(ProviderAttemptFailure);
  });

  test("deadline setup and timeout telemetry failures escape unchanged", async () => {
    const setupFailure = new Error("telemetry failed");
    const stream = withStreamAttempt(async function* (attempt) {
      attempt.startStreamDeadline({
        idleTimeoutMs: 1,
        onTimeout: () => { throw setupFailure; },
      });
      attempt.resetStreamDeadline();
      await new Promise<void>((resolve) => {
        attempt.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }, {});

    const drain = async () => {
      for await (const _event of stream) {}
    };
    await expect(drain()).rejects.toBe(setupFailure);
  });
});
