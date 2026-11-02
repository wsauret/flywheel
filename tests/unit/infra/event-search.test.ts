import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store"
import { formatEventSearchMatch } from "../../../src/cli/event-search-format"
import {
  listEventTypes,
  rowTimestamp,
  rowType,
  searchEvents,
  type EventSearchRow,
} from "../../../src/infra/event-search"
import { resolveDebugLogDirectory } from "../../../src/infra/debug-log"
import * as debugLog from "../../../src/infra/debug-log"
import { resolveEventStoreDbFile } from "../../../src/infra/paths"

describe("event search", () => {
  let tmpDir: string | null = null

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  })

  it("does not decode an irrelevant malformed stored row before the type filter", () => {
    const baseDir = tempWorkspace()
    const dbPath = resolveEventStoreDbFile(baseDir)
    const store = createSqliteEventStore(dbPath)
    store.append({
      aggregateId: "target", type: "target.note", version: 1,
      timestamp: 1, actor: "test", sessionId: "target", payload: {},
    })
    store.append({
      aggregateId: "other", type: "tool.input.completed", version: 1,
      timestamp: 2, actor: "test", sessionId: "other", payload: {},
    })
    store.close()
    const db = new Database(dbPath)
    db.run("update event set payload = 'malformed' where position = 2")
    db.close()

    expect(searchEvents({ baseDir, typePatterns: ["target.note"], limit: 1 }).matches.map(rowType))
      .toEqual(["target.note"])
    expect(() => searchEvents({ baseDir, typePatterns: ["tool.input.completed"], limit: 1 }))
      .toThrow("corrupt event row")
  })

  it.each(["asc", "desc"] as const)("retains at most the requested top rows while scanning unordered logs in %s order", (order) => {
    const baseDir = tempWorkspace()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, "session")
    store.close()
    let scanned = 0
    let largestSort = 0
    const originalSort = Array.prototype.sort
    const logScan = spyOn(debugLog, "scanDebugLogFiles").mockImplementation(function* () {
      for (let i = 10_000; i > 0; i--) {
        scanned += 1
        yield { ts: i, type: "log.info" }
      }
    })
    const sort = spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare) {
      largestSort = Math.max(largestSort, this.length)
      return originalSort.call(this, compare)
    })
    try {
      const matches = searchEvents({ baseDir, order, limit: 3 }).matches
      expect(matches.map(rowTimestamp)).toEqual(order === "asc" ? [1, 2, 3] : [10_000, 9999, 9998])
      expect(scanned).toBe(10_000)
      expect(largestSort).toBe(3)
    } finally {
      logScan.mockRestore()
      sort.mockRestore()
    }
  })

  it("preserves timestamp ties, store precedence, and log file order for limited and unlimited merges", () => {
    const baseDir = tempWorkspace()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    for (const ts of [3000, 3000, 5000, 1000]) appendModelResponse(store, "session", ts, "ok")
    store.close()
    writeDebugLog(baseDir, [
      { ts: 3000, type: "log.a" }, { ts: 1000, type: "log.early" },
      { ts: 3000, type: "log.b" }, { ts: 5000, type: "log.late" },
    ])
    fs.writeFileSync(path.join(resolveDebugLogDirectory(baseDir), "2026-02.jsonl"), '{"ts":3000,"type":"log.c"}')
    const label = (row: EventSearchRow) => row.source === "store" ? `s${row.fact.position}` : row.record.type
    for (const order of ["asc", "desc"] as const) {
      const all = searchEvents({ baseDir, order, limit: 0 }).matches
      expect(all.map(label)).toEqual(order === "asc"
        ? ["s4", "log.early", "s1", "s2", "log.a", "log.b", "log.c", "s3", "log.late"]
        : ["s3", "log.late", "s2", "s1", "log.a", "log.b", "log.c", "s4", "log.early"])
      for (const limit of [1, 3, 5, 20]) {
        expect(searchEvents({ baseDir, order, limit }).matches).toEqual(all.slice(0, limit))
      }
    }
  })

  it("uses logarithmic comparator work and one final sort for ascending logs searched latest-first", () => {
    const baseDir = tempWorkspace()
    const count = 8192
    const limit = 256
    let timestampReads = 0
    let resultSorts = 0
    const originalSort = Array.prototype.sort
    const record = (timestamp: number) => ({
      get ts() { timestampReads += 1; return timestamp },
      type: `log.${timestamp}`,
    })
    const logScan = spyOn(debugLog, "scanDebugLogFiles").mockImplementation(function* () {
      for (let i = 0; i < count; i++) yield record(i)
    })
    const sort = spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare) {
      if (this.length === limit) resultSorts += 1
      return originalSort.call(this, compare)
    })
    try {
      const matches = searchEvents({ baseDir, order: "desc", limit }).matches
      expect(timestampReads).toBeLessThan(count * (4 * Math.ceil(Math.log2(limit)) + 8))
      expect(resultSorts).toBe(1)
      expect(matches.map(rowType)).toEqual(Array.from({ length: limit }, (_, i) => `log.${count - i - 1}`))
    } finally {
      logScan.mockRestore()
      sort.mockRestore()
    }
  })

  it.each(["asc", "desc"] as const)("keeps log arrival ties stable through heap replacements in %s order", (order) => {
    const baseDir = tempWorkspace()
    const logScan = spyOn(debugLog, "scanDebugLogFiles").mockImplementation(function* () {
      for (let i = 0; i < 600; i++) yield { ts: i % 7, type: `log.${i}` }
    })
    try {
      const all = searchEvents({ baseDir, order, limit: 0 }).matches
      for (const limit of [1, 80, 256]) expect(searchEvents({ baseDir, order, limit }).matches).toEqual(all.slice(0, limit))
      expect(all.filter((row) => rowTimestamp(row) === 3).map(rowType))
        .toEqual(Array.from({ length: 86 }, (_, i) => `log.${3 + i * 7}`))
    } finally {
      logScan.mockRestore()
    }
  })

  it("preserves stable-sort equality for overflowing numeric log timestamps", () => {
    const baseDir = tempWorkspace()
    const logDir = resolveDebugLogDirectory(baseDir)
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, "overflow.jsonl"), '{"ts":1e999,"type":"log.first"}\n{"ts":1e999,"type":"log.second"}')
    for (const order of ["asc", "desc"] as const) {
      const all = searchEvents({ baseDir, order, limit: 0 }).matches
      expect(all.map(rowType)).toEqual(["log.first", "log.second"])
      expect(searchEvents({ baseDir, order, limit: 1 }).matches).toEqual(all.slice(0, 1))
    }
  })

  it("keeps the full around envelope before type filtering or limiting and preserves missing-anchor rules", () => {
    const baseDir = tempWorkspace()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, "session")
    appendOutputSnapshot(store, "session", "snapshot")
    store.close()
    writeDebugLog(baseDir, [
      { ts: 4000, type: "log.info" }, { ts: 4001, type: "log.info" },
      { ts: 4500, type: "log.info" }, { ts: 6000, type: "log.info" },
    ])
    const query = { baseDir, aroundPosition: 2, aroundRadius: 1, typePatterns: ["log.info"], order: "desc" as const }
    const all = searchEvents({ ...query, limit: 0 }).matches
    expect(all.map(rowTimestamp)).toEqual([4500, 4001, 4000])
    expect(searchEvents({ ...query, limit: 1 }).matches).toEqual(all.slice(0, 1))
    expect(searchEvents({ ...query, aroundPosition: 99, limit: 0 }).matches).toEqual([])
    expect(searchEvents({ baseDir, afterPosition: 2, typePatterns: ["log.info"], limit: 0 }).matches.map(rowTimestamp))
      .toEqual([4001, 4500, 6000])
    expect(searchEvents({ baseDir, afterPosition: 99, limit: 0 }).matches.map(rowTimestamp))
      .toEqual([4000, 4001, 4500, 6000])
  })

  it("filters by event type pattern and failure-shaped payloads", () => {
    const baseDir = tempWorkspace()
    const sessionId = "response-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, sessionId)
    store.close()

    const result = searchEvents({
      baseDir,
      sessionId,
      typePatterns: ["model.response"],
      errorsOnly: true,
    })

    expect(outcomes(result.matches)).toEqual(["fatal_error"])
    expect(formatEventSearchMatch(result.matches[0]!)).toContain("error=ProviderError:bad request")
  })

  it("summarizes what a transport added to a request, and names what it sent by itself and what it did not state", () => {
    const baseDir = tempWorkspace()
    const sessionId = "transport-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    store.append({
      aggregateId: `provider_request_audit:${sessionId}`, type: "model.response_received", version: 3, timestamp: 3000, actor: "provider", sessionId,
      payload: {
        requestId: "req-engine", identity: { providerSessionKey: "p" }, turn: 1, outcome: "ok", durationMs: 5,
        transportContext: {
          identity: "claude-engine",
          additions: [{ part: "system", kind: "billing", at: 0 }, { part: "message", kind: "reminder:environment", at: 2 }, { part: "header", kind: "anthropic-beta", value: "oauth-2025-04-20" }],
          hiddenRequests: [{ source: "message_start", status: 200, inputTokens: 12 }, { source: "retry-line:thinking-signature" }],
          notRecorded: ["cache_control count"],
        },
      },
    })
    store.close()

    const [match] = searchEvents({ baseDir, sessionId, typePatterns: ["model.response"] }).matches
    expect(formatEventSearchMatch(match!)).toContain(
      "added-by=claude-engine added=system:billing@0,message:reminder:environment@2,header:anthropic-beta=oauth-2025-04-20"
      + " hidden=message_start(status=200 in=12),retry-line:thinking-signature(status=not-recorded in=not-recorded) not-recorded=cache_control count",
    )
  })

  it("keeps broad searches focused on source facts instead of derived output snapshots", () => {
    const baseDir = tempWorkspace()
    const sessionId = "snapshot-noise-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, sessionId)
    appendOutputSnapshot(store, sessionId, "bad request")
    store.close()

    const sourceResult = searchEvents({
      baseDir,
      sessionId,
      pattern: "bad request",
      order: "desc",
    })
    const snapshotResult = searchEvents({
      baseDir,
      sessionId,
      pattern: "bad request",
      order: "desc",
      includeSnapshots: true,
    })

    expect(sourceResult.matches.map(rowType)).toEqual(["model.response_received"])
    expect(snapshotResult.matches.map(rowType)).toEqual([
      "output.snapshot.recorded",
      "model.response_received",
    ])
  })

  it("lists event type counts for discovery with their sources", () => {
    const baseDir = tempWorkspace()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, "list-types-session")
    store.close()

    const result = listEventTypes({ baseDir })

    expect(result.storeFound).toBe(true)
    expect(result.types).toEqual([{
      type: "model.response_received",
      sources: ["store"],
      count: 2,
      firstPosition: 1,
      lastPosition: 2,
      firstTimestamp: 3000,
      lastTimestamp: 4000,
    }])
  })

  it("merges the log vocabulary into --list-types and labels shared types", () => {
    const baseDir = tempWorkspace()
    const sessionId = "list-types-merged-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, sessionId)
    store.close()
    writeDebugLog(baseDir, [
      { ts: 3600, sessionId, type: "log.info", payload: { message: "session resumed" } },
      { ts: 6000, sessionId, type: "model.response_received", actor: "provider", payload: { requestId: "req-log" } },
    ])

    const result = listEventTypes({ baseDir })

    expect(result.types).toEqual([
      { type: "log.info", sources: ["log"], count: 1, firstTimestamp: 3600, lastTimestamp: 3600 },
      {
        type: "model.response_received",
        sources: ["store", "log"],
        count: 3,
        firstPosition: 1,
        lastPosition: 2,
        firstTimestamp: 3000,
        lastTimestamp: 6000,
      },
    ])
  })

  it("lists only the types of the requested session from both sources", () => {
    const baseDir = tempWorkspace()
    const sessionId = "list-types-target"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, sessionId)
    store.append({ aggregateId: "other", type: "other.note", version: 1, timestamp: 5000, actor: "test", sessionId: "other", payload: {} })
    store.close()
    writeDebugLog(baseDir, [
      { ts: 3600, sessionId, type: "log.info", payload: { message: "target" } },
      { ts: 3700, sessionId: "other", type: "log.warn", payload: { message: "other" } },
    ])

    expect(listEventTypes({ baseDir, sessionId }).types.map(({ type, sources, count }) => [type, sources, count])).toEqual([
      ["log.info", ["log"], 1],
      ["model.response_received", ["store"], 2],
    ])
  })

  it("interleaves store facts, debug records, and log.<level> records by timestamp", () => {
    const baseDir = tempWorkspace()
    const sessionId = "merged-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, sessionId)
    store.close()
    writeDebugLog(baseDir, [
      { ts: 3500, sessionId, type: "model.stream.event_observed", actor: "provider", payload: streamEventPayload() },
      { ts: 3600, sessionId, type: "log.info", payload: { message: "session resumed" } },
    ])

    const result = searchEvents({ baseDir, sessionId })

    expect(result.matches.map((row) => [row.source, rowType(row)])).toEqual([
      ["store", "model.response_received"],
      ["log", "model.stream.event_observed"],
      ["log", "log.info"],
      ["store", "model.response_received"],
    ])
    expect(result.matches.map(rowTimestamp)).toEqual([3000, 3500, 3600, 4000])
  })

  it("windows both sources by the store window's timestamps for --around", () => {
    const baseDir = tempWorkspace()
    const sessionId = "around-merged-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, sessionId)
    appendOutputSnapshot(store, sessionId, "bad request")
    store.close()
    writeDebugLog(baseDir, [
      { ts: 3500, sessionId, type: "model.stream.event_observed", actor: "provider", payload: streamEventPayload() },
      { ts: 9000, sessionId, type: "log.info", payload: { message: "long after the window" } },
    ])

    const result = searchEvents({
      baseDir,
      sessionId,
      aroundPosition: 2,
      aroundRadius: 1,
      includeSnapshots: true,
    })

    expect(result.matches.map((row) => (row.source === "store" ? row.fact.position : "log"))).toEqual([
      1,
      "log",
      2,
      3,
    ])
    expect(result.matches.map(rowTimestamp)).toEqual([3000, 3500, 4000, 5000])
  })

  it("reaches both sources with --type filters", () => {
    const baseDir = tempWorkspace()
    const sessionId = "typed-merged-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendStreamTelemetry(store, sessionId)
    store.close()
    writeDebugLog(baseDir, [
      { ts: 3700, sessionId, type: "model.stream.event_observed", actor: "provider", payload: streamEventPayload() },
      { ts: 3800, sessionId, type: "log.info", payload: { message: "not a stream fact" } },
    ])

    const result = searchEvents({ baseDir, sessionId, typePatterns: ["model.stream"] })

    expect(result.matches.map((row) => [row.source, rowType(row)])).toEqual([
      ["store", "model.stream.event_observed"],
      ["log", "model.stream.event_observed"],
    ])
  })

  it("surfaces log.error and log.warn records with --errors", () => {
    const baseDir = tempWorkspace()
    const sessionId = "errors-merged-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendModelResponses(store, sessionId)
    store.close()
    writeDebugLog(baseDir, [
      { ts: 4500, sessionId, type: "log.error", payload: { message: "stream sink failed" } },
      { ts: 4600, sessionId, type: "log.warn", payload: { message: "retrying provider call" } },
      { ts: 4700, sessionId, type: "log.info", payload: { message: "not a failure" } },
    ])

    const result = searchEvents({ baseDir, sessionId, errorsOnly: true })

    expect(result.matches.map(rowType)).toEqual(["model.response_received", "log.error", "log.warn"])
    expect(formatEventSearchMatch(result.matches[1]!)).toContain("log")
    expect(formatEventSearchMatch(result.matches[1]!)).toContain("stream sink failed")
  })

  it("summarizes provider stream telemetry for stall debugging", () => {
    const baseDir = tempWorkspace()
    const sessionId = "stream-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendStreamTelemetry(store, sessionId)
    store.close()

    const result = searchEvents({
      baseDir,
      sessionId,
      typePatterns: ["model.stream"],
      pattern: "ping",
    })

    expect(result.matches.map(rowType)).toEqual(["model.stream.event_observed"])
    expect(formatEventSearchMatch(result.matches[0]!)).toContain("source=provider kind=ping")
    expect(formatEventSearchMatch(result.matches[0]!)).toContain("gap=5000ms")
  })

  it("summarizes a provider stream completion", () => {
    const baseDir = tempWorkspace()
    const sessionId = "stream-completion-session"
    writeDebugLog(baseDir, [
      { ts: 2000, sessionId, type: "model.stream.completed", version: 3, actor: "provider", payload: { requestId: "new", turn: 1, durationMs: 40, eventCount: 3, outcome: "ok", lastEventKind: "done", stallCount: 2 } },
    ])

    const result = searchEvents({ baseDir, sessionId, typePatterns: ["model.stream.completed"] })

    expect(result.matches.map((match) => formatEventSearchMatch(match))).toEqual([
      expect.stringContaining("stream completed request=new outcome=ok"),
    ])
    expect(formatEventSearchMatch(result.matches[0]!)).toContain("stalls=2")
  })

  it("surfaces loop starvation on stream summaries", () => {
    const baseDir = tempWorkspace()
    const sessionId = "loop-lag-session"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendStreamSummary(store, sessionId, 12_345)
    store.close()

    const result = searchEvents({ baseDir, sessionId, typePatterns: ["model.stream.summary"] })

    expect(result.matches.map(rowType)).toEqual(["model.stream.summary.recorded"])
    expect(formatEventSearchMatch(result.matches[0]!)).toContain("loopLag=12345ms")
  })

  it("returns an empty missing-store result when the workspace has no event store", () => {
    const result = searchEvents({ baseDir: tempWorkspace(), pattern: "anything" })

    expect(result.storeFound).toBe(false)
    expect(result.logFilesFound).toBe(false)
    expect(result.matches).toEqual([])
  })

  it("still searches the debug log when the workspace has no event store", () => {
    const baseDir = tempWorkspace()
    const sessionId = "log-only-session"
    writeDebugLog(baseDir, [
      { ts: 1000, sessionId, type: "log.error", payload: { message: "startup failed" } },
    ])

    const result = searchEvents({ baseDir, sessionId, errorsOnly: true })

    expect(result.storeFound).toBe(false)
    expect(result.logFilesFound).toBe(true)
    expect(result.matches.map(rowType)).toEqual(["log.error"])
  })

  it("names the attempt and agent of a handoff at either version, and the handoff type only for a stored fact that carries one", () => {
    const baseDir = tempWorkspace()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const output = {
      definitionId: "fly.implement", workflowDefinitionId: "implement",
      content: { summary: "done" }, bytes: 18, sha256: "a".repeat(64), preview: "done",
    }
    store.append({ aggregateId: "s", type: "handoff.written", version: 2, timestamp: 1, actor: "worker", sessionId: "s", payload: { attemptId: "implement", agentName: "Implement", ...output } })
    store.append({ aggregateId: "s", type: "handoff.written", version: 1, timestamp: 2, actor: "worker", sessionId: "s", payload: { stepId: "implement", stepName: "Implement", ...output, handoffType: "work-handoff" } })
    store.close()

    const [current, previous] = searchEvents({ baseDir, typePatterns: ["handoff.written"] }).matches.map((row) => formatEventSearchMatch(row))
    expect(current).toContain("handoff written Implement attempt=implement definition=fly.implement preview=done")
    expect(previous).toContain("handoff written Implement attempt=implement definition=fly.implement handoffType=work-handoff preview=done")
  })

  function tempWorkspace(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-event-search-"))
    return tmpDir
  }
})

