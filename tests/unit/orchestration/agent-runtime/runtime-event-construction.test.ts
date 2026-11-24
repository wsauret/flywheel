import { expect, test } from "bun:test"
import type { RuntimeEvent } from "../../../../src/infra/runtime-facts/runtime-event-types.js"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { decodeRuntimeEvent } from "../../../helpers/runtime-events.js"
import { asModelClient } from "./_model-client.js"
import { makeOptions } from "./_runner-options.js"

// Runtime events are typed at construction and cross no schema decode in the
// process that builds them. A schema decode drops keys that its schema does
// not name and fills defaults, so an event that a decode would change differs
// from the value that a process boundary or the durable store reads back.
test("every runtime event of a turn with thinking, text, tool calls, a retry, and usage is its own decoded value", async () => {
  const events: RuntimeEvent[] = []
  let request = 0
  const runner = newTestRunner(
    makeOptions({
      agentsMd: "",
      onEvent: (event) => { events.push(event) },
      usageProfile: {
        profileId: "default",
        authorityIncarnation: "test-authority",
        acquireAuthority: async () => ({ profileId: "default", authorityIncarnation: "test-authority", append: () => ({ kind: "appended" }), release: async () => {} }),
      },
    }),
    async () => asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      accessProviderCandidate: { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" },
      credentialLineage: "00000000-0000-4000-8000-000000000001",
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() {
        request += 1
        if (request === 1) {
          yield { kind: "stream_retry", attempt: 1, maxAttempts: 3, reason: "boom", delayMs: 1, error: { message: "boom" } } as const
          yield { kind: "stream_attempt_start", disableReasoning: false } as const
          yield { kind: "provider_response_started" } as const
          yield { kind: "thinking_delta", text: "Read the file.", blockKey: "thinking" } as const
          yield { kind: "thinking_complete", thinking: "Read the file.", blockKey: "thinking", signature: "c2ln" } as const
          yield { kind: "text_delta", text: "Reading.", blockKey: "text" } as const
          yield { kind: "text_complete", blockKey: "text" } as const
          yield { kind: "tool_input_start", toolUseId: "tool-1", name: "read" } as const
          yield { kind: "tool_input_delta", toolUseId: "tool-1", partialJson: "{\"path\":\"package.json\"}" } as const
          yield { kind: "tool_use", toolCall: { id: "tool-1", name: "read", input: { path: "package.json" } } } as const
          yield { kind: "tool_use", toolCall: { id: "tool-2", name: "no_such_tool", input: {} } } as const
          yield { kind: "usage", final: true, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 } as const
          yield { kind: "done", stopReason: "tool_use" } as const
          return
        }
        yield { kind: "text_delta", text: "Done.", blockKey: "text" } as const
        yield { kind: "usage", final: true, inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 } as const
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    }),
  )

  runner.send("Read package.json.")
  await runner.done

  const types = new Set(events.map((event) => event.type))
  for (const type of ["model.stream.retried", "model.content.delta", "model.text.completed", "tool.input.delta", "tool.input.completed", "tool.result.recorded", "model.usage.measured", "model.assistant_message.recorded"] as const) {
    expect(types).toContain(type)
  }
  for (const event of events) expect(decodeRuntimeEvent(event.type, event.data)).toEqual(event)
})
