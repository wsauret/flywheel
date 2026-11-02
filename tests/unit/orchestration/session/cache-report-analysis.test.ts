import { describe, expect, test } from "bun:test"
import { buildTurnReport } from "../../../../src/orchestration/session/diagnostics/cache-report-analysis.js"
import type { ProviderRequestAuditEntry } from "../../../../src/orchestration/session/provider-request-audit-types.js"

function entry(overrides: {
  turn: number
  requestId: string
  promptTokens: number
  cacheReadInputTokens: number
  requestedAt?: number
  conversationId?: string
  providerSessionKey?: string
  messageCount?: number
  systemPromptHash?: string
  toolSurfaceHash?: string
  model?: string
  accessProvider?: string
  reasoningEffort?: string
  respondedAt?: number
  cacheRetention?: string
  maskCutoffIndex?: number
}): ProviderRequestAuditEntry {
  return {
    requestId: overrides.requestId,
    identity: {
      providerSessionKey: overrides.providerSessionKey ?? "provider-1",
      conversationId: overrides.conversationId ?? "conv-1",
    },
    turn: overrides.turn,
    requestedAt: overrides.requestedAt ?? overrides.turn,
    ...(overrides.respondedAt === undefined ? {} : { respondedAt: overrides.respondedAt }),
    prompt: {
      promptKind: "chat",
      messageCount: overrides.messageCount ?? overrides.turn,
      estimatedContextTokens: overrides.promptTokens,
      contextWindow: 200_000,
      promptSha256: `prompt-sha-${overrides.requestId}`,
      systemPromptHash: overrides.systemPromptHash ?? "sys-hash-stable",
      toolSurfaceHash: overrides.toolSurfaceHash ?? "tool-hash-stable",
      ...(overrides.maskCutoffIndex === undefined ? {} : {
        staleMasking: { cutoffIndex: overrides.maskCutoffIndex, zone: 1, masksApplied: 1, bytesSaved: 10, maskedToolUseIds: ["t1"] },
      }),
    },
    request: {
      model: overrides.model ?? "claude-opus-4-7",
      accessProvider: overrides.accessProvider ?? "anthropic_api",
      modelFamily: "anthropic",
      reasoningEffort: overrides.reasoningEffort ?? "medium",
      ...(overrides.cacheRetention === undefined ? {} : { cacheRetention: overrides.cacheRetention }),
    },
    usage: {
      coverage: "complete",
      inputTokens: overrides.promptTokens,
      outputTokens: 100,
      cacheReadInputTokens: overrides.cacheReadInputTokens,
      cacheCreationInputTokens: overrides.promptTokens - overrides.cacheReadInputTokens,
      reasoningTokens: 0,
      promptTokens: overrides.promptTokens,
      deltaCostUsd: 0.01,
    },
  }
}

