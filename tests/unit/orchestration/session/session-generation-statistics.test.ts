import { expect, spyOn, test } from "bun:test"
import { Log } from "../../../../src/infra/log.js"
import type { EventStoreAppend, StoredFact } from "../../../../src/infra/event-store-types.js"
import { generationStatistics, initialGenerationEvidence, reduceGenerationEvidence } from "../../../../src/orchestration/session/session-generation-statistics.js"
import type { GenerationMeasurement } from "../../../../src/orchestration/session/provider-request-audit-types.js"

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const measured = (durationMs: number, excludedBlocks = 0): GenerationMeasurement => ({
  kind: "recorded", basis: "O200kBase", outputTokens: 100, durationMs, measuredBlocks: 1, excludedBlocks,
})

function fixture() {
  const events: StoredFact[] = []
  /** One session's statistics, folded from the facts of its own aggregate. */
  const read = (sessionId: string) => generationStatistics(events
    .filter((event) => event.aggregateId === `session:${sessionId}`)
    .reduce(reduceGenerationEvidence, initialGenerationEvidence()))
  function append(type: string, version: number, actor: EventStoreAppend["actor"], payload: EventStoreAppend["payload"], sessionId = "own") {
    const position = events.length + 1
    events.push({ aggregateId: `session:${sessionId}`, sessionId, type, version, actor, payload, position, seq: position - 1, id: String(position), timestamp: position })
  }
  function requested(n: number, model = "first", effort?: string, sessionId = "own") {
    append("model.requested", 5, "flywheel", {
      requestId: uuid(n), identity: { providerSessionKey: sessionId }, turn: 1, model,
      accessProvider: "openai", modelFamily: "gpt", interactionProfileId: "default",
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }, sessionId)
  }
  function summary(n: number, generation: GenerationMeasurement, version = 3, sessionId = "own") {
    append("model.stream.summary.recorded", version, "flywheel", {
      requestId: uuid(n), ...(version === 1 ? { conversationId: sessionId } : { identity: { providerSessionKey: sessionId } }),
      turn: 1, rawEventCount: 2, countsBySource: {}, countsByKind: {},
      interDelta: { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
      watchdog: { thinkingStallCount: 0 }, recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 },
      bigGapTransitions: [], ...(version === 3 ? { generation } : {}),
    }, sessionId)
  }
  function usage(n: number) {
    append("model.usage.measured", 5, "provider", {
      attemptId: uuid(n), occurredAt: "2025-01-01T00:00:00.000Z", profileId: "profile",
      attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: uuid(100), model: "later-setting",
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      classification: "real_spend", price: { kind: "unavailable", reason: "No rate" }, currency: "USD", budgetStreamId: "runner",
    })
  }
  return { events, read, append, requested, summary, usage }
}

test("own statistics pool unequal durations and preserve request effort", () => {
  const f = fixture()
  f.requested(1, "first", "medium")
  f.summary(1, measured(1000))
  f.usage(1)
  f.requested(2, "first", "medium")
  f.summary(2, measured(9000))
  f.requested(3, "first", "high")
  f.summary(3, measured(2000))
  f.requested(4, "second")
  f.summary(4, measured(5000))
  f.requested(5, "foreign", "medium", "child")
  f.summary(5, measured(1), 3, "child")
  const first = f.read("own")
  expect(first.models).toMatchObject([
    { model: "first", reasoningEffort: "high", measuredRequests: 1, averageTokensPerSecond: 50 },
    { model: "first", reasoningEffort: "medium", measuredRequests: 2, averageTokensPerSecond: 20 },
    { model: "second", reasoningEffort: null, measuredRequests: 1, averageTokensPerSecond: 20 },
  ])
  expect(first.totals).toMatchObject({ outputTokens: 400, durationMs: 17000, measuredRequests: 4, unmeasuredRequests: 0 })
  expect(f.read("empty")).toMatchObject({ totals: { averageTokensPerSecond: null }, coverageComplete: true })
  f.requested(6, "first", "medium")
  f.summary(6, measured(1000))
  const next = f.read("own")
  expect(next.models[1]).toMatchObject({ outputTokens: 300, durationMs: 11000, measuredRequests: 3, averageTokensPerSecond: 300000 / 11000 })
  expect(first.models[1]).toMatchObject({ outputTokens: 200, durationMs: 10000, measuredRequests: 2, averageTokensPerSecond: 20 })
})

