import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InvariantViolation } from "../../../../src/infra/invariant"
import type { EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { analyzeStreamGaps } from "../../../../src/orchestration/session/diagnostics/provider-stream-gaps"

let tmpDir: string
let store: EventStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "flywheel-stream-gaps-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function appendStreamEvent(overrides: {
  sequence: number
  source: string
  kind: string
  elapsedMs: number
  sincePreviousMs?: number
  requestId?: string
}): void {
  store.append({
    aggregateId: "session:gaps-raw",
    type: "model.stream.event_observed",
    version: 1,
    timestamp: 1_000 + overrides.sequence,
    actor: "provider",
    sessionId: "gaps-raw",
    payload: {
      requestId: overrides.requestId ?? "req-raw",
      conversationId: "conv-raw",
      turn: 1,
      sequence: overrides.sequence,
      source: overrides.source,
      kind: overrides.kind,
      elapsedMs: overrides.elapsedMs,
      sincePreviousMs: overrides.sincePreviousMs ?? 0,
      metadata: {},
    },
  })
}

describe("stream gap analysis", () => {
  test("folds raw stream telemetry into warmup, inter-delta, and watchdog stats", () => {
    // message_start tags the provider; two visible deltas drive warmup and a
    // single inter-delta gap; a watchdog fact contributes a stall sample.
    appendStreamEvent({ sequence: 1, source: "provider", kind: "message_start", elapsedMs: 0 })
    appendStreamEvent({ sequence: 2, source: "normalized", kind: "text_delta", elapsedMs: 300 })
    appendStreamEvent({ sequence: 3, source: "normalized", kind: "text_delta", elapsedMs: 6_300 })
    appendStreamEvent({ sequence: 4, source: "watchdog", kind: "thinking_stall", elapsedMs: 9_000, sincePreviousMs: 9_000 })

    const report = analyzeStreamGaps({ baseDir: tmpDir })

    expect(report.requests).toBe(1)
    expect(report.rawRequests).toBe(1)
    expect(report.summarizedRequests).toBe(0)
    expect(report.warmup).toMatchObject({ count: 1, p50: 300 })
    expect(report.warmupByProvider[0]?.provider).toBe("anthropic")
    // 6300 - 300 = 6000ms gap between the two visible text deltas (>= 5s -> ge5s).
    expect(report.interDelta).toMatchObject({ count: 1, mean: 6_000, ge5s: 1 })
    expect(report.bigGapTransitions).toEqual([{ transition: "text_delta->text_delta", count: 1 }])
    expect(report.watchdogStalls).toMatchObject({ count: 1, max: 9_000 })
  })

  test("counts only the requests that the request and time filters select", () => {
    appendStreamEvent({ requestId: "req-a", sequence: 1, source: "normalized", kind: "text_delta", elapsedMs: 300 })
    appendStreamEvent({ requestId: "req-b", sequence: 11, source: "normalized", kind: "text_delta", elapsedMs: 700 })

    expect(analyzeStreamGaps({ baseDir: tmpDir }).requests).toBe(2)
    expect(analyzeStreamGaps({ baseDir: tmpDir, requestId: "req-a" })).toMatchObject({ requests: 1, warmup: { count: 1, p50: 300 } })
    expect(analyzeStreamGaps({ baseDir: tmpDir, sinceTimestamp: 1_010 })).toMatchObject({ requests: 1, warmup: { count: 1, p50: 700 } })
    expect(analyzeStreamGaps({ baseDir: tmpDir, untilTimestamp: 1_010 })).toMatchObject({ requests: 1, warmup: { count: 1, p50: 300 } })
  })

  test.each([1, 2, 3])("folds v%i summary-only stream diagnostics", (version) => {
    store.append({
      aggregateId: "session:gaps-summary",
      type: "model.stream.summary.recorded",
      version,
      timestamp: 1_000,
      actor: "flywheel",
      sessionId: "gaps-summary",
      payload: {
        requestId: "req-1",
        ...(version === 1 ? { conversationId: "conv-1" } : { identity: { providerSessionKey: "conv-1" } }),
        ...(version === 3 ? { generation: { kind: "recorded", basis: "O200kBase", outputTokens: 10, durationMs: 200, measuredBlocks: 1, excludedBlocks: 0 } } : {}),
        turn: 1,
        rawEventCount: 12,
        countsBySource: { provider: 2, normalized: 10 },
        countsByKind: { message_start: 1, thinking_delta: 1, text_delta: 1 },
        firstVisibleDeltaMs: 250,
        interDelta: { count: 2, meanMs: 3_000, p50Ms: 1_000, p90Ms: 5_000, p99Ms: 5_000, maxMs: 5_000, ge1s: 2, ge2s: 1, ge5s: 1, ge10s: 0 },
        watchdog: { thinkingStallCount: 1, maxStallMs: 12_000 },
        recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 },
        bigGapTransitions: [{ transition: "thinking_delta->text_delta", count: 1 }],
      },
    })

    const report = analyzeStreamGaps({ baseDir: tmpDir })

    expect(report.requests).toBe(1)
    expect(report.rawRequests).toBe(0)
    expect(report.summarizedRequests).toBe(1)
    expect(report.warmup).toMatchObject({ count: 1, p50: 250 })
    expect(report.warmupByProvider[0]?.provider).toBe("anthropic")
    expect(report.interDelta).toMatchObject({ count: 2, mean: 3_000, p90: 5_000, ge5s: 1 })
    expect(report.watchdogStalls).toMatchObject({ count: 1, max: 12_000 })
    expect(report.bigGapTransitions).toEqual([{ transition: "thinking_delta->text_delta", count: 1 }])
  })

  test("folds a summary that a build of 2026-08-31 recorded without its provider session key", () => {
    store.append({
      aggregateId: "session:gaps-historical",
      type: "model.stream.summary.recorded",
      version: 2,
      timestamp: 1_000,
      actor: "flywheel",
      sessionId: "gaps-historical",
      payload: {
        requestId: "req-historical",
        identity: { conversationId: "conv-historical" },
        turn: 1,
        rawEventCount: 4,
        countsBySource: { provider: 1, normalized: 3 },
        countsByKind: { message_start: 1, text_delta: 2 },
        firstVisibleDeltaMs: 400,
        interDelta: { count: 1, meanMs: 600, p50Ms: 600, p90Ms: 600, p99Ms: 600, maxMs: 600, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
        watchdog: { thinkingStallCount: 0, maxStallMs: 0 },
        recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 },
        bigGapTransitions: [],
      },
    })

    const report = analyzeStreamGaps({ baseDir: tmpDir })

    expect(report.requests).toBe(1)
    expect(report.summarizedRequests).toBe(1)
    expect(report.warmup).toMatchObject({ count: 1, p50: 400 })
  })

  test("throws on a malformed stream fact instead of silently skipping it", () => {
    // sequence below the schema minimum (1) is a writer-invariant violation;
    // the parse-once boundary must surface it, not drop the row.
    store.append({
      aggregateId: "session:gaps-bad",
      type: "model.stream.event_observed",
      version: 1,
      timestamp: 1_000,
      actor: "provider",
      sessionId: "gaps-bad",
      payload: {
        requestId: "req-bad",
        conversationId: "conv-bad",
        turn: 1,
        sequence: 0,
        source: "normalized",
        kind: "text_delta",
        elapsedMs: 10,
        sincePreviousMs: 0,
        metadata: {},
      },
    })

    expect(() => analyzeStreamGaps({ baseDir: tmpDir })).toThrow(InvariantViolation)
  })
})
