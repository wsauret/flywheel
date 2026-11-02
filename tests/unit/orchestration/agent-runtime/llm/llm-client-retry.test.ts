import { describe, expect, test } from "bun:test";
import { APIUserAbortError } from "openai";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { withStreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";

type TestEvent = { kind: "text_delta"; text: string };

async function collect(stream: AsyncGenerator<TestEvent | { kind: "stream_attempt_start" }>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("withStreamAttempt", () => {
  test("executes the supplied adapter generator exactly once and delivers events immediately", async () => {
    let calls = 0;
    const iterator = withStreamAttempt(async function* () {
      calls += 1;
      yield { kind: "text_delta", text: "one" } as const;
      yield { kind: "text_delta", text: "two" } as const;
    }, {});

    expect(await iterator.next()).toMatchObject({ value: { kind: "stream_attempt_start" }, done: false });
    expect(calls).toBe(0);
    expect(await iterator.next()).toMatchObject({ value: { kind: "text_delta", text: "one" }, done: false });
    expect(calls).toBe(1);
    expect((await collect(iterator)).at(-1)).toEqual({ kind: "text_delta", text: "two" });
    expect(calls).toBe(1);
  });

  test("does not retry a provider attempt failure", async () => {
    let calls = 0;
    const failure = normalizeProviderAttemptFailure(Object.assign(new Error("torn stream"), { status: 503 }));
    const stream = withStreamAttempt(async function* (): AsyncGenerator<TestEvent> {
      calls += 1;
      throw failure;
    }, {});

    await expect(collect(stream)).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  test("awaits adapter cleanup when the consumer closes early", async () => {
    let adapterClosed = false;
    const stream = withStreamAttempt(async function* () {
      try {
        yield { kind: "text_delta", text: "one" } as const;
        yield { kind: "text_delta", text: "two" } as const;
      } finally {
        await Promise.resolve();
        adapterClosed = true;
      }
    }, {});

    for await (const event of stream) {
      if (event.kind === "text_delta") break;
    }

    expect(adapterClosed).toBe(true);
  });

  test("a caller's abort ends the attempt with the caller's own reason, whatever error the provider SDK raised for it", async () => {
    const abort = new DOMException("caller stopped", "AbortError");
    // The OpenAI SDK rejects a request whose signal aborts with an error of its own.
    const caller = new AbortController();
    await expect(collect(withStreamAttempt(async function* (): AsyncGenerator<TestEvent> {
      caller.abort(abort);
      throw new APIUserAbortError();
    }, { signal: caller.signal }))).rejects.toBe(abort);
  });
});
