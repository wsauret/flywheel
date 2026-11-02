import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { EventBus, createEmit } from "../../../../src/infra/event-bus.js"
import { EventReaderService, EventStoreWriterLaneService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createRuntimeEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { UsageEntry } from "../../../../src/infra/llm/usage-entry.js"
import { computeUsagePrice } from "../../../../src/infra/llm/llm-helpers.js"
import { createSessionUsageSettlement, USAGE_SETTLEMENT_IN_FLIGHT_KIND } from "../../../../src/orchestration/agent-runtime/usage-settlement.js"
import { createRuntimeUsageDeps } from "../../../../src/orchestration/modules/subscription-usage/provider-deps.js"
import { wireSessionSubscribers, type MetricsWriter } from "../../../../src/orchestration/session/create-session-infra.js"
import { acquireSessionResources } from "../../../../src/orchestration/session/session-resources-service.js"
import { createAssistantAttempt, type AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt.js"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { fakeClient, preparedRequest, subscriptionCandidate } from "../agent-runtime/llm/_provider-chain-harness.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

let databaseDirectory: string

beforeEach(() => {
  databaseDirectory = mkdtempSync(join(tmpdir(), "flywheel-live-usage-"))
})

afterEach(() => {
  rmSync(databaseDirectory, { recursive: true, force: true })
})

test("child request spend reaches parent before tool completion and attempt close", async () => {
  const store = createRuntimeEventStore(join(databaseDirectory, "flywheel.sqlite"))
  const bus = new EventBus()
  const metrics: Parameters<MetricsWriter>[0][] = []
  const entries: UsageEntry[] = []
  const sessionId = "parent-session"
  const program = Effect.scoped(Effect.gen(function* () {
    const resources = yield* acquireSessionResources({ sessionId, projectRoot: "/test-project", emitter: createEmit(bus), eventBus: bus, projectionReader: asAsyncEventReadSurface(store) })
    const wiring = wireSessionSubscribers(bus, resources, (patch) => { metrics.push(patch) })
    yield* Effect.promise(async () => {
      const settlement = createSessionUsageSettlement({
        owner: { kind: "session", sessionId }, reader: asAsyncEventReadSurface(store), writer: resources.sessionEventWriter,
        acquireAuthority: async () => ({
          profileId: "profile",
          authorityIncarnation: "test-authority",
          append: (entry) => { entries.push(entry); return { kind: "appended" } },
          release: async () => {},
        }),
      })
      const tool = Promise.withResolvers<void>()
      let toolFinished = false
      const toolWork = tool.promise.then(() => { toolFinished = true })
      const client = fakeClient("chatgpt", async function* () {
        yield { kind: "tool_use", toolCall: { id: "read-1", name: "read", input: {} } }
        yield { kind: "usage", final: true, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 }
        yield { kind: "done", stopReason: "tool_use" }
      })
      const input = {
        messages: [], interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
        reasoningEffort: undefined, signal: undefined, cacheRetention: undefined,
        providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit: undefined,
        staleMasking: undefined, requestContext: undefined, turn: 1, messageCount: 0,
        estimatedContextTokens: 1, onEvent() {},
        usageSettlement: {
          profileId: "profile", budgetStreamId: sessionId, parentToolUseId: "child-a",
          identity: { providerSessionKey: "session", conversationId: "child" }, settlement,
        },
      } satisfies AssistantAttemptInput
      const serving = {
        ...client, accessProviderCandidate: subscriptionCandidate("chatgpt"), credentialLineage: "00000000-0000-4000-8000-000000000010",
        priceFor: (tokens: Parameters<typeof computeUsagePrice>[0]) => computeUsagePrice(tokens, {
          status: "available", rateCard: { input: 2, output: 10 },
          provenance: { source: "models.dev", catalog: "bundled", provider: "openai", model: client.model },
        }),
      }
      const attempt = createAssistantAttempt({
        client, attempt: serving, prepared: preparedRequest(serving, { ...input, tools: [], systemPrompt: stableSystemPrompt("") }),
      }, input, undefined)
      try {
        await attempt.stream()
        await bus.drain()
        expect(toolFinished).toBe(false)
        expect(entries).toHaveLength(1)
        expect(metrics.at(-1)?.cost).toBeGreaterThan(0)
        expect(metrics.at(-1)?.tokens).toBe(1100)
        const cost = metrics.at(-1)?.cost
        tool.resolve()
        await toolWork
        await attempt.close()
        await bus.drain()
        expect(entries).toHaveLength(1)
        expect(metrics.at(-1)?.cost).toBe(cost)
      } finally {
        tool.resolve()
        await toolWork
        for (const unsubscribe of wiring.unsubscribes) unsubscribe()
      }
    })
  }))
  try {
    await Effect.runPromise(program.pipe(
      Effect.provideService(EventReaderService, asAsyncEventReadSurface(store)),
      Effect.provideService(EventStoreWriterService, store),
      Effect.provideService(EventStoreWriterLaneService, store.writerLane),
    ))
  } finally {
    await bus.dispose()
    await store.close()
  }
})

test.each([false, true])("settled child requests update parent metrics before child completion, concurrent=%s", async (concurrent) => {
  const store = createRuntimeEventStore(join(databaseDirectory, "flywheel.sqlite"))
  const bus = new EventBus()
  const metrics: Parameters<MetricsWriter>[0][] = []
  const sessionId = "parent-session"
  const program = Effect.scoped(Effect.gen(function* () {
    const resources = yield* acquireSessionResources({ sessionId, projectRoot: "/test-project", emitter: createEmit(bus), eventBus: bus, projectionReader: asAsyncEventReadSurface(store) })
    const wiring = wireSessionSubscribers(bus, resources, (patch) => { metrics.push(patch) })
    yield* Effect.promise(async () => {
      const settlement = createSessionUsageSettlement({
        owner: { kind: "session", sessionId },
        reader: asAsyncEventReadSurface(store),
        writer: resources.sessionEventWriter,
        acquireAuthority: async (profileId) => ({
          profileId,
          authorityIncarnation: "test-authority",
          append: () => ({ kind: "appended" }),
          release: async () => {},
        }),
      })
      const attempts: string[] = []
      for (const [index, parentToolUseId] of ["child-a", "child-b", undefined].entries()) {
        const entry: UsageEntry = {
          attemptId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          occurredAt: "2026-09-07T12:00:00.000Z",
          profileId: "profile-a",
          currency: "USD", coverage: "complete",
          attribution: { kind: "candidate", providerId: "anthropic_api" },
          spendMode: "direct_api",
          credentialLineage: "00000000-0000-4000-8000-000000000010",
          model: "claude-sonnet-4",
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          classification: "real_spend",
          price: { kind: "priced", estimatedUsd: 0.25, rateCard: { inputPerMillionUsd: 3 }, provenance: "live" },
        }
        await settlement.checkpoint({
          entry,
          budgetStreamId: parentToolUseId ?? sessionId,
          requestId: `request-${index}`,
          identity: { providerSessionKey: "provider", conversationId: parentToolUseId ?? "parent" },
          turn: index + 1,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        })
        attempts.push(entry.attemptId)
      }
      const settle = async (attemptId: string, index: number): Promise<void> => {
        await settlement.settle(attemptId, { served: true })
        await bus.drain()
        if (!concurrent) {
          expect(metrics).toHaveLength(index + 1)
          expect(metrics.at(-1)).toMatchObject({ cost: 0.25 * (index + 1), tokens: 15 * (index + 1) })
        }
      }
      if (concurrent) await Promise.all([
        ...attempts.map(settle),
        resources.budgetStore.recordContextUtilization(20, 100).then(() => {
          resources.budgetStore.getContextUtilization()
        }),
      ])
      else for (const [index, attemptId] of attempts.entries()) await settle(attemptId, index)
      expect(metrics.at(-1)).toMatchObject({ cost: 0.75, tokens: 45 })
      const updateCount = metrics.length
      for (const attemptId of attempts) {
        await settlement.settle(attemptId, { served: true })
        await bus.drain()
        expect(metrics).toHaveLength(updateCount)
      }
      const facts = store.read({ aggregateId: `session:${sessionId}` })
      expect(facts.filter((fact) => fact.type === "model.usage.measured")).toHaveLength(3)
      expect(facts.some((fact) => fact.type === "subagent.completed" || fact.type === "budget.stream.completed")).toBe(false)
      expect(await resources.budgetStore.getTotalCost()).toBe(0.75)
      for (const unsubscribe of wiring.unsubscribes) unsubscribe()
    })
  }))
  try {
    await Effect.runPromise(program.pipe(
      Effect.provideService(EventReaderService, asAsyncEventReadSurface(store)),
      Effect.provideService(EventStoreWriterService, store),
      Effect.provideService(EventStoreWriterLaneService, store.writerLane),
    ))
  } finally {
    await bus.dispose()
    await store.close()
  }
})

test.each([2, 20])("usage completeness uses one owner request with %s unsettled sessions", async (members) => {
  const store = createRuntimeEventStore(join(databaseDirectory, "flywheel.sqlite"))
  const writer = store
  const counter = countStateRequests(asAsyncEventReadSurface(store))
  const usageIncomplete = createRuntimeUsageDeps({
    moduleSelection: () => { throw new Error("provider definitions are not read by usage completeness") },
    eventReader: counter.reader,
  }).usageIncomplete
  try {
    await writer.putInFlight?.("session-a", USAGE_SETTLEMENT_IN_FLIGHT_KIND, "attempt-a", {
      profileId: "profile-a",
    })
    await writer.putInFlight?.("session-b", USAGE_SETTLEMENT_IN_FLIGHT_KIND, "attempt-b", {
      entry: { profileId: "profile-b" },
    })
    for (let index = 2; index < members; index += 1) {
      await writer.putInFlight?.(`session-${index}`, USAGE_SETTLEMENT_IN_FLIGHT_KIND, `attempt-${index}`, { profileId: "profile-a" })
    }
    expect(await usageIncomplete("absent-profile")).toBe(false)
    expect(counter.take()).toHaveLength(1)

    expect(await usageIncomplete("profile-a")).toBe(true)
    expect(await usageIncomplete("profile-b")).toBe(true)
    await writer.dropInFlight?.("session-b", USAGE_SETTLEMENT_IN_FLIGHT_KIND, "attempt-b")
    expect(await usageIncomplete("profile-a")).toBe(true)
    expect(await usageIncomplete("profile-b")).toBe(false)
    await writer.dropInFlight?.("session-a", USAGE_SETTLEMENT_IN_FLIGHT_KIND, "attempt-a")
    expect(await usageIncomplete("profile-a")).toBe(members > 2)
  } finally {
    await store.close()
  }
})
