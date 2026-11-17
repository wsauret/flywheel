import { expect, it } from "bun:test";
import { sendStreamingRequest } from "../../../../../src/orchestration/agent-runtime/llm/request-timing.js";

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
