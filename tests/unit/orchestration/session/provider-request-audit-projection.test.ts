import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { EventStore } from "../../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../../src/infra/invariant"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import type { ProviderRequestAuditFact } from "../../../../src/orchestration/session/provider-request-audit-facts"
import { loadProviderRequestAuditFromEvents } from "../../../../src/orchestration/session/provider-request-audit-projection"
import { recordProviderStreamSummary } from "../../../../src/orchestration/session/provider-request-audit-recorder"
import type { ProviderStreamSummary, ProviderTransportContext } from "../../../../src/orchestration/session/provider-request-audit-types"

let tmpDir: string
const retiredGeneration = [5, 6].join(".")

function appendFact(store: EventStore, sessionId: string, fact: ProviderRequestAuditFact): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    type: fact.type,
    version: fact.version,
    timestamp: Date.now(),
    actor: fact.actor,
    sessionId,
    payload: fact.payload,
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "flywheel-provider-audit-projection-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("provider-request-audit projection invariants", () => {
  test("projects compaction purpose while historical prompts remain untagged", () => {
    const historical = promptFact("historical")
    const compaction: ProviderRequestAuditFact = {
      type: "prompt.assembled",
      version: 5,
      actor: "flywheel",
      payload: {
        requestId: "compaction",
        identity: { providerSessionKey: "provider-compaction" },
        turn: 1,
        promptKind: "chat",
        requestPurpose: "compaction",
        systemPromptHash: "a".repeat(64),
        toolSurfaceHash: "b".repeat(64),
        promptSha256: "c".repeat(64),
        messageCount: 3,
        estimatedContextTokens: 100,
        attemptStaticTokens: 10,
        contextWindow: 200_000,
      },
    }

    const entries = loadProviderRequestAuditFromEvents([
      storedFact(historical, 1),
      storedFact(compaction, 2),
    ])

    expect(entries[0]?.prompt?.requestPurpose).toBeUndefined()
    expect(entries[1]?.prompt?.requestPurpose).toBe("compaction")
  })

  test("model.stream.event_observed without prior prompt.assembled throws InvariantViolation kind=missing-producer-event", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "audit-orphan-stream"
    appendFact(store, sessionId, {
      type: "model.stream.event_observed",
      version: 1,
      actor: "provider",
      payload: {
        requestId: "ghost-request",
        conversationId: "conv-1",
        turn: 1,
        sequence: 1,
        source: "provider",
        kind: "delta",
        elapsedMs: 10,
        sincePreviousMs: 10,
        metadata: {},
      },
    })

    let caught: unknown
    try {
      loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    } catch (err) {
      caught = err
    }
    store.close()

    expect(caught).toBeInstanceOf(InvariantViolation)
    if (!(caught instanceof InvariantViolation)) throw new Error("expected an InvariantViolation")
    const violation = caught
    expect(violation.kind).toBe("missing-producer-event")
    expect(violation.eventType).toBe("model.stream.event_observed")
    expect(violation.detail).toContain("ghost-request")
  })

  test("model.stream.started without prior prompt.assembled throws InvariantViolation", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "audit-orphan-started"
    appendFact(store, sessionId, {
      type: "model.stream.started",
      version: 1,
      actor: "provider",
      payload: { requestId: "phantom", conversationId: "c", turn: 1 },
    })

    let caught: unknown
    try {
      loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    } catch (err) {
      caught = err
    }
    store.close()

    expect(caught).toBeInstanceOf(InvariantViolation)
    if (!(caught instanceof InvariantViolation)) throw new Error("expected an InvariantViolation")
    expect(caught.kind).toBe("missing-producer-event")
  })

  test("happy path: prompt.assembled then model.stream.* builds a valid entry", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "audit-happy"
    appendFact(store, sessionId, {
      type: "prompt.assembled",
      version: 2,
      actor: "flywheel",
      payload: {
        requestId: "req-1",
        conversationId: "conv-1",
        turn: 1,
        promptKind: "model.user_message.recorded",
        systemPromptHash: "sys-hash",
        systemPrompt: "be helpful",
        toolSurfaceHash: "tool-hash",
        promptSha256: "a".repeat(64),
        messageCount: 1,
        estimatedContextTokens: 100,
        contextWindow: 200_000,
        treePointer: { conversationId: "conv-1", leafEntryId: "leaf-1" },
      },
    })
    appendFact(store, sessionId, {
      type: "model.stream.started",
      version: 1,
      actor: "provider",
      payload: { requestId: "req-1", conversationId: "conv-1", turn: 1 },
    })
    appendFact(store, sessionId, {
      type: "model.stream.completed",
      version: 1,
      actor: "provider",
      payload: {
        requestId: "req-1",
        conversationId: "conv-1",
        turn: 1,
        durationMs: 150,
        eventCount: 1,
        outcome: "ok",
      },
    })
    appendFact(store, sessionId, {
      type: "model.usage.recorded",
      version: 1,
      actor: "provider",
      payload: {
        requestId: "req-1",
        conversationId: "conv-1",
        turn: 1,
        stepId: "step-1",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningTokens: 1,
        promptTokens: 15,
        deltaCostUsd: 0.02,
      },
    })

    const entries = loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      requestId: "req-1",
      identity: { providerSessionKey: "conv-1" },
      turn: 1,
    })
    expect(entries[0]?.stream?.outcome).toBe("ok")
    expect(entries[0]?.usage).toMatchObject({
      workflowAttemptId: "step-1",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      reasoningTokens: 1,
      promptTokens: 15,
      deltaCostUsd: 0.02,
    })
  })

  test("decodes historical usage and recovers the same current entry idempotently while rejecting conflicts", () => {
    const current: ProviderRequestAuditFact = {
      type: "model.usage.recorded",
      version: 3,
      actor: "provider",
      payload: {
        requestId: "req-1",
        attemptId: "req-1",
        identity: { providerSessionKey: "conv-1" },
        turn: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningTokens: 1,
        promptTokens: 15,
      },
    }
    const prompt = storedFact(promptFact("req-1"), 1)
    const usage = storedFact(current, 2)

    expect(loadProviderRequestAuditFromEvents([prompt, usage, usage])[0]?.usage).toMatchObject({
      attemptId: "req-1",
      inputTokens: 10,
      promptTokens: 15,
    })
    expect(() => loadProviderRequestAuditFromEvents([prompt, usage, storedFact(current, 3)])).toThrow(InvariantViolation)

    const historicalV2 = storedFact({
      type: "model.usage.recorded",
      version: 2,
      actor: "provider",
      payload: {
        requestId: "req-1",
        identity: { providerSessionKey: "conv-1" },
        turn: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningTokens: 1,
        promptTokens: 15,
        deltaCostUsd: 0.02,
      },
    }, 2)
    expect(loadProviderRequestAuditFromEvents([prompt, historicalV2])[0]?.usage).toMatchObject({ deltaCostUsd: 0.02 })
  })


  test("an unchanged-surface request resolves toolSurface from prompt.assembled's hash (no second fact)", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "audit-tool-dedup"

    const promptFor = (requestId: string, turn: number) => ({
      type: "prompt.assembled" as const,
      version: 2 as const,
      actor: "flywheel" as const,
      payload: {
        requestId, conversationId: "conv-1", turn, promptKind: "chat",
        systemPromptHash: "sys", toolSurfaceHash: "tools", promptSha256: "a".repeat(64),
        messageCount: turn, estimatedContextTokens: 10, contextWindow: 200_000,
      },
    })

    appendFact(store, sessionId, promptFor("req-1", 1))
    // Body stored once for hash "tools".
    appendFact(store, sessionId, {
      type: "tool_surface.selected",
      version: 2,
      actor: "flywheel",
      payload: {
        requestId: "req-1", conversationId: "conv-1", turn: 1, toolSurfaceHash: "tools",
        tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
        omittedTools: [{ name: "bash", reason: "scoped" }],
      },
    })
    // req-2 reuses the same surface — no tool_surface.selected fact at all.
    appendFact(store, sessionId, promptFor("req-2", 2))

    const entries = loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()

    expect(entries.map((e) => e.requestId)).toEqual(["req-1", "req-2"])
    expect(entries[1]?.toolSurface?.tools[0]?.name).toBe("read")
    expect(entries[1]?.toolSurface?.omittedTools[0]?.reason).toBe("scoped")
  })

  test("shares one immutable tool surface across a large unchanged-surface history", () => {
    const facts: ProviderRequestAuditFact[] = [promptFact("req-0"), toolSurfaceFact("req-0")]
    for (let index = 1; index < 2_000; index += 1) {
      facts.push(promptFact(`req-${index}`, { turn: index + 1 }))
    }

    const entries = loadProviderRequestAuditFromEvents(facts.map((fact, index) => storedFact(fact, index + 1)))
    const surface = entries[0]?.toolSurface
    expect(entries).toHaveLength(2_000)
    expect(entries.every((entry) => entry.toolSurface === surface)).toBe(true)
    expect(Object.isFrozen(surface?.tools)).toBe(true)
    expect(Object.isFrozen(surface?.tools[0])).toBe(true)
  })

  test("reconstructs proven empty and nonempty transformer sequences by context identity", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "audit-transformer-dedup"
    appendFact(store, sessionId, promptFact("req-1", { contextApplicationId: "context-application-1" }))
    appendFact(store, sessionId, contextManifest("req-1", "context-application-1", 1, "023e0c821760da4b2205b17589ead324dc74939f8a8470adf68c2db10919f271"))
    appendFact(store, sessionId, {
      type: "context.transformer.applied",
      version: 1,
      actor: "flywheel",
      payload: {
        requestId: "req-1", conversationId: "conv-1", turn: 1,
        contextApplicationId: "context-application-1", applicationId: "application-1",
        transformerId: "transformer-1", seam: "modelContext", order: 10, outcome: "applied",
        inputHash: "a".repeat(64), outputHash: "b".repeat(64),
      },
    })
    appendFact(store, sessionId, promptFact("req-2", { turn: 2, contextApplicationId: "context-application-1" }))
    appendFact(store, sessionId, promptFact("req-empty", { turn: 3, contextApplicationId: "context-empty" }))
    appendFact(store, sessionId, contextManifest("req-empty", "context-empty", 0, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"))

    const entries = loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()

    expect(entries[0]?.contextApplications).toEqual(entries[1]?.contextApplications)
    expect(entries[0]?.contextApplications).toHaveLength(1)
    expect(entries[2]?.contextApplications).toEqual([])
  })

  test("throws when a referenced transformer sequence manifest is missing", () => {
    const fact = promptFact("req-missing", { contextApplicationId: "context-missing" })
    expect(() => loadProviderRequestAuditFromEvents([storedFact(fact)])).toThrow(InvariantViolation)
  })

  test("throws on duplicate or inconsistent transformer sequence evidence", () => {
    const prompt = promptFact("req-invalid", { contextApplicationId: "context-invalid" })
    const manifest = contextManifest("req-invalid", "context-invalid", 0, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945")
    expect(() => loadProviderRequestAuditFromEvents([storedFact(prompt), storedFact(manifest), storedFact(manifest, 3)])).toThrow(InvariantViolation)

    const inconsistent = contextManifest("req-invalid", "context-invalid", 1, manifest.payload.sequenceDigest)
    expect(() => loadProviderRequestAuditFromEvents([storedFact(prompt), storedFact(inconsistent)])).toThrow(InvariantViolation)
  })

  test.each([1, 2] as const)("reads v%i summary-only diagnostics without inventing historical generation", (version) => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "audit-summary-only"
    appendFact(store, sessionId, promptFact("req-summary"))
    appendFact(store, sessionId, version === 1 ? {
      type: "model.stream.summary.recorded", version: 1, actor: "flywheel",
      payload: streamSummaryPayload("req-summary"),
    } : {
      type: "model.stream.summary.recorded", version: 2, actor: "flywheel",
      payload: (() => {
        const { conversationId, ...summary } = streamSummaryPayload("req-summary")
        return { ...summary, identity: { providerSessionKey: conversationId } }
      })(),
    })

    const entries = loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()

    expect(entries[0]?.stream).toMatchObject({
      eventCount: 2,
      outcome: "ok",
      events: [],
      summary: { rawEventCount: 2, firstVisibleDeltaMs: 100, generation: { kind: "unavailable", reason: "historical" } },
    })
  })

  test("writes strict v3 measurements and replays them unchanged", async () => {
    const dbFile = resolveEventStoreDbFile(tmpDir)
    const store = createSqliteEventStore(dbFile)
    const sessionId = "audit-generation"
    appendFact(store, sessionId, promptFact("req-generation"))
    const { conversationId, ...historical } = streamSummaryPayload("req-generation")
    const generation = { kind: "recorded", basis: "O200kBase", outputTokens: 12, durationMs: 1500, measuredBlocks: 2, excludedBlocks: 1 } as const
    const summary: ProviderStreamSummary = {
      ...historical, identity: { providerSessionKey: conversationId },
      generation,
    }
    const audit = { observe(fact: ProviderRequestAuditFact) { appendFact(store, sessionId, fact) } }
    try {
      await recordProviderStreamSummary(audit, summary)
      await expect(recordProviderStreamSummary(audit, { ...summary, generation: { ...generation, outputTokens: -1 } })).rejects.toThrow()
      const facts = store.read({ aggregateId: `session:${sessionId}` })
      expect(facts.filter((fact) => fact.type === "model.stream.summary.recorded").map((fact) => fact.version)).toEqual([3])
    } finally {
      store.close()
    }
    const reopened = createSqliteEventStore(dbFile)
    try {
      const entries = loadProviderRequestAuditFromEvents(reopened.read({ aggregateId: `session:${sessionId}` }))
      expect(entries[0]?.stream?.summary?.generation).toEqual(summary.generation)
    } finally {
      reopened.close()
    }
  })

  test("keeps raw stream detail when raw events and summary facts coexist", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "audit-summary-mixed"
    appendFact(store, sessionId, promptFact("req-mixed"))
    appendFact(store, sessionId, {
      type: "model.stream.event_observed",
      version: 1,
      actor: "provider",
      payload: {
        requestId: "req-mixed",
        conversationId: "conv-1",
        turn: 1,
        sequence: 1,
        source: "normalized",
        kind: "thinking_delta",
        elapsedMs: 100,
        sincePreviousMs: 100,
        metadata: {},
      },
    })
    appendFact(store, sessionId, {
      type: "model.stream.summary.recorded",
      version: 1,
      actor: "flywheel",
      payload: streamSummaryPayload("req-mixed"),
    })

    const entries = loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()

    expect(entries[0]?.stream?.events.map((event) => event.kind)).toEqual(["thinking_delta"])
    expect(entries[0]?.stream?.summary?.rawEventCount).toBe(2)
  })
  test("distinguishes a prepared request from observed provider dispatch", () => {
    const requested: ProviderRequestAuditFact = {
      type: "model.requested", version: 1, actor: "flywheel",
      payload: { requestId: "req-prepared", conversationId: "conv-1", turn: 1, model: "test-model", accessProvider: "anthropic_api", modelFamily: "anthropic" },
    }
    const prepared = loadProviderRequestAuditFromEvents([storedFact(promptFact("req-prepared")), storedFact(requested, 2)])
    expect(prepared[0]).toMatchObject({ dispatchState: "prepared", preparedAt: 2 })
    expect(prepared[0]?.dispatchedAt).toBeUndefined()
    expect(prepared[0]?.request?.interactionProfileId).toBeUndefined()
    expect(prepared[0]?.requestedAt).toBeUndefined()

    const dispatched: ProviderRequestAuditFact = {
      type: "model.request.dispatched", version: 1, actor: "provider",
      payload: { requestId: "req-prepared", conversationId: "conv-1", turn: 1 },
    }
    const observed = loadProviderRequestAuditFromEvents([
      storedFact(promptFact("req-prepared")), storedFact(requested, 2), storedFact(dispatched, 3),
    ])
    expect(observed[0]).toMatchObject({ dispatchState: "dispatched", preparedAt: 2, dispatchedAt: 3, requestedAt: 3 })
    expect(observed[0]?.completionState).toBe("unknown")

    const terminal: ProviderRequestAuditFact = {
      type: "model.response_received", version: 1, actor: "provider",
      payload: { requestId: "req-prepared", conversationId: "conv-1", turn: 1, outcome: "ok", durationMs: 1 },
    }
    const settled = loadProviderRequestAuditFromEvents([
      storedFact(promptFact("req-prepared")), storedFact(requested, 2), storedFact(dispatched, 3), storedFact(terminal, 4),
    ])
    expect(settled[0]?.completionState).toBe("terminal")
  })

  test("projects recorded v2 profile identity and rejects malformed v2 facts", () => {
    const requested: ProviderRequestAuditFact = {
      type: "model.requested", version: 2, actor: "flywheel",
      payload: {
        requestId: "req-v2", conversationId: "conv-1", turn: 1, model: "gpt-6-luna",
        accessProvider: "openai_api", modelFamily: "openai", interactionProfileId: "luna-native-v1",
      },
    }
    const projected = loadProviderRequestAuditFromEvents([
      storedFact(promptFact("req-v2")), storedFact(toolSurfaceFact("req-v2"), 2), storedFact(requested, 3),
    ])
    expect(projected[0]?.request?.interactionProfileId).toBe("luna-native-v1")

    expect(() => loadProviderRequestAuditFromEvents([
      storedFact(promptFact("req-invalid-v2")),
      {
        ...storedFact(requested, 2),
        payload: { ...requested.payload, requestId: "req-invalid-v2", interactionProfileId: "unknown" },
      },
    ])).toThrow()

    const experimental = loadProviderRequestAuditFromEvents([
      storedFact(promptFact("req-experimental")),
      storedFact(toolSurfaceFact("req-experimental"), 2),
      {
        ...storedFact(requested, 3),
        payload: {
          ...requested.payload,
          requestId: "req-experimental",
          interactionProfileId: `gpt-${retiredGeneration}-luna-shell-v1`,
        },
      },
    ])
    expect(experimental[0]?.request?.interactionProfileId).toBe("luna-shell-v1")
  })

  test("rejects duplicate, orphaned, mismatched, and out-of-order strict request facts", () => {
    const prompt = promptFact("req-strict")
    const requested: ProviderRequestAuditFact = {
      type: "model.requested", version: 2, actor: "flywheel",
      payload: {
        requestId: "req-strict", conversationId: "conv-1", turn: 1, model: "m",
        accessProvider: "anthropic_api", modelFamily: "anthropic", interactionProfileId: "default",
      },
    }
    const dispatched: ProviderRequestAuditFact = {
      type: "model.request.dispatched", version: 1, actor: "provider",
      payload: { requestId: "req-strict", conversationId: "conv-1", turn: 1 },
    }
    const terminal: ProviderRequestAuditFact = {
      type: "model.response_received", version: 1, actor: "provider",
      payload: { requestId: "req-strict", conversationId: "conv-1", turn: 1, outcome: "ok", durationMs: 1 },
    }
    const toolSurface: ProviderRequestAuditFact = {
      type: "tool_surface.selected", version: 2, actor: "flywheel",
      payload: { requestId: "req-strict", conversationId: "conv-1", turn: 1, toolSurfaceHash: "tools", tools: [], omittedTools: [] },
    }

    expect(() => loadProviderRequestAuditFromEvents([
      storedFact(prompt), storedFact(toolSurface, 2), storedFact(prompt, 3), storedFact(requested, 4),
    ])).toThrow(InvariantViolation)
    expect(() => loadProviderRequestAuditFromEvents([
      storedFact(prompt), storedFact(toolSurface, 2), storedFact(requested, 3), storedFact(requested, 4),
    ])).toThrow(InvariantViolation)
    expect(() => loadProviderRequestAuditFromEvents([
      storedFact(prompt), storedFact(toolSurface, 2), storedFact(requested, 3),
      { ...storedFact(dispatched, 4), payload: { ...dispatched.payload, conversationId: "other" } },
    ])).toThrow(InvariantViolation)
    expect(() => loadProviderRequestAuditFromEvents([
      storedFact(prompt), storedFact(toolSurface, 2), storedFact(dispatched, 3), storedFact(requested, 4),
    ])).toThrow(InvariantViolation)
    expect(() => loadProviderRequestAuditFromEvents([
      storedFact(prompt), storedFact(toolSurface, 2), storedFact(requested, 3), storedFact(dispatched, 4),
      storedFact(terminal, 5), storedFact(terminal, 6),
    ])).toThrow(InvariantViolation)
  })

  test("requires strict prompt bodies, permits one settled abandoned attempt, and projects a transport's record from a version 3 response only", () => {
    const prompt = promptFact("req-abandoned")
    const requested: ProviderRequestAuditFact = {
      type: "model.requested", version: 2, actor: "flywheel",
      payload: {
        requestId: "req-abandoned", conversationId: "conv-1", turn: 1, model: "m",
        accessProvider: "anthropic_api", modelFamily: "anthropic", interactionProfileId: "default",
      },
    }
    const abandoned: ProviderRequestAuditFact = {
      type: "model.response_received", version: 1, actor: "provider",
      payload: { requestId: "req-abandoned", conversationId: "conv-1", turn: 1, outcome: "stream_error", durationMs: 1 },
    }
    expect(loadProviderRequestAuditFromEvents([
      storedFact(prompt), storedFact(requested, 2), storedFact(abandoned, 3),
    ])[0]?.response?.outcome).toBe("stream_error")

    const surface: ProviderRequestAuditFact = {
      type: "tool_surface.selected", version: 2, actor: "flywheel",
      payload: { requestId: "req-abandoned", conversationId: "conv-1", turn: 1, toolSurfaceHash: "tools", tools: [], omittedTools: [] },
    }
    // A version 1 or 2 response predates the transport's record, so it reads as not recorded.
    const settled = loadProviderRequestAuditFromEvents([storedFact(prompt), storedFact(surface, 2), storedFact(requested, 3), storedFact(abandoned, 4)])[0]?.response
    expect(settled?.outcome).toBe("stream_error")
    expect(settled).not.toHaveProperty("transportContext")

    const transportContext: ProviderTransportContext = {
      identity: "claude-engine", additions: [{ part: "system", kind: "billing", at: 0 }], hiddenRequests: [{ source: "retry-line:thinking-signature" }], notRecorded: ["cache_control count"],
    }
    const recorded: ProviderRequestAuditFact = {
      type: "model.response_received", version: 3, actor: "provider",
      payload: { requestId: "req-abandoned", identity: { providerSessionKey: "conv-1" }, turn: 1, outcome: "ok", durationMs: 1, transportContext },
    }
    expect(loadProviderRequestAuditFromEvents([storedFact(prompt), storedFact(requested, 2), storedFact(recorded, 3)])[0]?.response).toMatchObject({ outcome: "ok", transportContext })
  })

})