function outcomes(matches: readonly EventSearchRow[]): unknown[] {
  return matches.map((row) => (row.source === "store" ? row.fact.payload.outcome : undefined))
}

function writeDebugLog(baseDir: string, records: readonly object[]): void {
  const logDir = resolveDebugLogDirectory(baseDir)
  fs.mkdirSync(logDir, { recursive: true })
  fs.writeFileSync(
    path.join(logDir, "2026-01-01T000000000Z-1-test.jsonl"),
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  )
}

function streamEventPayload() {
  return {
    requestId: "request-log-1",
    conversationId: "conversation-1",
    turn: 1,
    sequence: 3,
    source: "provider",
    kind: "content_block_delta",
    elapsedMs: 1500,
    sincePreviousMs: 120,
    metadata: {},
  }
}

function appendStreamTelemetry(store: ReturnType<typeof createSqliteEventStore>, sessionId: string): void {
  store.append({
    aggregateId: `provider_request_audit:${sessionId}`,
    type: "model.stream.event_observed",
    version: 1,
    timestamp: 3500,
    actor: "provider",
    sessionId,
    payload: {
      requestId: "request-1",
      conversationId: "conversation-1",
      turn: 1,
      sequence: 7,
      source: "provider",
      kind: "ping",
      elapsedMs: 12_000,
      sincePreviousMs: 5_000,
      metadata: { heartbeat: true },
    },
  })
}