test("settled usage without a summary reports missing coverage once; attribution-only in-flight requests do not", () => {
  const f = fixture()
  f.requested(1, "first", "medium")
  f.summary(1, measured(1000, 1))
  f.usage(1)
  f.usage(1)
  f.requested(2, "second", "high")
  f.usage(2)
  f.usage(2)
  f.requested(3, "in-flight")
  expect(f.read("own")).toMatchObject({
    coverageComplete: false,
    totals: { outputTokens: 100, durationMs: 1000, averageTokensPerSecond: 100, measuredRequests: 1, unmeasuredRequests: 1, excludedBlocks: 1 },
    models: [{ model: "first", reasoningEffort: "medium" }, { model: "second", reasoningEffort: "high", unmeasuredRequests: 1, averageTokensPerSecond: null }],
  })
  f.summary(2, measured(9000))
  expect((f.read("own")).totals).toMatchObject({ averageTokensPerSecond: 20, measuredRequests: 2, unmeasuredRequests: 0 })
})

test("historical and zero-duration requests keep measured speed and honest unavailable coverage without backfill", () => {
  const f = fixture()
  f.requested(1)
  f.summary(1, measured(1000))
  for (const version of [1, 2]) {
    f.requested(version + 1)
    f.summary(version + 1, { kind: "unavailable", reason: "historical" }, version)
  }
  f.requested(4)
  f.summary(4, { kind: "recorded", basis: "O200kBase", outputTokens: 0, durationMs: 0, measuredBlocks: 0, excludedBlocks: 2 })
  const before = JSON.stringify(f.events)
  expect(f.read("own")).toMatchObject({
    coverageComplete: false,
    totals: { averageTokensPerSecond: 100, measuredRequests: 1, unmeasuredRequests: 3, excludedBlocks: 2 },
  })
  expect(JSON.stringify(f.events)).toBe(before)
  f.summary(5, { kind: "unavailable", reason: "historical" }, 1, "summary-only")
  expect(f.read("summary-only")).toMatchObject({
    coverageComplete: false, models: [], totals: { averageTokensPerSecond: null, unmeasuredRequests: 1 },
  })
  f.append("model.usage.measured", 4, "provider", {
    usageEntryId: "legacy", costUsdDelta: 3, billedCostUsdDelta: 1, inputTokensDelta: 5,
    outputTokensDelta: 2, cacheReadTokensDelta: 1, cacheCreateTokensDelta: 2, reasoningTokensDelta: 1, budgetStreamId: "runner",
  }, "legacy")
  expect(f.read("legacy")).toMatchObject({ coverageComplete: false, totals: { averageTokensPerSecond: null, measuredRequests: 0, unmeasuredRequests: 0 } })
  // A newer build's usage fact names nothing this build can read: coverage is incomplete and a warning says why.
  const warn = spyOn(Log.create({ service: "durable-usage" }), "warn").mockImplementation(() => {})
  try {
    f.append("model.usage.measured", 98, "provider", { attemptId: uuid(9) }, "newer")
    expect(f.read("newer")).toMatchObject({ coverageComplete: false, totals: { measuredRequests: 0, unmeasuredRequests: 0 } })
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual([{ version: 98, sessionId: "newer" }])
  } finally {
    warn.mockRestore()
  }
})

test("single-chunk-only and preparation-unavailable requests have no fabricated speed", () => {
  const f = fixture()
  f.requested(1)
  f.summary(1, { kind: "recorded", basis: "O200kBase", outputTokens: 0, durationMs: 0, measuredBlocks: 0, excludedBlocks: 1 })
  f.requested(2)
  f.summary(2, { kind: "unavailable", reason: "tokenizer-preparation-failed" })
  expect(f.read("own")).toMatchObject({ coverageComplete: false, totals: { outputTokens: 0, durationMs: 0, averageTokensPerSecond: null, unmeasuredRequests: 2, excludedBlocks: 1 } })
})

test("a request that a build of 2026-08-31 recorded without its provider session key reads with its attribution", () => {
  const f = fixture()
  const identity = { conversationId: "conversation" }
  f.append("model.requested", 5, "flywheel", {
    requestId: uuid(1), identity, turn: 1, model: "first", accessProvider: "openai", modelFamily: "gpt",
    interactionProfileId: "default", reasoningEffort: "medium", cacheRetention: "short", cacheKey: "cache",
  })
  f.append("model.stream.summary.recorded", 2, "flywheel", {
    requestId: uuid(1), identity, turn: 1, rawEventCount: 2, countsBySource: {}, countsByKind: {},
    interDelta: { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
    watchdog: { thinkingStallCount: 0 }, recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 }, bigGapTransitions: [],
  })
  const before = JSON.stringify(f.events)

  expect(f.read("own")).toMatchObject({
    coverageComplete: false,
    models: [{ model: "first", reasoningEffort: "medium", unmeasuredRequests: 1 }],
  })
  expect(JSON.stringify(f.events)).toBe(before)
})