describe("buildTurnReport", () => {
  test("computes hit ratio as cacheReadInputTokens / promptTokens", () => {
    const turns = buildTurnReport([entry({ turn: 1, requestId: "r1", promptTokens: 1000, cacheReadInputTokens: 0 })])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.hitRatio).toBe(0)
    expect(turns[0]!.requestIdentity).toBe("provider-session:provider-1")
  })

  test("skips entries missing prompt, request, or usage (incomplete audit trail)", () => {
    const incomplete: ProviderRequestAuditEntry = {
      requestId: "r1",
      identity: { providerSessionKey: "provider-1", conversationId: "conv-1" },
      turn: 1,
    }
    const turns = buildTurnReport([incomplete])
    expect(turns).toEqual([])
  })

  test("pairs chronologically when the turn counter restarts within a conversation (session resume)", () => {
    // Sorting by turn would clump both turn-1 rows together and pair the
    // resumed run's first request against the original run's first request,
    // fabricating a break. Chronology pairs it against the latest request.
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "run2-r1", requestedAt: 300, promptTokens: 61_000, cacheReadInputTokens: 60_000 }),
      entry({ turn: 1, requestId: "run1-r1", requestedAt: 100, promptTokens: 50_000, cacheReadInputTokens: 0 }),
      entry({ turn: 2, requestId: "run1-r2", requestedAt: 200, promptTokens: 60_000, cacheReadInputTokens: 50_000 }),
    ])
    expect(turns.map((t) => t.requestId)).toEqual(["run1-r1", "run1-r2", "run2-r1"])
    expect(turns.every((t) => t.prefixBreak === undefined)).toBe(true)
  })

  test("starts a new cache stream when one conversation receives a new provider session", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "old", providerSessionKey: "provider-old", promptTokens: 100_000, cacheReadInputTokens: 0 }),
      entry({ turn: 2, requestId: "new", providerSessionKey: "provider-new", promptTokens: 105_000, cacheReadInputTokens: 0 }),
    ])

    expect(turns.map((turn) => turn.requestIdentity)).toEqual([
      "provider-session:provider-old",
      "provider-session:provider-new",
    ])
    expect(turns.every((turn) => turn.prefixBreak === undefined)).toBe(true)
  })

  test("does not flag prompt growth that reads back the whole previous prompt, even when the hit ratio halves", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 20_000, cacheReadInputTokens: 0 }),
      // Ratio falls 0% -> 33%, then to 33% of a tripled prompt: pure growth.
      entry({ turn: 2, requestId: "r2", promptTokens: 60_000, cacheReadInputTokens: 19_997 }),
    ])
    expect(turns[1]!.hitRatio).toBeLessThan(0.34)
    expect(turns[1]!.prefixBreak).toBeUndefined()
  })

  test("pairs requests within their own provider sessions", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "a1", providerSessionKey: "provider-a", conversationId: "conv-a", promptTokens: 10_000, cacheReadInputTokens: 0 }),
      entry({ turn: 1, requestId: "b1", providerSessionKey: "provider-b", conversationId: "conv-b", promptTokens: 18_000, cacheReadInputTokens: 0 }),
      entry({ turn: 2, requestId: "a2", providerSessionKey: "provider-a", conversationId: "conv-a", promptTokens: 11_000, cacheReadInputTokens: 10_000 }),
      entry({ turn: 2, requestId: "b2", providerSessionKey: "provider-b", conversationId: "conv-b", promptTokens: 59_000, cacheReadInputTokens: 17_998 }),
    ])
    expect(turns.every((t) => t.prefixBreak === undefined)).toBe(true)
  })

  test("marks an unexplained break when the read-back falls far short of the previous prompt with identical identity", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 100_000, cacheReadInputTokens: 0, messageCount: 10 }),
      entry({ turn: 2, requestId: "r2", promptTokens: 105_000, cacheReadInputTokens: 40_000, messageCount: 12 }),
    ])
    expect(turns[1]!.prefixBreak).toEqual({
      kind: "unexplained",
      lostTokens: 60_000,
      previousRequestId: "r1",
    })
  })

  test("explains a break caused by a system-prompt change", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 50_000, cacheReadInputTokens: 0 }),
      entry({ turn: 2, requestId: "r2", promptTokens: 52_000, cacheReadInputTokens: 0, systemPromptHash: "sys-hash-changed" }),
    ])
    expect(turns[1]!.prefixBreak).toMatchObject({ kind: "explained", cause: "system-prompt-changed" })
  })

  test("explains a break caused by a tool-surface change", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 50_000, cacheReadInputTokens: 0 }),
      entry({ turn: 2, requestId: "r2", promptTokens: 52_000, cacheReadInputTokens: 5_000, toolSurfaceHash: "tool-hash-changed" }),
    ])
    expect(turns[1]!.prefixBreak).toMatchObject({ kind: "explained", cause: "tool-surface-changed" })
  })

  test("explains a break caused by a model switch", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 50_000, cacheReadInputTokens: 0 }),
      entry({ turn: 2, requestId: "r2", promptTokens: 52_000, cacheReadInputTokens: 0, model: "claude-haiku-4-7" }),
    ])
    expect(turns[1]!.prefixBreak).toMatchObject({ kind: "explained", cause: "model-changed" })
  })

  test("explains a break caused by an access-provider switch under the same model name", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 50_000, cacheReadInputTokens: 0 }),
      entry({ turn: 2, requestId: "r2", promptTokens: 52_000, cacheReadInputTokens: 0, accessProvider: "bedrock_api" }),
    ])
    expect(turns[1]!.prefixBreak).toMatchObject({ kind: "explained", cause: "model-changed" })
  })

  test("explains a break caused by a reasoning-effort change", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 50_000, cacheReadInputTokens: 0, reasoningEffort: "low" }),
      entry({ turn: 2, requestId: "r2", promptTokens: 52_000, cacheReadInputTokens: 0, reasoningEffort: "medium" }),
    ])
    expect(turns[1]!.prefixBreak).toMatchObject({ kind: "explained", cause: "reasoning-changed" })
  })

  test("explains a break as compaction when the message count shrank", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 186_000, cacheReadInputTokens: 0, messageCount: 293 }),
      entry({ turn: 2, requestId: "r2", promptTokens: 79_000, cacheReadInputTokens: 55_000, messageCount: 31 }),
    ])
    expect(turns[1]!.prefixBreak).toEqual({
      kind: "explained",
      cause: "compaction",
      lostTokens: 131_000,
      previousRequestId: "r1",
    })
  })

  test("explains a break as a stale-mask advance when only the masking cutoff moved", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 100_000, cacheReadInputTokens: 0, messageCount: 10, maskCutoffIndex: 2 }),
      entry({ turn: 2, requestId: "r2", promptTokens: 101_000, cacheReadInputTokens: 30_000, messageCount: 12, maskCutoffIndex: 6 }),
    ])
    expect(turns[1]!.prefixBreak).toEqual({ kind: "explained", cause: "stale-mask-advanced", lostTokens: 70_000, previousRequestId: "r1" })
  })

  test("explains a break after a 10-minute idle gap with the idle time and the requested retention", () => {
    const turns = buildTurnReport([
      entry({ turn: 1, requestId: "r1", promptTokens: 100_000, cacheReadInputTokens: 0, messageCount: 10, requestedAt: 0, respondedAt: 20_000, cacheRetention: "1h" }),
      entry({ turn: 2, requestId: "r2", promptTokens: 101_000, cacheReadInputTokens: 0, messageCount: 12, requestedAt: 620_000 }),
    ])
    expect(turns[1]!.prefixBreak).toEqual({
      kind: "explained", cause: "idle-gap", idleMs: 600_000, requestedRetention: "1h", lostTokens: 100_000, previousRequestId: "r1",
    })
  })
})