function appendStreamSummary(store: ReturnType<typeof createSqliteEventStore>, sessionId: string, loopLagMs: number): void {
  store.append({
    aggregateId: `provider_request_audit:${sessionId}`,
    type: "model.stream.summary.recorded",
    version: 1,
    timestamp: 4200,
    actor: "flywheel",
    sessionId,
    payload: {
      requestId: "request-1",
      conversationId: "conversation-1",
      turn: 1,
      rawEventCount: 10,
      firstVisibleDeltaMs: 500,
      loopLagMs,
      interDelta: { p90Ms: 100 },
      watchdog: { thinkingStallCount: 0 },
    },
  })
}

function appendModelResponses(store: ReturnType<typeof createSqliteEventStore>, sessionId: string): void {
  appendModelResponse(store, sessionId, 3000, "ok")
  appendModelResponse(store, sessionId, 4000, "fatal_error")
}

function appendOutputSnapshot(
  store: ReturnType<typeof createSqliteEventStore>,
  sessionId: string,
  message: string,
): void {
  store.append({
    aggregateId: `output:${sessionId}`,
    type: "output.snapshot.recorded",
    version: 1,
    timestamp: 5000,
    actor: "flywheel",
    sessionId,
    payload: {
      blocks: [{ kind: "assistant", message }],
    },
  })
}

function appendModelResponse(
  store: ReturnType<typeof createSqliteEventStore>,
  sessionId: string,
  timestamp: number,
  outcome: "ok" | "fatal_error",
): void {
  store.append({
    aggregateId: `provider_request_audit:${sessionId}`,
    type: "model.response_received",
    version: 1,
    timestamp,
    actor: "provider",
    sessionId,
    payload: {
      requestId: `req-${timestamp}`,
      conversationId: "conversation-1",
      turn: 1,
      outcome,
      durationMs: 25,
      ...(outcome === "fatal_error" ? { error: { tag: "ProviderError", message: "bad request" } } : {}),
    },
  })
}
