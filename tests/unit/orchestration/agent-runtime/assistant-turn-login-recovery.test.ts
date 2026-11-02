import { expect, test } from "bun:test"
import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js"
import type { AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt.js"
import type { AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js"
import { FUNCTION_TOOL_PRESENTATION, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { chain, fakeAvailability, subscriptionCandidate } from "./llm/_provider-chain-harness.js"
import { ownHistoryTarget } from "./_model-client.js";

test.each(["renewed", "declined", "stopped"] as const)("keeps the failed revision while login is %s", async (answer) => {
  const captured: StreamOptions[] = []
  const auditIds: string[] = []
  const closed: string[] = []
  const usageBegun: string[] = []
  const usageClosed: string[] = []
  const activity: boolean[] = []
  const abandoned: string[] = []
  const built: string[] = []
  const controller = new AbortController()
  const stop = new Error("person stopped the waiting request")
  const original = Object.assign(new Error("login refused"), { status: 401 })
  let revision = 1
  let prepares = 0
  let waits = 0
  const availability = fakeAvailability({})
  const providerOptions = { openai: { text_verbosity: "low" as const } }
  const client = chain({
    availability: availability.availability,
    awaitLogin: async (candidate, signal) => {
      waits += 1
      expect(candidate).toEqual(subscriptionCandidate("chatgpt"))
      expect(signal).toBe(controller.signal)
      expect(closed).toEqual([auditIds[0]!])
      expect(usageClosed).toEqual(usageBegun)
      revision = 2
      if (answer === "stopped") {
        controller.abort(stop)
        signal.throwIfAborted()
      }
      return answer === "renewed" ? "renewed" : "declined"
    },
    build: async (provider) => {
      built.push(provider)
      return { historyTarget: ownHistoryTarget,
        accessProvider: provider, modelFamily: "openai", model: "test-model",
        toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000,
        supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
        async *streamWithTools(options) {
          captured.push(options)
          if (captured.length === 1) throw normalizeProviderAttemptFailure(original)
          yield { kind: "done", stopReason: "end_turn" }
        },
      }
    },
  })
  const pending = streamAssistantTurn<AssistantTurnResult>({
    client, executionCwd: "/scratch", signal: controller.signal, providerOptions,
    onLoginWait: (waiting) => { activity.push(waiting) },
    prepare: () => {
      prepares += 1
      return {
        input: {
          interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
          messages: [{ kind: "user", content: `revision-${revision}` }],
          tools: [{ name: `tool_${revision}`, description: "tool", input_schema: {} }],
          systemPrompt: stableSystemPrompt(`system-${revision}`),
          reasoningEffort: undefined, signal: controller.signal, cacheRetention: "1h",
          providerSessionKey: "conversation", promptCacheKey: "conversation", providerOptions,
          requestAudit: {
            recordRequest(input) { auditIds.push(input.requestId); return { requestId: input.requestId, turn: input.turn } },
            recordResponse(input) { closed.push(input.requestId) },
            recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
          },
          usageSettlement: {
            profileId: "profile", budgetStreamId: "budget", identity: { providerSessionKey: "conversation" },
            settlement: {
              begin: async ({ entry }) => { usageBegun.push(entry.attemptId) },
              checkpoint: async () => {},
              settle: async (attemptId) => { usageClosed.push(attemptId) },
              recover: async () => {},
            },
          },
          staleMasking: undefined, requestContext: undefined,
          turn: 1, messageCount: 1, estimatedContextTokens: 1, onEvent: () => {},
          onStreamAbandoned: (reason) => { abandoned.push(reason) },
        } satisfies AssistantAttemptInput,
        execute: (_candidate, fold) => fold({}, async (attempt) => {
          const value = await attempt.stream()
          await attempt.close()
          return { value, stop: false }
        }),
      }
    },
  })
  if (answer === "stopped") await expect(pending).rejects.toBe(stop)
  else {
    const result = await pending
    expect(result.outcome.kind).toBe(answer === "renewed" ? "ok" : "stream_error")
    if (result.outcome.kind === "stream_error") expect(result.outcome.error.message).toBe(original.message)
  }
  expect(waits).toBe(1)
  expect(prepares).toBe(1)
  expect(activity).toEqual([true, false])
  expect(abandoned).toEqual(["retry"])
  expect(built).toEqual(["chatgpt"])
  expect(availability.serviceEntryCount()).toBe(0)
  expect(captured).toHaveLength(answer === "renewed" ? 2 : 1)
  expect(captured[0]?.messages).toEqual([{ kind: "user", content: "revision-1" }])
  if (answer === "renewed") {
    for (const key of ["messages", "tools", "systemPrompt", "providerOptions"] as const) {
      expect(captured[1]?.[key]).toBe(captured[0]?.[key])
    }
    expect(new Set(auditIds).size).toBe(2)
    expect(usageBegun).toEqual(auditIds)
    expect(usageClosed).toEqual(auditIds)
    expect(closed).toEqual(auditIds)
  }
})
