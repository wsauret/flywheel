import { afterEach, describe, expect, it } from "bun:test";
import { createResettableTimingFetch, sendStreamingRequest } from "../../../../../src/orchestration/agent-runtime/llm/request-timing.js";

describe("createResettableTimingFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses connection-close options on the first request after reset", async () => {
    const inits: RequestInit[] = [];
    globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response("ok");
    }, { preconnect: originalFetch.preconnect });
    const transport = createResettableTimingFetch();

    await transport.fetch("https://example.test/first");
    transport.resetIdleConnections();
    await transport.fetch("https://example.test/retry");
    await transport.fetch("https://example.test/after");

    expect(inits[0]?.keepalive).toBeUndefined();
    expect(inits[1]?.keepalive).toBe(false);
    expect(new Headers(inits[1]?.headers).get("Connection")).toBe("close");
    expect(inits[2]?.keepalive).toBeUndefined();
  });
});

it("does not emit timing twice when its callback fails", async () => {
  const failure = new Error("timing publication failed");
  let calls = 0;
  await expect(sendStreamingRequest(
    async () => ({ data: "stream", response: new Response() }),
    {
      turnStart: performance.now(),
      coldAdapter: false,
      telemetry: { observe() { calls += 1; throw failure; } },
    },
  )).rejects.toBe(failure);
  expect(calls).toBe(1);
});