function storedFact(fact: ProviderRequestAuditFact, position = 1): Parameters<typeof loadProviderRequestAuditFromEvents>[0][number] {
  return {
    id: `event-${position}`, aggregateId: "session:test", sessionId: "test", seq: position,
    type: fact.type, version: fact.version, actor: fact.actor, timestamp: position, payload: fact.payload, position,
  }
}

type PromptAssembledV2Fact = Extract<ProviderRequestAuditFact, { type: "prompt.assembled"; version: 2 }>

function contextManifest(requestId: string, contextApplicationId: string, applicationCount: number, sequenceDigest: string): Extract<ProviderRequestAuditFact, { type: "context.application.recorded"; version: 1 }> {
  return {
    type: "context.application.recorded", version: 1, actor: "flywheel",
    payload: { requestId, conversationId: "conv-1", turn: requestId === "req-1" ? 1 : 3, contextApplicationId, applicationCount, sequenceDigest },
  }
}
function promptFact(requestId: string, overrides: Partial<Pick<PromptAssembledV2Fact["payload"], "turn" | "contextApplicationId">> = {}): PromptAssembledV2Fact {
  return {
    type: "prompt.assembled",
    version: 2,
    actor: "flywheel",
    payload: {
      requestId,
      conversationId: "conv-1",
      turn: 1,
      promptKind: "chat",
      systemPromptHash: "sys",
      systemPrompt: "system",
      toolSurfaceHash: "tools",
      promptSha256: "a".repeat(64),
      messageCount: 1,
      estimatedContextTokens: 100,
      contextWindow: 200_000,
      ...overrides,
    },
  }
}

function toolSurfaceFact(requestId: string): ProviderRequestAuditFact {
  return {
    type: "tool_surface.selected", version: 2, actor: "flywheel",
    payload: { requestId, conversationId: "conv-1", turn: 1, toolSurfaceHash: "tools", tools: [], omittedTools: [] },
  }
}

function streamSummaryPayload(requestId: string): Extract<ProviderRequestAuditFact, { type: "model.stream.summary.recorded"; version: 1 }>["payload"] {
  return {
    requestId,
    conversationId: "conv-1",
    turn: 1,
    rawEventCount: 2,
    completedAt: 2_000,
    durationMs: 1_000,
    outcome: "ok",
    countsBySource: { normalized: 2 },
    countsByKind: { thinking_delta: 1, text_delta: 1 },
    firstVisibleDeltaMs: 100,
    interDelta: { count: 1, meanMs: 200, p50Ms: 200, p90Ms: 200, p99Ms: 200, maxMs: 200, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
    watchdog: { thinkingStallCount: 0 },
    recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 },
    bigGapTransitions: [],
  }
}
