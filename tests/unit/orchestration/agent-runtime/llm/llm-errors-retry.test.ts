import { describe, expect, test } from "bun:test";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/stream/provider-failure.js";
import { withStreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream/stream-attempt.js";

describe("stream attempt watchdog", () => {
  test("maps a watchdog timeout to ProviderAttemptFailure", async () => {
    let timedOut = false;
    const stream = withStreamAttempt(async function* (attempt) {
      attempt.armLiveness({
        label: "test", provider: "Test", idleTimeoutMs: 1,
        telemetry: { observe: (observation) => { if (observation.kind === "timeout") timedOut = true; } },
        timeoutMessage: () => "stream deadline elapsed",
      }).frame();
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
      attempt.armLiveness({ label: "test", provider: "Test", telemetry: undefined, idleTimeoutMs: 1, timeoutMessage: () => "completion raced timeout" }).frame();
      await new Promise<void>((resolve) => {
        attempt.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }, {});

    const drain = async () => {
      for await (const _event of stream) {}
    };
    await expect(drain()).rejects.toBeInstanceOf(ProviderAttemptFailure);
  });

  test("a failure of the timeout's own telemetry escapes unchanged", async () => {
    const setupFailure = new Error("telemetry failed");
    const stream = withStreamAttempt(async function* (attempt) {
      attempt.armLiveness({
        label: "test", provider: "Test", idleTimeoutMs: 1,
        telemetry: { observe: (observation) => { if (observation.kind === "timeout") throw setupFailure; } },
      }).frame();
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
