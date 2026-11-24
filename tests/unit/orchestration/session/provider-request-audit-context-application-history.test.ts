import { describe, expect, test } from "bun:test"
import { InvariantViolation } from "../../../../src/infra/invariant"
import type { ProviderRequestAuditFact } from "../../../../src/orchestration/session/runtime-facts/provider-request-audit-facts"
import { hashSystemPrompt, hashToolSurface } from "../../../../src/orchestration/session/diagnostics/provider-request-audit-hash"
import { loadProviderRequestAuditFromEvents } from "../../../../src/orchestration/session/diagnostics/provider-request-audit-projection"

describe("provider-request-audit projection of retained context applications", () => {
  // Builds before 2026-11-16 wrote one empty context.application.recorded
  // manifest with a fresh contextApplicationId per provider request. The
  // current build writes none, and that retained history still folds.
  test("A stored history whose requests each carry an empty manifest (the shape that builds before this change wrote) folds and verifies unchanged", () => {
    const facts: ProviderRequestAuditFact[] = []
    for (const turn of [1, 2, 3]) {
      const requestId = `req-${turn}`
      const contextApplicationId = `00000000-0000-4000-8000-00000000000${turn}`
      facts.push(promptV5Fact(requestId, turn, contextApplicationId))
      if (turn === 1) facts.push(toolSurfaceV5Fact(requestId))
      facts.push(manifestV2Fact(requestId, turn, contextApplicationId, 0, EMPTY_SEQUENCE_DIGEST))
    }

    const entries = loadProviderRequestAuditFromEvents(facts.map((fact, index) => storedFact(fact, index + 1)))

    expect(entries.map((entry) => [entry.requestId, entry.prompt?.contextApplicationId, entry.contextApplications])).toEqual([
      ["req-1", "00000000-0000-4000-8000-000000000001", []],
      ["req-2", "00000000-0000-4000-8000-000000000002", []],
      ["req-3", "00000000-0000-4000-8000-000000000003", []],
    ])
    expect(entries.every((entry) => entry.toolSurface === entries[0]?.toolSurface)).toBe(true)
  })

  test("A stored history with a context.application.recorded fact and context.transformer.applied facts folds and verifies unchanged", () => {
    const application = {
      applicationId: "application-1", transformerId: "transformer-1", seam: "modelContext", order: 10,
      outcome: "applied" as const, inputHash: "a".repeat(64), outputHash: "b".repeat(64),
    }
    const facts: ProviderRequestAuditFact[] = [
      promptV5Fact("req-1", 1, "context-application-1"),
      toolSurfaceV5Fact("req-1"),
      manifestV2Fact("req-1", 1, "context-application-1", 1, "023e0c821760da4b2205b17589ead324dc74939f8a8470adf68c2db10919f271"),
      {
        type: "context.transformer.applied", version: 2, actor: "flywheel",
        payload: { requestId: "req-1", identity: V5_IDENTITY, turn: 1, contextApplicationId: "context-application-1", ...application },
      },
      promptV5Fact("req-2", 2, "context-application-1"),
    ]

    const entries = loadProviderRequestAuditFromEvents(facts.map((fact, index) => storedFact(fact, index + 1)))

    expect(entries.map((entry) => entry.contextApplications)).toEqual([[application], [application]])
    // A digest that does not match the recorded applications still fails verification.
    const tampered = facts.map((fact) => fact.type === "context.application.recorded"
      ? manifestV2Fact("req-1", 1, "context-application-1", 1, EMPTY_SEQUENCE_DIGEST)
      : fact)
    expect(() => loadProviderRequestAuditFromEvents(tampered.map((fact, index) => storedFact(fact, index + 1)))).toThrow(InvariantViolation)
  })
})

function storedFact(fact: ProviderRequestAuditFact, position: number): Parameters<typeof loadProviderRequestAuditFromEvents>[0][number] {
  return {
    id: `event-${position}`, aggregateId: "session:test", sessionId: "test", seq: position,
    type: fact.type, version: fact.version, actor: fact.actor, timestamp: position, payload: fact.payload, position,
  }
}

const V5_IDENTITY = { providerSessionKey: "provider-1", conversationId: "conv-1" }
/** sha256 of the JSON of an empty transformer sequence. */
const EMPTY_SEQUENCE_DIGEST = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"

function promptV5Fact(requestId: string, turn: number, contextApplicationId: string): ProviderRequestAuditFact {
  return {
    type: "prompt.assembled", version: 5, actor: "flywheel",
    payload: {
      requestId, identity: V5_IDENTITY, turn, promptKind: "chat",
      systemPromptHash: hashSystemPrompt("system"), ...(turn === 1 ? { systemPrompt: "system" } : {}),
      toolSurfaceHash: hashToolSurface([], []), promptSha256: "c".repeat(64), messageCount: turn,
      estimatedContextTokens: 100, attemptStaticTokens: 10, contextWindow: 200_000, contextApplicationId,
    },
  }
}

function toolSurfaceV5Fact(requestId: string): ProviderRequestAuditFact {
  return {
    type: "tool_surface.selected", version: 5, actor: "flywheel",
    payload: { requestId, identity: V5_IDENTITY, turn: 1, toolSurfaceHash: hashToolSurface([], []), tools: [], omittedTools: [] },
  }
}

function manifestV2Fact(requestId: string, turn: number, contextApplicationId: string, applicationCount: number, sequenceDigest: string): ProviderRequestAuditFact {
  return {
    type: "context.application.recorded", version: 2, actor: "flywheel",
    payload: { requestId, identity: V5_IDENTITY, turn, contextApplicationId, applicationCount, sequenceDigest },
  }
}
