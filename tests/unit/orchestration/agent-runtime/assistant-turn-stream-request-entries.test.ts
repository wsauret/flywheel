import { describe, expect, test } from "bun:test"

import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream"
import type { AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt.js"
import type { ConversationMessage, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { asModelClient, fakeAttempt } from "./_model-client"

describe("streamAssistantTurn route request entries", () => {
  /** A request owner's history, its outbound preparation (a mask of every tool result), and a route whose request
   *  entries add one system entry when `adds` holds. */
  function routeEntriesRun(adds: boolean) {
    const order: string[] = []
    const read: StreamOptions[] = []
    const captured: StreamOptions[] = []
    const history: ConversationMessage[] = [
      { kind: "user", content: "hello" },
      { kind: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "full result" }] },
    ]
    const outbound = (message: ConversationMessage): ConversationMessage => message.kind === "toolResult" ? { ...message, content: [{ type: "text", text: "[masked]" }] } : message
    const client = asModelClient({
      ...fakeAttempt("anthropic_api", "test-model"),
      requestEntries(request) {
        order.push("entries")
        read.push(request)
        return adds ? [{ kind: "user", origin: "system", content: "engine text" }] : []
      },
      async *streamWithTools(options) {
        order.push("stream")
        captured.push(options)
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    const run = () => streamAssistantTurn({
      client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
      prepare: () => {
        order.push("prepare")
        const messages = history.map(outbound)
        return {
          input: {
            interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
            messages, tools: [{ name: "read", description: "read", input_schema: {} }], systemPrompt: stableSystemPrompt("system"), reasoningEffort: undefined,
            signal: undefined, cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined,
            requestAudit: undefined, staleMasking: undefined, requestContext: undefined,
            turn: 1, messageCount: messages.length, estimatedContextTokens: 20, onEvent: () => {},
          } satisfies AssistantAttemptInput,
          execute: (_candidate, fold) => fold({}, async (attempt) => {
            const value = await attempt.stream()
            await attempt.close()
            return { value, stop: false }
          }),
        }
      },
      appendEntries: async (entries) => {
        await Promise.resolve()
        history.push(...entries)
        order.push("appended")
      },
    })
    return { order, read, captured, history, run }
  }

  test("appends a route's request entries, read from the request after outbound preparation, and streams the request prepared again with them", async () => {
    const { order, read, captured, history, run } = routeEntriesRun(true)
    await run()
    expect(order).toEqual(["prepare", "entries", "appended", "prepare", "stream"])
    expect(read[0]?.messages.at(-1)).toEqual({ kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "[masked]" }] })
    expect(read[0]?.tools.map((tool) => tool.name)).toEqual(["read"])
    expect(history.at(-1)).toEqual({ kind: "user", origin: "system", content: "engine text" })
    expect(captured[0]?.messages.at(-1)).toEqual({ kind: "user", origin: "system", content: "engine text" })
  })

  test("prepares once when the route's request entries add nothing", async () => {
    const { order, captured, history, run } = routeEntriesRun(false)
    await run()
    expect(order).toEqual(["prepare", "entries", "stream"])
    expect(history).toHaveLength(3)
    expect(captured[0]?.messages).toHaveLength(3)
  })
})
