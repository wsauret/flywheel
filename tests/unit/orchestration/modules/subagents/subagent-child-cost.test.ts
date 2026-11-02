import { expect, test } from "bun:test"
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { randomUUID } from "node:crypto"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { emitContextUpdate } from "../../../../../src/orchestration/agent-runtime/emit.js"
import { assembleRuntimeForTurn } from "../../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { resolveRuntimeConversation } from "../../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { createBudgetProjection } from "../../../../../src/orchestration/session/budget-projection.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js"
import { asModelClient } from "../../agent-runtime/_model-client.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { subagentChildHarnesses } from "./_subagent-child-fixtures.js"

const createHarness = subagentChildHarnesses()

test("child live cost counts each settled request once before and after terminal events", async () => {
  const done = Promise.withResolvers<AgentRunResult>()
  const started = Promise.withResolvers<AgentOptions>()
  const harness = createHarness((options) => ({
    send() { started.resolve(options) },
    end() {},
    abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
    done: done.promise,
  }))
  try {
    const conversationId = "root-conversation"
    const sessionId = await harness.manager.createChat({ id: "root", conversationId, name: "root" })
    await harness.tool(sessionId).execute(
      { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Measure child cost" },
      makeContext({ conversationId }),
    )
    const options = await started.promise
    const child = (await harness.manager.read(sessionId))!.childSessionIds![0]!
    const signal = new AbortController().signal
    const loop = await assembleRuntimeForTurn({
      providerSessionLifetime: testProviderSessionLifetime(),
      options: {
        ...options,
        runtimeSurfaces: options.runtimeSurfaces ?? {},
        moduleSelection: options.moduleSelection ?? testCapabilityModules,
        awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
        usageProfile: {
          profileId: "profile-a", authorityIncarnation: "test",
          acquireAuthority: async () => ({
            profileId: "profile-a", authorityIncarnation: "test",
            append: () => ({ kind: "appended" as const }), release: async () => {},
          }),
        },
      },
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: child, artifactScopeId: child, retrievalSessionId: child }),
      signal, disposalSignal: signal, instruction: null, currentTurn: undefined,
      personas: new Map(),
      captureModelRuntime: async () => ({
        generation: {},
        createLLMClient: async () => asModelClient({
          accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test",
          contextLimit: 1000, outputLimit: 100, supportsReasoning: false,
          promptNotes: { progress: "", modelNotes: "" },
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools() {},
        }),
      }),
      createRunner: () => { throw new Error("unused") },
    })
    expect(loop.parentToolUseId).toBeUndefined()
    const usage = loop.usageSettlement!
    for (const [index, cost] of [0.067872, 0.0085448].entries()) {
      const draft = {
        entry: {
          attemptId: randomUUID(), occurredAt: new Date().toISOString(), profileId: "profile-a",
          attribution: { kind: "candidate" as const, providerId: "anthropic_api" as const },
          spendMode: "direct_api" as const, credentialLineage: randomUUID(), model: "test",
          tokens: { input: 600, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          classification: "real_spend" as const,
          price: { kind: "priced" as const, estimatedUsd: cost, rateCard: {}, provenance: "test" },
          currency: "USD" as const, coverage: "complete" as const,
        },
        budgetStreamId: usage.budgetStreamId, requestId: randomUUID(),
        identity: usage.identity, turn: index + 1,
        ...(usage.parentToolUseId ? { parentToolUseId: usage.parentToolUseId } : {}),
      }
      const { tokens: _tokens, price: _price, currency: _currency, ...attempt } = draft.entry
      await usage.settlement.begin({ ...draft, entry: { ...attempt, coverage: "unmeasured" } })
      await usage.settlement.checkpoint(draft)
      await usage.settlement.settle(draft.entry.attemptId, { served: true })
      const expected = index === 0 ? 0.067872 : 0.0764168
      expect(harness.sessionStore.get(child)?.cost).toBeCloseTo(expected, 10)
      const projected = Promise.withResolvers<void>()
      const unsubscribe = harness.sessionStore.onChange(() => {
        if (harness.sessionStore.get(child)?.contextPromptTokens === 250 + index) projected.resolve()
      })
      try {
        loop.onEvent({ kind: "done", stopReason: "end_turn" })
        // This context write follows the terminal event on the child's durable bus.
        emitContextUpdate(options.onEvent, 250 + index, 1000, "test-tool-use")
        await projected.promise
      } finally {
        unsubscribe()
      }
      expect(harness.sessionStore.get(child)?.contextPromptTokens).toBe(250 + index)
      expect((await createBudgetProjection(asAsyncEventReadSurface(harness.store), child).replay()).totalCost).toBeCloseTo(expected, 10)
      expect(harness.sessionStore.get(child)?.cost).toBeCloseTo(expected, 10)
      expect(harness.sessionStore.get(child)?.billedCost).toBeCloseTo(expected, 10)
      const facts = harness.store.read({ aggregateId: `session:${child}`, types: ["model.usage.measured", "model.turn.completed"] })
      expect(facts).toHaveLength((index + 1) * 2)
      expect(facts.every((fact) => !("parentToolUseId" in fact.payload))).toBe(true)
    }
    expect(harness.store.read({ aggregateId: `session:${child}`, types: ["model.usage.measured"] })).toHaveLength(2)
  } finally {
    done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await harness.close()
  }
})
