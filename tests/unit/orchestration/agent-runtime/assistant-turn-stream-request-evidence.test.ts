import { describe, expect, test } from "bun:test"

import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream"
import type { PreparedRequestAttempt } from "../../../../src/orchestration/agent-runtime/request-tool-surface.js"
import type { ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit"
import { asModelClient, fakeAttempt } from "./_model-client"
import { DEFAULT_MODEL_INTERACTION_PROFILE, resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { chain, fakeAvailability, subscriptionCandidate } from "./llm/_provider-chain-harness.js"
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js"
import { QuotaExhaustedError, StreamIdleTimeoutError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

describe("streamAssistantTurn durable request evidence", () => {
  test("does not dispatch to the provider when request evidence fails", async () => {
    let providerDispatched = false
    const client = asModelClient({
      ...fakeAttempt("anthropic_api", "test-model"),
      async *streamWithTools() {
        providerDispatched = true
        yield { kind: "done", stopReason: "end_turn" }
      },
    })
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest: async () => { throw new Error("request evidence commit failed") },
      recordResponse() {},
      recordUsage() {},
      recordStreamStarted() {},
      recordStreamEvent() {},
      recordStreamCompleted() {},
    }

    await expect(streamAssistantTurn({
      client,
      executionCwd: "/scratch",
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [{ kind: "user", content: "hello" }],
      tools: [],
      systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: undefined,
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit,
      staleMasking: undefined,
      requestContext: undefined,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 1,
      onEvent: () => {},
    })).rejects.toThrow("request evidence commit failed")
    expect(providerDispatched).toBe(false)
  })

  test("reuses one durable transformer application across provider failover", async () => {
    const calls: Array<{ attribution: string; contextApplication: unknown; interactionProfileId: string; omittedTools: ReadonlyArray<{ name: string; reason: string }> }> = []
    const auditIds: string[] = []
    const begun: string[] = []
    const closed: string[] = []
    const measured: number[] = []
    const applications = [{
      applicationId: "application-1", transformerId: "transformer-1", seam: "modelContext", order: 1,
      outcome: "error" as const, inputHash: "a".repeat(64), outputHash: "a".repeat(64),
    }]
    const interactionProfile = resolveModelInteractionProfile("gpt-6-luna", "openai")
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), subscriptionCandidate("github_copilot")],
      availability: fakeAvailability({}).availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
      credentialLineage: () => "test-generation",
      build: async (provider) => ({
        ...fakeAttempt(provider, "test-model"),
        async *streamWithTools() {
          yield { kind: "usage", final: true, inputTokens: 10, outputTokens: provider === "chatgpt" ? 3 : 7, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 }
          if (provider === "chatgpt") throw normalizeProviderAttemptFailure(new QuotaExhaustedError("cap"))
          yield { kind: "done", stopReason: "end_turn" }
        },
      }),
    })
    const requestAudit: ProviderRequestAuditWriter = {
      async recordRequest(input) {
        auditIds.push(input.requestId)
        calls.push({ attribution: input.attribution.accessProvider, contextApplication: input.contextApplication, interactionProfileId: input.interactionProfileId, omittedTools: input.omittedTools })
        return { requestId: `request-${calls.length}`, turn: input.turn }
      },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    }

    await streamAssistantTurn({
      client, executionCwd: "/scratch", messages: [{ kind: "user", content: "hello" }], tools: [], systemPrompt: stableSystemPrompt("transformed"),
      interactionProfile,
      prepareAttempt: (): PreparedRequestAttempt => ({
        systemPrompt: stableSystemPrompt("transformed"), tools: [], attemptStaticTokens: 1,
        auditTools: [],
        contextApplication: { identity: "context-1", applications },
        interactionProfileId: "default",
        omittedTools: [{ name: "hidden", reason: "not admitted" }],
      }),
      reasoningEffort: undefined, signal: undefined, cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit, staleMasking: undefined, requestContext: undefined,
      turn: 1, messageCount: 1, estimatedContextTokens: 1, onEvent: () => {},
      usageSettlement: {
        profileId: "test-profile", budgetStreamId: "test-budget", identity: { providerSessionKey: "stable" },
        settlement: {
          begin: async ({ entry }) => { begun.push(entry.attemptId) },
          checkpoint: async ({ entry }) => { if (entry.coverage !== "unmeasured") measured.push(entry.tokens.output) },
          settle: async (attemptId) => { closed.push(attemptId) },
          recover: async () => {},
        },
      },
    })

    expect(calls).toEqual([
      { attribution: "chatgpt", contextApplication: { identity: "context-1", applications }, interactionProfileId: "default", omittedTools: [{ name: "hidden", reason: "not admitted" }] },
      { attribution: "github_copilot", contextApplication: { identity: "context-1", applications }, interactionProfileId: "default", omittedTools: [{ name: "hidden", reason: "not admitted" }] },
    ])
    expect(new Set(auditIds).size).toBe(2)
    expect(begun).toEqual(auditIds)
    expect(closed).toEqual(auditIds)
    expect(measured).toEqual([3, 7])
  })
  test.each([
    ["a response that ended without a usage report", true],
    ["a refusal before any dispatch", false],
    ["a pre-stream watchdog timeout after dispatch", true],
  ] as const)("settles %s as served=%p", async (scenario, served) => {
    const settled: Array<{ attemptId: string; served: boolean }> = []
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt")],
      availability: fakeAvailability({}).availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
      credentialLineage: () => "test-generation",
      build: async (provider) => ({
        ...fakeAttempt(provider, "test-model"),
        async *streamWithTools(options) {
          if (scenario === "a refusal before any dispatch") throw normalizeProviderAttemptFailure(new QuotaExhaustedError("cap"))
          await options.onDispatch?.()
          if (scenario === "a pre-stream watchdog timeout after dispatch") throw normalizeProviderAttemptFailure(new StreamIdleTimeoutError("pre-stream timeout", "pre-stream"))
          yield { kind: "provider_response_started" }
          yield { kind: "done", stopReason: "end_turn" }
        },
      }),
    })
    const requestAudit: ProviderRequestAuditWriter = {
      async recordRequest(input) { return { requestId: "request-1", turn: input.turn } },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    }
    await streamAssistantTurn({
      client, executionCwd: "/scratch", messages: [{ kind: "user", content: "hello" }], tools: [], systemPrompt: stableSystemPrompt("system"),
      interactionProfile: resolveModelInteractionProfile("gpt-6-luna", "openai"),
      reasoningEffort: undefined, signal: undefined, cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit, staleMasking: undefined, requestContext: undefined,
      turn: 1, messageCount: 1, estimatedContextTokens: 1, onEvent: () => {},
      usageSettlement: {
        profileId: "test-profile", budgetStreamId: "test-budget", identity: { providerSessionKey: "stable" },
        settlement: {
          begin: async () => {}, checkpoint: async () => {}, recover: async () => {},
          settle: async (attemptId, outcome) => { settled.push({ attemptId, served: outcome.served }) },
        },
      },
    }).catch(() => undefined)
    // A transient timeout retries in place, and each retried attempt settles on its own.
    expect([...new Set(settled.map((entry) => entry.served))]).toEqual([served])
  })

  test("records dispatch only after the provider adapter begins I/O", async () => {
    let ioBegan = false
    let dispatchObservedAfterIo = false
    const client = asModelClient({
      ...fakeAttempt("anthropic_api", "test-model"),
      async *streamWithTools(options) {
        ioBegan = true
        await options.onDispatch?.()
        yield { kind: "done", stopReason: "end_turn" }
      },
    })
    const requestAudit: ProviderRequestAuditWriter = {
      async recordRequest(input) { return { requestId: "request-1", turn: input.turn } },
      recordDispatch() { dispatchObservedAfterIo = ioBegan },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    }

    await streamAssistantTurn({
      client, executionCwd: "/scratch", messages: [{ kind: "user", content: "hello" }], tools: [], systemPrompt: stableSystemPrompt("system"),
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      reasoningEffort: undefined, signal: undefined, cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit, turn: 1, messageCount: 1, estimatedContextTokens: 1, onEvent: () => {},
      staleMasking: undefined, requestContext: undefined,
    })

    expect(dispatchObservedAfterIo).toBe(true)
  })
})
