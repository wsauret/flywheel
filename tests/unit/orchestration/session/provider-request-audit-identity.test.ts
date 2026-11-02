import { describe, expect, test } from "bun:test"
import type { StoredFact } from "../../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../../src/infra/invariant"
import { hashSystemPrompt, hashToolSurface } from "../../../../src/orchestration/session/provider-request-audit-hash"
import type { ProviderRequestAuditFact } from "../../../../src/orchestration/session/provider-request-audit-facts"
import { loadProviderRequestAuditFromEvents } from "../../../../src/orchestration/session/provider-request-audit-projection"

function storedFact(fact: ProviderRequestAuditFact, position = 1): StoredFact {
  return {
    id: `event-${position}`,
    aggregateId: "session:test",
    sessionId: "test",
    seq: position,
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    timestamp: position,
    payload: fact.payload,
    position,
  }
}

function historicalPrompt(requestId: string, turn: number, treeBacked: boolean): ProviderRequestAuditFact {
  return {
    type: "prompt.assembled",
    version: 2,
    actor: "flywheel",
    payload: {
      requestId,
      conversationId: treeBacked ? "conv-1" : "provider-subagent-1",
      turn,
      promptKind: treeBacked ? "chat" : "subagent",
      systemPromptHash: "sys",
      toolSurfaceHash: "tools",
      promptSha256: "a".repeat(64),
      messageCount: turn,
      estimatedContextTokens: 10,
      contextWindow: 200_000,
      ...(treeBacked ? { treePointer: { conversationId: "conv-1", leafEntryId: `leaf-${turn}` } } : {}),
    },
  }
}

function historicalRequest(requestId: string, turn: number, cacheKey: string): ProviderRequestAuditFact {
  return {
    type: "model.requested",
    version: 2,
    actor: "flywheel",
    payload: {
      requestId,
      conversationId: "conv-1",
      turn,
      model: "test-model",
      accessProvider: "test-provider",
      modelFamily: "test-family",
      interactionProfileId: "default",
      cacheKey,
    },
  }
}

describe("provider request audit identity", () => {
  test("preserves a historical tree-less runner id as provider-session identity", () => {
    const [entry] = loadProviderRequestAuditFromEvents([storedFact(historicalPrompt("req-subagent", 1, false))])

    expect(entry?.identity).toEqual({ providerSessionKey: "provider-subagent-1" })
    expect(entry?.prompt?.treePointer).toBeUndefined()
  })

  test("uses historical cache keys to separate provider sessions within one conversation", () => {
    const facts = [
      historicalPrompt("req-1", 1, true),
      historicalRequest("req-1", 1, "provider-1"),
      historicalPrompt("req-2", 2, true),
      historicalRequest("req-2", 2, "provider-2"),
    ]
    const entries = loadProviderRequestAuditFromEvents(facts.map((fact, index) => storedFact(fact, index + 1)))

    expect(entries.map((entry) => entry.identity)).toEqual([
      { providerSessionKey: "provider-1", conversationId: "conv-1" },
      { providerSessionKey: "provider-2", conversationId: "conv-1" },
    ])
  })

  test("reads a request that a build of 2026-08-31 recorded without its provider session key", () => {
    const identity = { conversationId: "conv-1" }
    const toolSurfaceHash = hashToolSurface([], [])
    const stored = [
      { type: "prompt.assembled", version: 4, actor: "flywheel", payload: {
        requestId: "req-1", identity, turn: 1, promptKind: "chat", systemPromptHash: hashSystemPrompt("system"), systemPrompt: "system",
        toolSurfaceHash, promptSha256: "c".repeat(64), messageCount: 1,
        estimatedContextTokens: 10, attemptStaticTokens: 1, contextWindow: 200_000, treeLeafEntryId: "leaf-1",
      } },
      { type: "tool_surface.selected", version: 4, actor: "flywheel", payload: { requestId: "req-1", identity, turn: 1, toolSurfaceHash, tools: [], omittedTools: [] } },
      { type: "model.requested", version: 5, actor: "flywheel", payload: {
        requestId: "req-1", identity, turn: 1, model: "test-model", accessProvider: "test-provider",
        modelFamily: "test-family", interactionProfileId: "default", cacheKey: "provider-1",
      } },
      { type: "model.request.dispatched", version: 2, actor: "provider", payload: { requestId: "req-1", identity, turn: 1 } },
    ].map((fact, index): StoredFact => ({
      id: `event-${index + 1}`, aggregateId: "session:test", sessionId: "test", seq: index + 1,
      timestamp: index + 1, position: index + 1, ...fact,
    }))

    const [entry] = loadProviderRequestAuditFromEvents(stored)

    expect(entry?.identity).toEqual({ providerSessionKey: "conv-1", conversationId: "conv-1" })
    expect(entry?.request?.model).toBe("test-model")
  })

  test("rejects current facts that disagree on provider session identity", () => {
    const facts: ProviderRequestAuditFact[] = [
      {
        type: "prompt.assembled",
        version: 4,
        actor: "flywheel",
        payload: {
          requestId: "req-mismatch",
          identity: { providerSessionKey: "provider-a", conversationId: "conv-1" },
          turn: 1,
          promptKind: "chat",
          systemPromptHash: "a".repeat(64),
          toolSurfaceHash: "b".repeat(64),
          promptSha256: "c".repeat(64),
          messageCount: 1,
          estimatedContextTokens: 10,
          attemptStaticTokens: 1,
          contextWindow: 200_000,
          treeLeafEntryId: "leaf-1",
        },
      },
      {
        type: "model.stream.started",
        version: 2,
        actor: "provider",
        payload: {
          requestId: "req-mismatch",
          identity: { providerSessionKey: "provider-b", conversationId: "conv-1" },
          turn: 1,
        },
      },
    ]

    expect(() => loadProviderRequestAuditFromEvents(facts.map((fact, index) => storedFact(fact, index + 1))))
      .toThrow(InvariantViolation)
  })

  test("rejects a current tree leaf without a durable conversation owner", () => {
    const fact: ProviderRequestAuditFact = {
      type: "prompt.assembled",
      version: 4,
      actor: "flywheel",
      payload: {
        requestId: "req-orphan-leaf",
        identity: { providerSessionKey: "provider-1" },
        turn: 1,
        promptKind: "chat",
        systemPromptHash: "a".repeat(64),
        toolSurfaceHash: "b".repeat(64),
        promptSha256: "c".repeat(64),
        messageCount: 1,
        estimatedContextTokens: 10,
        attemptStaticTokens: 1,
        contextWindow: 200_000,
        treeLeafEntryId: "leaf-1",
      },
    }

    expect(() => loadProviderRequestAuditFromEvents([storedFact(fact)]))
      .toThrow(InvariantViolation)
  })
})
