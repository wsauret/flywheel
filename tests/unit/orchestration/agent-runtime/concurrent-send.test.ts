import { describe, expect, test } from "bun:test";

import { newTestRunner } from "../../../helpers/agent-runner.js";
import { testDirectories } from "../../../helpers/directories.js";
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types.js";
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { asModelClient } from "./_model-client.js";

function makeOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    model: "claude-haiku-4-5-20251001",
    purpose: { kind: "interactive-chat" },
    ...testDirectories("/scratch"),
    onEvent: () => {},
    agentRegistry: new Map(),
    agentsMd: "",
    runtimeSurfaces: {},
    conversation: { kind: "stateless" },
    lifecycle: { kind: "one-shot" },
    ...overrides,
  };
}

describe("concurrent send observability (lifecycle.start() === false)", () => {
  test("a second send() on a running runner does NOT fork a new run or duplicate-enqueue", async () => {
    let streamCalls = 0;
    let rejectRun: ((reason?: unknown) => void) | undefined;
    const firstStream = Promise.withResolvers<void>();
    const runner = newTestRunner(
      makeOptions(),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
          streamCalls++;
          const run = new Promise<void>((_, reject) => { rejectRun = reject; });
          firstStream.resolve();
          await run;
        },
      }),
    );

    runner.send("first");
    await firstStream.promise;
    // The discarded send must be observable, not a fallback enqueue: it neither
    // starts a second run nor re-delivers (chat-controls already enqueued it).
    runner.send("second");
    await new Promise((r) => setTimeout(r, 20));

    expect(streamCalls).toBe(1);

    runner.abort();
    rejectRun?.(new DOMException("aborted", "AbortError"));
    const result = await runner.done;
    expect(result.terminal.kind).toBe("aborted");
  });

});
