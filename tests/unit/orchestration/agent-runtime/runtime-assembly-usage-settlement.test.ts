import { expect, test } from "bun:test"
import { testProviderSessionLifetime } from "../../../helpers/provider-authority.js";
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../src/infra/event-store-types.js"
import { EventBus, createEmit } from "../../../../src/infra/event-bus.js"
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import type { RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { subscribeSessionRuntimeFacts } from "../../../../src/orchestration/session/create-session-infra.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testDirectories } from "../../../helpers/directories.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { asModelClient, ownHistoryTarget } from "./_model-client.js"
import { withTurnRequestScope } from "../../../../src/orchestration/agent-runtime/turn-request-model-client.js"
import { FUNCTION_TOOL_PRESENTATION, type AdmittedModelRequestRun, type ConversationMessage, type LLMClient, type ServingAttempt } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { TurnUsageTracker } from "../../../../src/orchestration/agent-runtime/turn-usage-tracker.js"
import type { UsageSettlementDraft } from "../../../../src/orchestration/agent-runtime/usage-settlement.js"
import type { MeasuredUsageEntry, UsageEntry } from "../../../../src/infra/llm/usage-entry.js"
import { failoverFailure, preparedRequest } from "./llm/_provider-chain-harness.js"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { capabilityAccessHolding, makeContext } from "./tools/_fixtures.js"
import { makeDeps as makeSubagentDeps } from "./subagent/_fixtures.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import type { DurableOwner } from "../../../../src/infra/durable-owner.js"

const recoveredDraft = {
  entry: {
    attemptId: "00000000-0000-4000-8000-000000000001",
    occurredAt: "2026-01-01T00:00:00.000Z",
    profileId: "profile-1",
    attribution: { kind: "candidate", providerId: "anthropic_api" },
    spendMode: "direct_api",
    credentialLineage: "00000000-0000-4000-8000-000000000002",
    model: "test",
    classification: "real_spend",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    price: { kind: "priced", estimatedUsd: 0.25, rateCard: { inputPerMillionUsd: 1 }, provenance: "live" },
    currency: "USD", coverage: "complete",
  },
  budgetStreamId: "session-1",
  requestId: "request-1",
  identity: { providerSessionKey: "provider", conversationId: "conversation-1" },
  turn: 1,
}

test("turn request usage starts for the captured admission's selected attempt before its settlement", async () => {
  const calls: string[] = []
  const selected: ServingAttempt = {
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "selected",
    contextLimit: 1000,
    outputLimit: 100,
    supportsReasoning: false,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  }
  const selectedClient: LLMClient = { historyTarget: ownHistoryTarget,
    ...selected,
    async *streamWithTools() {},
  }
  const capturedRequest = {
    candidateAttributions: [],
    prepare: async () => { throw new Error("this fake serves sends only") },
    async run<T>(request: AdmittedModelRequestRun<T>): Promise<T> {
      calls.push("admitted.run")
      const prepared = await request.prepare(selected)
      const result = await request.execute({ attempt: selected, client: selectedClient, prepared, sample: 1, repetitionGuard: "detect" })
      if (result.kind === "provider_failure" || result.kind === "repetition") {
        throw result.failure
      }
      return result.value
    },
    plannedAttempt: async () => selected,
  }
  const usageTracker: TurnUsageTracker = {
    beginAttempt: () => { calls.push("usage.begin") },
    handleUsage: () => {},
    commitEntry: () => false,
    commitPublishedEntry: () => false,
    resetTurn: () => {},
    getTotals: () => ({ cost: 0, billedCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 }),
    getTurnTokens: () => ({ inputTokens: 0, outputTokens: 0 }),
    getTurnCacheTokens: () => ({ cacheReadTokens: 0, cacheCreateTokens: 0 }),
  }
  const client = withTurnRequestScope({
    model: "test",
    modelFamily: "anthropic",
    admitRequest: async () => capturedRequest,
    plannedAttempt: async () => { throw new Error("uncaptured planning") },
  }, usageTracker)

  const admitted = await client.admitRequest()
  expect(calls).toEqual([])
  const failure = failoverFailure(Object.assign(new Error("selected attempt failed"), { status: 503 }))
  await expect(admitted.run({
    prepare: preparedRequest,
    execute: async ({ attempt, client: attemptClient }) => {
      calls.push(`execute:${attempt.model}:${attemptClient.model}`)
      return {
        kind: "provider_failure",
        failure,
      }
    },
  })).rejects.toBe(failure)

  expect(calls).toEqual(["admitted.run", "usage.begin", "execute:selected:selected"])
})

test.each(["durable-tree", "replay"] as const)("only the durable owner recovers captured Usage authority: %s", async (kind) => {
  const acquired: string[] = []
  const events: Array<{ readonly type: string; readonly data: unknown }> = []
  const root = mkdtempSync(join(tmpdir(), "flywheel-usage-settlement-"))
  const reader = createSqliteEventStore(join(root, "flywheel.sqlite"))
  reader.putInFlight("session-1", "usage.settlement", recoveredDraft.entry.attemptId, recoveredDraft)
  const writer = createSessionFactWriter({ sessionId: "session-1", writer: asAsyncEventWriter(reader) })
  const bus = new EventBus()
  const emit = createEmit(bus)
  const runtimeFacts = subscribeSessionRuntimeFacts(bus, { sessionEventWriter: writer })
  const unsubscribeEvents = bus.subscribe((event) => { events.push(event) }, { deliveryClass: "ui" })
  try {
    const options: RunnableAgentOptions = {
      model: "test",
      ...testDirectories(process.cwd()),
      purpose: { kind: "interactive-chat" },
      agentsMd: "",
      onEvent: (event) => emit(event.type, { sessionId: "session-1", data: event.data }),
      moduleSelection: testCapabilityModules,
      awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
      runtimeSurfaces: {},
      lifecycle: { kind: "one-shot" },
      conversation: { kind: "stateless" },
      sessionEventStore: asAsyncEventReadSurface(reader),
      sessionEventWriter: writer,
      usageProfile: {
        profileId: "profile-1",
        authorityIncarnation: "incarnation-1",
        acquireAuthority: async (profileId) => ({ profileId, authorityIncarnation: "incarnation-1", append: () => { acquired.push(profileId); return { kind: "appended" as const } }, release: async () => {} }),
      },
    }
    const signal = new AbortController().signal
    const loop = await assembleRuntimeForTurn({
      providerSessionLifetime: testProviderSessionLifetime(),
      options,
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation(kind === "durable-tree"
        ? { kind, reserveMessageId: async () => crypto.randomUUID(), sessionId: "session-1", conversationId: "conversation-1", priorMessages: [], append: () => {}, captureCommittedForkMessages: async () => [], resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }) }
        : { kind, sessionId: "session-1", priorMessages: [] }, { providerSessionKey: "provider", artifactScopeId: "artifact", retrievalSessionId: "session-1" }),
      signal,
      disposalSignal: signal,
      instruction: null,
      currentTurn: undefined,
      personas: new Map(),
      captureModelRuntime: async () => ({
        generation: {},
        createLLMClient: async () => asModelClient({
          accessProvider: "anthropic_api",
          modelFamily: "anthropic",
          model: "test",
          contextLimit: 1000,
          outputLimit: 100,
          supportsReasoning: false,
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools() {},
        }),
      }),
      createRunner: () => { throw new Error("unused") },
    })
    expect(loop.sessionEventStore).toBe(asAsyncEventReadSurface(reader))
    await loop.tools.resolve()
    loop.onEvent({ kind: "done", stopReason: "end_turn" })
    await bus.drain()
    expect(acquired).toEqual(kind === "durable-tree" ? ["profile-1"] : [])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "model.turn.completed", data: { total_cost_usd: kind === "durable-tree" ? 0.25 : 0, billed_cost_usd: kind === "durable-tree" ? 0.25 : 0 } })
    const usageFacts = reader.read({ aggregateId: "session:session-1", types: ["model.usage.measured"] })
    expect(usageFacts).toHaveLength(kind === "durable-tree" ? 1 : 0)
    if (kind === "durable-tree") expect(usageFacts[0]).toMatchObject({ version: 6, payload: { attemptId: recoveredDraft.entry.attemptId } })
    expect(reader.readInFlight("session-1", "usage.settlement")).toHaveLength(kind === "durable-tree" ? 0 : 1)
    expect(JSON.stringify(reader.readInFlight("session-1", "usage.settlement"))).not.toContain("profileDir")
    expect(JSON.stringify(reader.readInFlight("session-1", "usage.settlement"))).not.toContain("/profile")
  } finally {
    runtimeFacts.unsubscribe()
    unsubscribeEvents()
    writer.dispose()
    await bus.dispose()
    reader.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(["session", "workflow"] as const)("auxiliary replay settles once under its %s owner without recovering the live parent", async (kind) => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-auxiliary-settlement-"))
  const store = createSqliteEventStore(join(root, "flywheel.sqlite"))
  const pending = { state: "pending", attemptId: "parent-attempt", requestId: "parent-request", profileId: "profile-1", budgetStreamId: "session-1", identity: recoveredDraft.identity, turn: 1 }
  store.putInFlight("session-1", "usage.settlement", "parent-attempt", pending)
  let recoveryReads = 0
  const ownerId = kind === "session" ? "session-1" : "workflow-1"
  const owner: DurableOwner = kind === "session" ? { kind, sessionId: ownerId } : { kind, workflowId: ownerId }
  const writer = createSessionFactWriter({
    owner,
    writer: asAsyncEventWriter(store),
  })
  const storedReader = asAsyncEventReadSurface(store)
  const reader: AsyncEventStateReadSurface = {
    ...storedReader,
    readInFlight: async (sessionId, kinds) => {
      recoveryReads++
      return await storedReader.readInFlight(sessionId, kinds)
    },
  }
  const events: Array<{ readonly type: string; readonly data: unknown }> = []
  const entries: UsageEntry[] = []
  const source: [ConversationMessage] = [{ kind: "user", content: [{ type: "text", text: "parent context" }] }]
  const options: RunnableAgentOptions = {
    model: "test",
    ...testDirectories(process.cwd()),
    purpose: { kind: "headless-task", prompt: { kind: "literal", systemPrompt: "Answer the question." } },
    agentsMd: "",
    onEvent: (event) => { events.push(event) },
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    runtimeSurfaces: {},
    lifecycle: { kind: "one-shot" },
    maxLLMCalls: 1,
    toolProfile: "none",
    conversation: {
      kind: "replay",
      ...(kind === "session" ? { sessionId: ownerId } : {}),
      providerSessionKey: "auxiliary-provider",
      priorMessages: source,
      requestAccounting: { owner, streamId: "auxiliary-stream", writer, reader },
    },
    usageProfile: {
      profileId: "profile-1",
      authorityIncarnation: "incarnation-1",
      acquireAuthority: async (profileId) => ({
        profileId,
        authorityIncarnation: "incarnation-1",
        append: (entry) => { entries.push(entry); return { kind: "appended" as const } },
        release: async () => {},
      }),
    },
  }
  const signal = new AbortController().signal
  let providerCalls = 0
  try {
    const loop = await assembleRuntimeForTurn({
      providerSessionLifetime: testProviderSessionLifetime(),
      options,
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: "fallback", artifactScopeId: "artifact", retrievalSessionId: "retrieval" }),
      signal, disposalSignal: signal, instruction: "side question", currentTurn: undefined,
      personas: new Map(),
      captureModelRuntime: async () => ({
        generation: {},
        createLLMClient: async () => asModelClient({
          accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test",
          accessProviderCandidate: { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" },
          credentialLineage: recoveredDraft.entry.credentialLineage,
          contextLimit: 100_000, outputLimit: 100, supportsReasoning: false,
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools(input) {
            providerCalls++
            expect(input.tools).toEqual([])
            expect(input.messages).toContainEqual(source[0])
            expect(store.readInFlight(ownerId, "usage.settlement")).toHaveLength(kind === "session" ? 2 : 1)
            yield { kind: "text_delta", text: "side answer", blockKey: "answer" }
            yield { kind: "usage", final: true, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 }
            yield { kind: "done", stopReason: "end_turn" }
          },
        }),
      }),
      createRunner: () => { throw new Error("unused") },
    })
    expect(loop.usageSettlement?.budgetStreamId).toBe("auxiliary-stream")
    expect(recoveryReads).toBe(0)
    expect(await runAgentLoop(loop)).toMatchObject({ kind: "completed" })
    expect(providerCalls).toBe(1)
    expect(entries).toHaveLength(1)
    await loop.usageSettlement?.settlement.settle(entries[0]!.attemptId, { served: true })
    expect(entries).toHaveLength(1)
    expect(store.readInFlight("session-1", "usage.settlement").map(({ key, payload }) => ({ key, payload }))).toEqual([{ key: "parent-attempt", payload: pending }])
    expect(source).toEqual([{ kind: "user", content: [{ type: "text", text: "parent context" }] }])
    const facts = store.read({ aggregateId: `${kind}:${ownerId}` })
    const measured = facts.filter((fact) => fact.type === "model.usage.measured")
    expect(measured).toHaveLength(1)
    expect(measured[0]).toMatchObject({ aggregateId: `${kind}:${ownerId}`, payload: { budgetStreamId: "auxiliary-stream", attemptId: entries[0]!.attemptId } })
    const usageAudit = facts.filter((fact) => fact.type === "model.usage.recorded")
    expect(usageAudit).toHaveLength(1)
    expect(usageAudit[0]!.payload.identity).toEqual({ providerSessionKey: "auxiliary-provider" })
    const prompt = facts.filter((fact) => fact.type === "prompt.assembled")
    expect(prompt).toHaveLength(1)
    expect(prompt[0]).toMatchObject({ payload: { identity: { providerSessionKey: "auxiliary-provider" } } })
    expect(prompt[0]!.payload.treeLeafEntryId).toBeUndefined()
    expect(events.some((event) => event.type === "model.context.measured")).toBe(false)
    expect(events.some((event) => event.type === "model.usage.measured")).toBe(false)
    if (kind === "workflow") expect(store.read({ aggregateId: `session:${ownerId}` })).toEqual([])
  } finally {
    writer.dispose()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("stateless profile-backed runs report subscription-equivalent cost", async () => {
  const appended: UsageEntry[] = []
  const events: Array<{ readonly type: string; readonly data: unknown }> = []
  const options: RunnableAgentOptions = {
    model: "test",
    ...testDirectories(process.cwd()),
    purpose: { kind: "persona-benchmark" },
    agentsMd: "",
    onEvent: (event) => { events.push(event) },
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    runtimeSurfaces: {},
    lifecycle: { kind: "one-shot" },
    conversation: { kind: "stateless" },
    usageProfile: {
      profileId: "profile-1",
      authorityIncarnation: "incarnation-1",
      acquireAuthority: async () => ({
        profileId: "profile-1",
        authorityIncarnation: "incarnation-1",
        append: (entry) => {
          appended.push(entry)
          return { kind: "appended" as const }
        },
        release: async () => {},
      }),
    },
  }
  const signal = new AbortController().signal
  const loop = await assembleRuntimeForTurn({
    providerSessionLifetime: testProviderSessionLifetime(),
    options,
    definitions: repoDefinitions(),
    conversation: resolveRuntimeConversation(
      { kind: "stateless" },
      { providerSessionKey: "provider", artifactScopeId: "benchmark-cell", retrievalSessionId: "benchmark-cell" },
    ),
    signal,
    disposalSignal: signal,
    instruction: null,
    currentTurn: undefined,
    personas: new Map(),
    captureModelRuntime: async () => ({
      generation: {},
      createLLMClient: async () => asModelClient({
        accessProvider: "chatgpt",
        modelFamily: "openai",
        model: "test",
        contextLimit: 1000,
        outputLimit: 100,
        supportsReasoning: false,
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools() {},
      }),
    }),
    createRunner: () => { throw new Error("unused") },
  })

  const settlement = loop.usageSettlement?.settlement
  expect(settlement).toBeDefined()
  if (!settlement) throw new Error("stateless usage settlement was not assembled")
  const entry: MeasuredUsageEntry = {
    ...recoveredDraft.entry,
    currency: "USD", coverage: "complete",
    attribution: { kind: "candidate" as const, providerId: "chatgpt", instanceId: "chatgpt-account" },
    spendMode: "included" as const,
    classification: "subscription_equivalent" as const,
    price: { kind: "priced" as const, estimatedUsd: 0.25, rateCard: { inputPerMillionUsd: 1 }, provenance: "live" },
  }
  const draft: UsageSettlementDraft = {
    ...recoveredDraft,
    entry,
    budgetStreamId: "benchmark-cell",
    identity: { providerSessionKey: "provider", conversationId: "benchmark-cell" },
  }
  const { tokens: _tokens, price: _price, currency: _currency, ...attempt } = entry
  await settlement.begin({ ...draft, entry: { ...attempt, coverage: "unmeasured" } })
  await settlement.checkpoint(draft)
  await settlement.settle(entry.attemptId, { served: true })
  await loop.tools.resolve()
  loop.onEvent({ kind: "done", stopReason: "end_turn" })

  expect(appended).toEqual([entry])
  expect(events).toContainEqual(expect.objectContaining({
    type: "model.usage.measured",
    data: expect.objectContaining({ usage_entry: entry }),
  }))
  expect(events).toContainEqual(expect.objectContaining({
    type: "model.turn.completed",
    data: expect.objectContaining({ total_cost_usd: 0.25, billed_cost_usd: 0 }),
  }))
})

test("assembled subagent retains the parent runtime's captured Usage authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-subagent-usage-profile-"))
  const reader = createSqliteEventStore(join(root, "flywheel.sqlite"))
  const writer = createSessionFactWriter({ sessionId: "session-1", writer: asAsyncEventWriter(reader) })
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }))
  const usageProfile: NonNullable<RunnableAgentOptions["usageProfile"]> = {
    profileId: "profile-1",
    authorityIncarnation: "incarnation-1",
    acquireAuthority: async () => { throw new Error("not used") },
  }
  const childOptions: RunnableAgentOptions[] = []
  const childCreated = Promise.withResolvers<void>()
  const options: RunnableAgentOptions = {
    model: "test",
    ...testDirectories(process.cwd()),
    purpose: { kind: "interactive-chat" },
    agentsMd: "",
    onEvent: () => {},
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    resolveRoles: async () => new Map([["explorer", {
      roleId: "explorer",
      model: "test",
      effort: "medium",
    }]]),
    runtimeSurfaces: { background },
    lifecycle: { kind: "one-shot" },
    conversation: { kind: "stateless" },
    sessionEventStore: asAsyncEventReadSurface(reader),
    sessionEventWriter: writer,
    subagentSessions: makeSubagentDeps().subagentSessions,
    usageProfile,
  }
  const signal = new AbortController().signal
  try {
    const loop = await assembleRuntimeForTurn({
      providerSessionLifetime: testProviderSessionLifetime(),
      options,
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation({
        kind: "durable-tree",
        reserveMessageId: async () => crypto.randomUUID(),
        sessionId: "session-1",
        conversationId: "conversation-1",
        priorMessages: [],
        append: () => {},
        captureCommittedForkMessages: async () => [],
        resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }),
      }, { providerSessionKey: "provider", artifactScopeId: "artifact", retrievalSessionId: "session-1" }),
      signal,
      disposalSignal: signal,
      instruction: null,
      currentTurn: undefined,
      personas: new Map([["explorer", {
        kind: "persona",
        name: "explorer",
        description: "Explore",
        role: "explorer",
        tools: [],
        maxTurns: 1,
        systemPrompt: "Explore.",
      } as const]]),
      captureModelRuntime: async () => ({
        generation: {},
        createLLMClient: async () => asModelClient({
          accessProvider: "anthropic_api",
          modelFamily: "anthropic",
          model: "test",
          contextLimit: 1000,
          outputLimit: 100,
          supportsReasoning: false,
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools() {},
        }),
      }),
      createRunner: (child) => {
        childOptions.push(child)
        childCreated.resolve()
        return {
          send() {},
          end() {},
          abort() {},
          done: Promise.resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "child", terminal: { kind: "completed" } }),
        }
      },
    })
    const surface = await loop.tools.resolve()
    const subagent = surface.tools.get("subagent")
    if (!subagent) throw new Error("expected subagent tool")
    await subagent.execute(
      {
        persona: "explorer",
        rationale: "The assembly boundary must preserve the captured usage authority.",
        prompt: "Inspect usage.",
      },
      makeContext({
        toolUseId: "subagent-1",
        conversationId: "conversation-1",
        availableTools: new Set(surface.tools.keys()),
        capabilityAccess: capabilityAccessHolding(["subagents"]),
      }),
    )
    await childCreated.promise

    expect(childOptions.map((child) => ({
      purpose: child.purpose,
      usageProfile: child.usageProfile,
    }))).toEqual([{
      purpose: { kind: "subagent", renderAs: "subagent", parentToolUseId: "subagent-1" },
      usageProfile,
    }])
  } finally {
    await background.close()
    writer.dispose()
    reader.close()
    rmSync(root, { recursive: true, force: true })
  }
})
