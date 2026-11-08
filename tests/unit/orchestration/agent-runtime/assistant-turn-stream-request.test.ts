import { describe, expect, spyOn, test } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { DegenerateRepetitionError } from "../../../../src/orchestration/agent-runtime/llm/reasoning-repetition.js"

import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream"
import type { ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit"
import type { AdmittedModelRequest, CacheRetention, LLMClient, ModelClient, PreparedServingRequest, ProviderStreamEvent, ServingAttempt, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types"
import { asModelClient, attemptHistoryTarget, fakeAttempt } from "./_model-client"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { chain, fakeAvailability, singletonCandidate, subscriptionCandidate } from "./llm/_provider-chain-harness.js"
import type { ProviderAffordabilityCapability } from "../../../../src/orchestration/agent-runtime/llm/provider-affordability.js"
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js"
import { ContextLengthExceededError, StreamIdleTimeoutError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { copilotAffordability } from "../../../../src/orchestration/modules/provider-github-copilot/affordability.js"
import type { AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt.js"
import { renderSystemPrompt, stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

function fakeClient(
  stream: (opts: StreamOptions) => AsyncGenerator<ProviderStreamEvent>,
  observe?: (opts: StreamOptions) => void,
): ModelClient {
  return asModelClient({
    ...fakeAttempt("anthropic_api", "test-model"),
    streamWithTools(opts: StreamOptions) {
      observe?.(opts)
      return stream(opts)
    },
  } satisfies LLMClient)
}

describe("streamAssistantTurn request identity forwarding", () => {
  test("appends ordinary provider messages and counts them before ephemeral audit and dispatch", async () => {
    const captured: StreamOptions[] = []
    const reminder = { kind: "user", content: "required reminder", origin: "system" } as const
    const messages: import("../../../../src/orchestration/agent-runtime/llm/types.js").ConversationMessage[] = [{ kind: "user", content: "hello" }]
    const client = asModelClient({
      ...fakeAttempt("anthropic_api", "test-model"),
      messagesToAppend(history, cwd) {
        expect(history).toEqual(messages)
        expect(cwd).toBe("/scratch/child")
        return [reminder]
      },
      async *streamWithTools(options) {
        captured.push(options)
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    let audit: Parameters<ProviderRequestAuditWriter["recordRequest"]>[0] | undefined
    await streamAssistantTurn({
      client, executionCwd: "/scratch/child", interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages, tools: [], systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined, signal: undefined, cacheRetention: undefined,
      providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined,
      requestAudit: {
        recordRequest(input) { audit = input; return { requestId: input.requestId, turn: input.turn } },
        recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
      },
      staleMasking: undefined, requestContext: undefined, turn: 1, messageCount: 1,
      estimatedContextTokens: 42, onEvent: () => {},
    })
    expect(messages).toEqual([{ kind: "user", content: "hello" }])
    expect(captured[0]?.messages).toEqual([...messages, reminder])
    expect(audit?.messages).toBe(captured[0]?.messages)
    expect(audit?.messageCount).toBe(2)
    expect(audit?.estimatedContextTokens).toBe(47)
  })

  test("forwards messages, tools, systemPrompt, reasoningEffort, providerOptions, cacheRetention, providerSessionKey, and promptCacheKey exactly once", async () => {
    const captured: StreamOptions[] = []
    const client = asModelClient({
      ...fakeAttempt("anthropic_api", "test-model"),
      async *streamWithTools(opts) {
        captured.push(opts)
        yield { kind: "done", stopReason: "end_turn" } as const
      },
    })
    let auditPrompt: string | undefined
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest(input) {
        auditPrompt = input.systemPrompt
        return { requestId: "request-1", turn: input.turn }
      },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    }
    const providerOptions: StreamOptions["providerOptions"] = { openai: { service_tier: "priority" } }

    await streamAssistantTurn({
      client,
      executionCwd: "/scratch",
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [{ kind: "user", content: "hello" }],
      tools: [{ name: "noop", description: "noop", input_schema: {} }],
      systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: "high",
      signal: undefined,
      cacheRetention: "1h",
      providerSessionKey: "conv-123", promptCacheKey: "tree-root",
      providerOptions,
      requestAudit,
      staleMasking: undefined,
      requestContext: undefined,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 42,
      onEvent: () => {},
    })

    expect(captured).toHaveLength(1)
    const options = captured[0]!
    expect(options.messages).toEqual([{ kind: "user", content: "hello" }])
    expect(options.tools).toEqual([{ name: "noop", description: "noop", input_schema: {} }])
    expect(options.systemPrompt).toEqual(stableSystemPrompt("system"))
    expect(auditPrompt).toBe("system")
    expect(options.reasoningEffort).toBe("high")
    expect(options.cacheRetention).toBe("1h")
    expect(options.providerSessionKey).toBe("conv-123")
    expect(options.promptCacheKey).toBe("tree-root")
    expect(options.providerOptions).toBe(providerOptions)
  })

  test("resolves the candidate output allowance from the anchored context estimate", async () => {
    const allowances: Array<number | undefined> = []
    const run = async (attempt: ServingAttempt, estimatedContextTokens: number) => {
      const client = asModelClient({
        ...attempt,
        async *streamWithTools(options: StreamOptions) {
          allowances.push(options.outputTokenLimit)
          yield { kind: "done", stopReason: "end_turn" }
        },
      })
      await streamAssistantTurn({
        client, executionCwd: "/scratch", interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
        messages: [], tools: [], systemPrompt: stableSystemPrompt(""), reasoningEffort: undefined, signal: undefined,
        cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined,
        requestAudit: undefined, staleMasking: undefined, requestContext: undefined,
        turn: 1, messageCount: 0, estimatedContextTokens, onEvent: () => {},
      })
    }

    await run({ ...fakeAttempt("anthropic_api", "muse"), totalContextLimit: 1_048_576, outputLimit: 943_718 }, 105_245)
    await run({ ...fakeAttempt("anthropic_api", "input-only"), outputLimit: 943_718 }, 105_245)
    await run({ ...fakeAttempt("anthropic_api", "provider-cap"), totalContextLimit: 1_048_576, outputLimit: 8_000 }, 105_245)
    await run({ ...fakeAttempt("anthropic_api", "one-left"), totalContextLimit: 105_246, outputLimit: 8_000 }, 105_245)

    expect(allowances).toEqual([943_331, undefined, undefined, 1])
  })

  test("rejects an exhausted total context before the adapter call", async () => {
    let adapterCalled = false
    const client = asModelClient({
      ...fakeAttempt("anthropic_api", "full"),
      totalContextLimit: 105_245,
      async *streamWithTools() {
        adapterCalled = true
        yield { kind: "done", stopReason: "end_turn" }
      },
    })

    await expect(streamAssistantTurn({
      client, executionCwd: "/scratch", interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [], tools: [], systemPrompt: stableSystemPrompt(""), reasoningEffort: undefined, signal: undefined,
      cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined,
      requestAudit: undefined, staleMasking: undefined, requestContext: undefined,
      turn: 1, messageCount: 0, estimatedContextTokens: 105_245, onEvent: () => {},
    })).rejects.toBeInstanceOf(ContextLengthExceededError)
    expect(adapterCalled).toBe(false)
  })

  test("omits the audit cache key when retention is none", async () => {
    let auditedCacheKey: string | undefined = "unset"
    const captured: StreamOptions[] = []
    const client = fakeClient(async function* () {
      yield { kind: "done", stopReason: "end_turn" }
    }, (options) => captured.push(options))
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest(input) {
        auditedCacheKey = input.cacheKey
        return { requestId: "request-1", turn: input.turn }
      },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    }

    await streamAssistantTurn({
      client,
      executionCwd: "/scratch",
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [],
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: "none",
      providerSessionKey: "conversation-1", promptCacheKey: "conversation-1",
      providerOptions: undefined,
      requestAudit,
      staleMasking: undefined,
      requestContext: undefined,
      turn: 1,
      messageCount: 0,
      estimatedContextTokens: 0,
      onEvent: () => {},
    })

    expect(captured[0]?.providerSessionKey).toBe("conversation-1")
    expect(auditedCacheKey).toBeUndefined()
  })
})

describe("streamAssistantTurn admitted request", () => {
  test("prepares real continuation input before Copilot affordability and refuses real user input", async () => {
    const order: string[] = []
    const captured: StreamOptions[] = []
    const candidate = subscriptionCandidate("github_copilot")
    const client = chain({
      availability: fakeAvailability({}).availability,
      candidateAttributions: [{ candidate, wireModelId: "test-model", dataUse: "standard", catalogProvenance: "live", catalogMetadata: { billing: { multiplier: 2 } } }],
      requestAdmission: {
        subscriptionSpendAuthorizationFor: () => undefined,
        subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite", metric: "premium_interactions", remaining: 1 }),
      },
      affordability: new Map([["github_copilot", {
        async evaluate(input) {
          order.push("affordability")
          return copilotAffordability.evaluate(input)
        },
      }]]),
      build: async () => ({
        attempt: fakeAttempt("github_copilot", "test-model"),
        async connect() {
          order.push("connect")
          return {
            ...fakeAttempt("github_copilot", "test-model"),
            async *streamWithTools(options: StreamOptions) {
              order.push("dispatch")
              captured.push(options)
              yield { kind: "done" as const, stopReason: "end_turn" as const }
            },
          }
        },
      }),
    })
    const run = (messages: AssistantAttemptInput["messages"]) => streamAssistantTurn({
      client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
      prepare: () => {
        order.push("prepare")
        return {
          input: {
            interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
            messages, tools: [], systemPrompt: stableSystemPrompt("literal"), reasoningEffort: undefined,
            signal: undefined, cacheRetention: "1h" as const, providerSessionKey: "conversation", promptCacheKey: "conversation",
            providerOptions: undefined,
            requestAudit: {
              recordRequest(input) {
                order.push("audit")
                expect(input.messages).toBe(messages)
                return { requestId: "request", turn: input.turn }
              },
              recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
            },
            staleMasking: undefined, requestContext: undefined,
            turn: 1, messageCount: messages.length, estimatedContextTokens: 20, onEvent: () => {},
          } satisfies AssistantAttemptInput,
          execute: (_candidate, fold) => fold({}, async (attempt) => {
            const value = await attempt.stream()
            await attempt.close()
            return { value, stop: false }
          }),
        }
      },
    })
    const messages: AssistantAttemptInput["messages"] = [{ kind: "user", content: "hello" }, { kind: "assistant", content: "working" }]
    expect((await client.plannedAttempt()).accessProvider).toBe("github_copilot")
    expect(order).toEqual([])
    await run(messages)
    expect(order).toEqual(["prepare", "affordability", "connect", "audit", "dispatch"])
    expect(captured[0]?.messages).toBe(messages)
    order.length = 0
    await expect(run([{ kind: "user", content: "new request" }])).rejects.toThrow("premium interactions")
    expect(order).toEqual(["prepare", "affordability"])
    expect(captured).toHaveLength(1)
  })

  test.each(["accounts", "configured-apis"] as const)("shares each candidate and settled retry revision across affordability, audit, and dispatch: %s", async (scenario) => {
    let captures = 0
    let revision = 0
    let preparations = 0
    const order: string[] = []
    const seen: PreparedServingRequest[] = []
    const retries: number[] = []
    const auditedRetention: Array<CacheRetention | undefined> = []
    const providers = scenario === "accounts" ? ["github_copilot", "github_copilot"] : ["openai_api", "anthropic_api"]
    const admission = { subscriptionSpendAuthorizationFor: () => undefined }
    const affordability: ProviderAffordabilityCapability = {
      async evaluate(input) {
        expect(input.admission).toBe(admission)
        expect(input.request.attempt.candidateAttribution).toBe(input.attribution)
        seen.push(input.request)
        order.push(`affordability:${input.attribution.wireModelId}:${revision}`)
        return input.attribution.wireModelId === "first"
          ? { kind: "unaffordable" as const, detail: "first cannot pay" }
          : { kind: "eligible" as const }
      },
    }
    const client = chain({
      availability: fakeAvailability({}).availability,
      candidateAttributions: () => {
        captures += 1
        return providers.map((provider, index) => ({
          candidate: provider === "github_copilot" ? subscriptionCandidate(provider, index === 0 ? "first" : "second") : singletonCandidate(provider),
          wireModelId: index === 0 ? "first" : "second", dataUse: "standard" as const,
        }))
      },
      requestAdmission: admission,
      affordability: new Map(providers.map((provider) => [provider, affordability])),
      build: async (provider, attribution) => {
        const name = attribution.wireModelId
        const attempt: ServingAttempt = {
          ...fakeAttempt(provider, name),
          tokenizerIdentity: name === "first" ? "ClaudeV3" : "ClaudeV5",
          outputLimit: name === "first" ? 100 : 200, totalContextLimit: 300,
        }
        return { attempt, connect: async () => {
          order.push(`connect:${name}`)
          return { ...attempt, historyTarget: () => attemptHistoryTarget(attempt), async *streamWithTools(options: StreamOptions) {
            const evidence = seen.at(-1)
            if (!evidence) throw new Error("Dispatch must follow affordability")
            order.push(`dispatch:${revision}`)
            expect(evidence.messages).toBe(options.messages)
            expect(options.tools).toBe(evidence.tools)
            expect(options.systemPrompt).toBe(evidence.systemPrompt)
            expect(options.cacheRetention).toBe(evidence.cacheRetention)
            expect(options.outputTokenLimit).toBe(evidence.outputTokenLimit)
            expect(options.messages.at(-1)).toEqual({ kind: "user", content: `second:settled:${revision}` })
            if (revision < 3) throw normalizeProviderAttemptFailure(new StreamIdleTimeoutError("stalled", "idle"))
            yield { kind: "done" as const, stopReason: "end_turn" as const }
          } }
        } }
      },
    })
    await streamAssistantTurn({
      client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
      estimatedInputTokenClasses: (attempt) => ({
        uncachedInputTokens: attempt.model === "first" ? 210 : 180 + revision,
        cacheTokens: attempt.model === "first" ? 20 : 10,
      }),
      onEvent: (event) => { retries.push(event.attempt) },
      prepare: (attempt) => {
        preparations += 1
        order.push(`prepare:${attempt.model}:${revision}`)
        const messages: AssistantAttemptInput["messages"] = [{ kind: "user", content: `${attempt.model}:settled:${revision}` }]
        return {
          input: {
            interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
            messages, tools: [{ name: attempt.model, description: attempt.model, input_schema: {} }],
            systemPrompt: stableSystemPrompt(`prompt:${attempt.model}`), reasoningEffort: undefined,
            signal: undefined, cacheRetention: attempt.model === "first" ? "5m" : "1h",
            ...(scenario === "configured-apis" ? { cacheRetentionPolicies: { openai_api: "in_memory" as const, anthropic_api: "5m" as const } } : {}),
            providerSessionKey: "conversation", promptCacheKey: "conversation", providerOptions: undefined,
            requestAudit: {
              recordRequest(input) {
                order.push(`audit:${revision}`)
                const evidence = seen.at(-1)
                if (!evidence) throw new Error("Audit must follow affordability")
                expect(evidence.messages).toBe(input.messages)
                expect(input.systemPrompt).toBe(renderSystemPrompt(evidence.systemPrompt))
                expect(input.cacheRetention).toBe(evidence.cacheRetention)
                auditedRetention.push(input.cacheRetention)
                return { requestId: `request:${revision}`, turn: input.turn }
              },
              recordResponse() { order.push(`closed:${revision}`) },
              recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
            },
            staleMasking: undefined, requestContext: undefined,
            turn: 1, messageCount: messages.length, estimatedContextTokens: 190 + revision, onEvent: () => {},
          },
          execute: (_candidate, fold) => fold({}, async (wireAttempt) => {
            const value = await wireAttempt.stream()
            await wireAttempt.close()
            if (value.outcome.kind === "stream_error") {
              expect(value.outcome.error._tag).toBe("StreamStalled")
              revision += 1
            }
            return { value, stop: false }
          }),
        }
      },
    })
    expect(captures).toBe(1)
    expect(preparations).toBe(5)
    expect(retries).toEqual([1, 2, 3])
    expect(seen.map(({ cacheRetention }) => cacheRetention)).toEqual(scenario === "accounts" ? ["5m", "1h", "1h", "1h", "1h"] : ["in_memory", "5m", "5m", "5m", "5m"])
    expect(auditedRetention).toEqual(scenario === "accounts" ? ["1h", "1h", "1h", "1h"] : ["5m", "5m", "5m", "5m"])
    for (const request of seen) expect(request.tokenClasses.cacheRetention).toBe(request.cacheRetention)
    expect(seen.map((request) => [request.attempt.model, request.attempt.tokenizerIdentity, request.tokenClasses.estimatedUncachedInputTokens, request.tokenClasses.estimatedCacheTokens]))
      .toEqual([["first", "ClaudeV3", 210, 20], ["second", "ClaudeV5", 180, 10], ["second", "ClaudeV5", 181, 10], ["second", "ClaudeV5", 182, 10], ["second", "ClaudeV5", 183, 10]])
    expect(order).toEqual([
      "prepare:first:0", "affordability:first:0", "prepare:second:0", "affordability:second:0", "connect:second",
      ...[0, 1, 2, 3].flatMap((index) => [
        ...(index === 0 ? [] : [`prepare:second:${index}`, `affordability:second:${index}`]),
        `audit:${index}`, `dispatch:${index}`, `closed:${index}`,
      ]),
    ])
  })

  test("records a repetition trip once when the turn settles on it without a resample", async () => {
    const records: unknown[] = []
    const record = spyOn(DebugLog, "record").mockImplementation((entry) => {
      if (entry.type === "model.reasoning.repetition_detected") records.push(entry.payload)
    })
    try {
      const client = fakeClient(async function* () {
        throw normalizeProviderAttemptFailure(new DegenerateRepetitionError({ ratio: 0.0123, windowChars: 8192, reasoningChars: 9_000 }))
      })
      await streamAssistantTurn({
        client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
        // A settlement that stops, as a planned compaction or a new user message does, ends the turn before the walk.
        prepare: () => ({
          input: {
            interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
            messages: [{ kind: "user", content: "hello" }], tools: [], systemPrompt: stableSystemPrompt("system"),
            reasoningEffort: undefined, signal: undefined, cacheRetention: undefined,
            providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit: undefined,
            staleMasking: undefined, requestContext: undefined, turn: 1, messageCount: 1, estimatedContextTokens: 1, onEvent: () => {},
          },
          execute: (_candidate, fold) => fold({}, async (attempt) => {
            const value = await attempt.stream()
            await attempt.close()
            return { value, stop: true }
          }),
        }),
      })
    } finally {
      record.mockRestore()
    }
    expect(records).toEqual([{ model: "test-model", accessProvider: "anthropic_api", attempt: 1, ratio: 0.012, windowChars: 8192, reasoningChars: 9_000 }])
  })

  test("dispatches through the admission selected by its request boundary", async () => {
    let facadeDispatches = 0
    let admittedDispatches = 0
    const client = fakeClient(async function* () {
      facadeDispatches += 1
      yield { kind: "done", stopReason: "end_turn" }
    })
    const admitted: AdmittedModelRequest = {
      candidateAttributions: [],
      prepare: async () => { throw new Error("this fake serves sends only") },
      async run({ execute, prepare }) {
        const attempt = fakeAttempt("anthropic_api", "test-model")
        const prepared = await prepare(attempt)
        const result = await execute({ attempt, prepared, sample: 1, detectRepetition: false, client: { ...attempt, async *streamWithTools() {
          admittedDispatches += 1
          yield { kind: "done", stopReason: "end_turn" }
        } } })
        if (result.kind !== "success") throw result.failure
        return result.value
      },
      plannedAttempt: async () => fakeAttempt("anthropic_api", "test-model"),
    }

    await streamAssistantTurn({
      client,
      executionCwd: "/scratch",
      request: admitted,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [{ kind: "user", content: "hello" }],
      tools: [],
      systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: undefined,
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit: undefined,
      staleMasking: undefined,
      requestContext: undefined,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 1,
      onEvent: () => {},
    })

    expect(admittedDispatches).toBe(1)
    expect(facadeDispatches).toBe(0)
  })
})
