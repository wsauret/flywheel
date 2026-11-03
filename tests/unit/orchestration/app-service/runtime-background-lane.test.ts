import { describe, expect, mock, spyOn, test } from "bun:test"
import { isAbortError } from "../../../../src/infra/abort.js"
import { DebugLog } from "../../../../src/infra/debug-log.js"

import { Log } from "../../../../src/infra/log.js"
import { createRuntimeBackgroundLane, serveRuntimeBackgroundQuery } from "../../../../src/orchestration/app-service/runtime-background-lane.js"
import { RuntimeCallTimeout } from "../../../../src/protocol/runtime-client-deadlines.js"
import type { RuntimeBackgroundClient } from "../../../../src/orchestration/app-service/worker-background-client.js"
import { Context, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { RuntimeBackgroundRpc } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { protocolBackgroundSchema } from "../../../../src/protocol/modules.js"
import type { TranscriptSearchResult } from "../../../../src/protocol/transcript-protocol-types.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile, resolveSessionSummaryDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createRuntimeBackgroundSnapshotProjector } from "../../../../src/orchestration/app-service/runtime-background-snapshot.js"
import { createSessionDetailReader } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { readSessionMetadata } from "../../../../src/orchestration/session/session-metadata-store.js"
import { acquireSessionSummaryIndex } from "../../../../src/orchestration/session/session-summary-index.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

const directory = temporaryDirectories()

function backgroundClient(overrides: Partial<RuntimeBackgroundClient> = {}): RuntimeBackgroundClient {
  return {
    sessionChangeSummary: async () => { throw new Error("Session change summary is not used in this fixture") },
    warm: async () => {},
    snapshot: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
    sessionSummaryImmediate: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
    waitForTotals: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
    sessionDetail: async () => ({ view: null }),
    transcriptSearch: async () => { throw new Error("Transcript search is not used in this fixture") },
    recall: async () => { throw new Error("Recall is not used in this fixture") },
    moduleSnapshot: async () => { throw new Error("Module background snapshots are not used in this fixture") },
    close: async () => {},
    ...overrides,
  }
}

function macrotaskTimer(fire: () => void): () => void {
  const handle = setTimeout(fire, 0)
  return () => clearTimeout(handle)
}

/** The parse options the RPC server and client decode this call with. */
const served = (rpc: Rpc.AnyWithProps) => Context.get(rpc.annotations, Rpc.ParseOptions)

describe("runtime background Worker lane", () => {
  test("detail and status share the history detail port", async () => {
    const calls: string[] = []
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({ sessionDetail: async ({ sessionId }) => { calls.push(sessionId); return { view: null } } }),
    })
    try {
      await lane.sessionDetail({ sessionId: "s1" })
      await serveRuntimeBackgroundQuery(lane, { type: "sessionDetail", sessionId: "s1" }, 0)
      await serveRuntimeBackgroundQuery(lane, { type: "statusSnapshot", sessionIds: ["s1"] }, 0)
      expect(calls).toEqual(["s1", "s1", "s1"])
    } finally {
      await lane.dispose()
    }
  })

  test("a budget batch reads the summary index and no session history, whatever the batch size", async () => {
    const root = directory("runtime-background-budget-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(root), counter.reader, { shared: false })
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
    const sessionIds: string[] = []
    for (let session = 0; session < 100; session++) {
      const sessionId = await manager.createChat({ name: `chat ${session}`, initialState: "inactive" })
      store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "session.duration.recorded", version: 1, actor: "flywheel", timestamp: 1, payload: { accumulatedActiveMs: 1000 } })
      sessionIds.push(sessionId)
    }
    const projector = createRuntimeBackgroundSnapshotProjector(counter.reader, index, root)
    const detail = createSessionDetailReader({
      sessionStore: { get: () => undefined },
      manager: { read: (sessionId) => readSessionMetadata(counter.reader, sessionId) },
      reader: counter.reader,
      projectionReader: counter.reader,
      projectRoot: root,
      summaryIndex: index,
    })
    const lane = createRuntimeBackgroundLane(root, {
      createClient: () => backgroundClient({
        sessionSummaryImmediate: (ids) => projector.readImmediate(ids),
        sessionDetail: ({ sessionId }) => detail(sessionId),
      }),
    })
    const budgets = async (ids: readonly string[]) => {
      counter.take()
      const result = await serveRuntimeBackgroundQuery(lane, { type: "budgetSnapshot", sessionIds: ids }, 0)
      return { views: result?.views ?? [], requests: counter.take() }
    }
    try {
      await projector.waitForTotals(sessionIds)
      // The held metadata and fork projections fold once, on the first read.
      await budgets(sessionIds)
      const few = await budgets(sessionIds.slice(0, 3))
      const many = await budgets(sessionIds)
      expect(many.views).toHaveLength(100)
      for (const { view } of many.views) expect(view).toMatchObject({ totalsLoading: false, tokens: 0, cost: 0 })
      expect([...few.requests, ...many.requests].flatMap(({ aggregateId }) => aggregateId?.startsWith("session:") ? [aggregateId] : [])).toEqual([])
      expect(many.requests.length).toBe(few.requests.length)
    } finally {
      await lane.dispose()
      await index.dispose()
      store.close()
    }
  })

  test("a budget batch states a withheld total as failed, a replaying index as loading, and an unlisted session as absent", async () => {
    const row = { kind: "chat" as const, title: "chat", lifecycleState: "inactive" as const, notices: [], inputMode: { kind: "chat" as const }, lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/cwd" }
    const ready = { ...row, id: "ready", totalsLoading: false as const, totalCost: 1, totalBilledCost: 0.5, priceUnavailable: false, totalTokens: 42, contextPercent: 20, contextPromptTokens: 200, durationMs: 10 }
    const withheld = { ...row, id: "withheld", totalsLoading: true as const }
    let replaying = false
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({
        sessionSummaryImmediate: async () => ({
          rows: [ready, withheld],
          errors: [{ sessionId: "withheld", scope: "budget", reason: "damaged usage" }],
          totalsLoading: replaying,
          generationSpeeds: { ready: 18.2 },
        }),
      }),
    })
    try {
      const request = { type: "budgetSnapshot", sessionIds: ["ready", "withheld", "unlisted"] } as const
      expect((await serveRuntimeBackgroundQuery(lane, request, 0))?.views).toEqual([
        { sessionId: "ready", view: { totalsLoading: false, tokens: 42, cost: 1, billedCost: 0.5, priceUnavailable: false, contextPercent: 20, contextPromptTokens: 200, averageGenerationTokensPerSecond: 18.2 } },
        { sessionId: "withheld", view: null },
        { sessionId: "unlisted", view: null },
      ])
      replaying = true
      expect((await serveRuntimeBackgroundQuery(lane, request, 0))?.views.map(({ view }) => view)).toEqual([{ totalsLoading: true }, { totalsLoading: true }, null])
    } finally {
      await lane.dispose()
    }
  })

  test("recall RPC strictly roundtrips every mode, bound, and result field", () => {
    const rpc = RuntimeBackgroundRpc.requests.get("RuntimeBackgroundRecall")!
    const payload = {
      projectRoot: "/project",
      conversationId: "conversation",
      contract: { scope: "all" as const, query: "needle", expand: [0, "entry"], offset: 4, limit: 8000, page: 2 },
    }
    const result = {
      hits: [{ index: 0, entryId: "entry", role: "assistant", summary: "summary", snippet: "snippet", text: "text", offset: 4, totalLength: 12, nextOffset: 8, files: ["a.ts"] }],
      totalMatches: 1,
      invalidExpand: [9, "missing"],
    }

    expect(Schema.decodeUnknownSync(rpc.payloadSchema, served(rpc))(payload)).toEqual(payload)
    expect(Schema.decodeUnknownSync(rpc.successSchema, served(rpc))(result)).toEqual(result)
    for (const invalid of [
      { ...payload, excess: true },
      { ...payload, contract: { ...payload.contract, excess: true } },
      { ...payload, contract: { ...payload.contract, scope: "nearby" } },
      { ...payload, contract: { ...payload.contract, expand: [0, 1, 2, 3, 4, 5] } },
      { ...payload, contract: { ...payload.contract, limit: 8001 } },
      { ...payload, contract: { ...payload.contract, offset: -1 } },
      { ...payload, contract: { ...payload.contract, page: 0 } },
    ]) {
      expect(() => Schema.decodeUnknownSync(rpc.payloadSchema, served(rpc))(invalid)).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(rpc.successSchema, served(rpc))({ ...result, excess: true })).toThrow()
    expect(() => Schema.decodeUnknownSync(rpc.successSchema, served(rpc))({ hits: [{ ...result.hits[0], excess: true }] })).toThrow()
  })

  test("recall outlives the passive history deadline and preserves its result or original error", async () => {
    let releaseSuccess!: (value: { hits: [] }) => void
    let releaseFailure!: (error: Error) => void
    const success = new Promise<{ hits: [] }>((resolve) => { releaseSuccess = resolve })
    const failure = new Promise<never>((_resolve, reject) => { releaseFailure = reject })
    let timerCalls = 0
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({
        recall: (conversationId) => conversationId === "ok" ? success : failure,
      }),
      setTimer: () => {
        timerCalls++
        return () => {}
      },
    })

    const heldSuccess = lane.recall("ok", { scope: "lineage" })
    await Promise.resolve()
    expect(timerCalls).toBe(0)
    releaseSuccess({ hits: [] })
    expect(await heldSuccess).toEqual({ hits: [] })

    const original = new Error("index failed")
    const heldFailure = lane.recall("error", { scope: "lineage" })
    releaseFailure(original)
    await expect(heldFailure).rejects.toBe(original)
    expect(timerCalls).toBe(0)
  })

  test("transcript search uses the bounded Worker lane and preserves failures", async () => {
    const expected: TranscriptSearchResult = {
      hits: [{ sessionId: "s", sessionTitle: "Chat", entryId: "entry", role: "user", snippet: "[needle]" }],
      total: 1,
      page: 1,
      pageSize: 20,
    }
    const original = new Error("derived index failed")
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({
        transcriptSearch: async (request) => {
          if (request.query === "error") throw original
          return expected
        },
      }),
    })

    expect(await lane.transcriptSearch({ query: "needle", page: 1, sessionId: "s" })).toEqual(expected)
    await expect(lane.transcriptSearch({ query: "error", page: 1 })).rejects.toBe(original)
  })

  test("transcript search RPC strictly roundtrips its public request and result", () => {
    const rpc = RuntimeBackgroundRpc.requests.get("RuntimeBackgroundTranscriptSearch")!
    const payload = { projectRoot: "/project", request: { query: "needle", page: 2, sessionId: "s" } }
    const result = {
      hits: [{ sessionId: "s", sessionTitle: "Chat", entryId: "entry", role: "assistant" as const, snippet: "[needle]" }],
      total: 21,
      page: 2,
      pageSize: 20,
    }

    expect(Schema.decodeUnknownSync(rpc.payloadSchema)(payload)).toEqual(payload)
    expect(Schema.decodeUnknownSync(rpc.successSchema)(result)).toEqual(result)
  })

  test("summary RPCs strictly roundtrip requested rows, scoped errors, and loading state", () => {
    const payload = { projectRoot: "/project", sessionIds: ["session-a"] }
    const result = {
      rows: [],
      errors: [{ sessionId: "session-a", scope: "budget" as const, reason: "damaged usage" }],
      totalsLoading: true,
      generationSpeeds: { "session-a": 12.5 },
    }
    for (const name of ["RuntimeBackgroundSessionSummaryImmediate", "RuntimeBackgroundWaitForTotals"] as const) {
      const rpc = RuntimeBackgroundRpc.requests.get(name)!
      expect(Schema.decodeUnknownSync(rpc.payloadSchema, served(rpc))(payload)).toEqual(payload)
      expect(Schema.decodeUnknownSync(rpc.successSchema, served(rpc))(result)).toEqual(result)
      expect(() => Schema.decodeUnknownSync(rpc.payloadSchema, served(rpc))({ ...payload, excess: true })).toThrow()
      expect(() => Schema.decodeUnknownSync(rpc.successSchema, served(rpc))({ ...result, excess: true })).toThrow()
    }
  })

  test("immediate summaries keep the passive deadline while owned total waits bypass it", async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<RuntimeBackgroundClient["waitForTotals"]>>>()
    let timerCalls = 0
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({
        sessionSummaryImmediate: () => new Promise(() => {}),
        waitForTotals: () => held.promise,
      }),
      setTimer: (fire) => {
        timerCalls++
        return macrotaskTimer(fire)
      },
    })

    await expect(lane.sessionSummaryImmediate(["session-a"])).rejects.toBeInstanceOf(RuntimeCallTimeout)
    const waiting = lane.waitForTotals(["session-a"])
    await Promise.resolve()
    expect(timerCalls).toBe(1)
    held.resolve({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} })
    await expect(waiting).resolves.toEqual({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} })
  })

  test("lazily acquires one persistent client shared by concurrent calls", async () => {
    let clients = 0
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => {
        clients += 1
        return backgroundClient()
      },
    })

    expect(clients).toBe(0)
    await Promise.all([lane.snapshot(), lane.snapshot(), lane.snapshot()])
    expect(clients).toBe(1)
  })

  test("shares one lease across concurrent history and recall and releases it once", async () => {
    let clients = 0
    let closes = 0
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => {
        clients++
        return backgroundClient({
          snapshot: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
          recall: async () => ({ hits: [] }),
          close: async () => { closes++ },
        })
      },
    })

    await Promise.all([lane.snapshot(), lane.recall("conversation", { scope: "all" })])
    await Promise.all([lane.dispose(), lane.dispose()])

    expect(clients).toBe(1)
    expect(closes).toBe(1)
  })

  test("start warms the client without duplicating ownership", async () => {
    let clients = 0
    let warms = 0
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => {
        clients += 1
        return backgroundClient({ warm: async () => { warms += 1 } })
      },
    })

    lane.start()
    lane.start()
    await lane.snapshot()

    expect(clients).toBe(1)
    expect(warms).toBe(2)
  })

  test("a failed warm does not poison the lane", async () => {
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({ warm: async () => { throw new Error("boot lost") } }),
    })

    lane.start()
    const result = await lane.snapshot()

    expect(result.rows).toEqual([])
  })

  test("rejects with RuntimeCallTimeout when a dispatch never completes", async () => {
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({ snapshot: () => new Promise(() => {}) }),
      setTimer: macrotaskTimer,
    })

    await expect(lane.snapshot()).rejects.toBeInstanceOf(RuntimeCallTimeout)
  })

  test("a repeating call failure records its first error in full, then one count keyed by its first line, at the read's level", async () => {
    const log = Log.create({ service: "runtime.background" })
    const error = spyOn(log, "error").mockImplementation(() => {})
    const warn = spyOn(log, "warn").mockImplementation(() => {})
    const failure = "Expected a session view\n  at [0].view: a union dump that repeats on every read"
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({ snapshot: async () => { throw new Error(failure) } }),
    })
    try {
      for (let read = 0; read < 3; read++) await expect(lane.snapshot()).rejects.toThrow("Expected a session view")
      await lane.dispose()

      // The summary projection retries a failed snapshot on its own, so the
      // snapshot's failures and their count record at WARN, never ERROR.
      expect(warn.mock.calls).toEqual([
        ["runtime background snapshot failed", expect.objectContaining({ error: failure, errorDetail: expect.objectContaining({ message: failure, stack: expect.any(String) }) })],
        ["runtime background snapshot failed again", expect.objectContaining({ count: 2, error: "Expected a session view" })],
      ])
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
      warn.mockRestore()
    }
  })

  test("awaits exactly one client disposal", async () => {
    let closes = 0
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({ close: async () => { closes += 1 } }),
    })
    await lane.snapshot()

    await lane.dispose()
    await lane.dispose()

    expect(closes).toBe(1)
    // A read after disposal is the owner's own shutdown refusing it.
    const refusal: unknown = await lane.snapshot().then(() => undefined, (error: unknown) => error)
    expect(isAbortError(refusal)).toBe(true)
    expect(refusal).toMatchObject({ message: "Runtime background lane is disposed" })
  })

  test("acquires the client only when the first module snapshot asks and forwards the domain and session", async () => {
    let clients = 0
    const asked: string[] = []
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => {
        clients += 1
        return backgroundClient({
          moduleSnapshot: async (domain, sessionId) => {
            asked.push(`${domain}:${sessionId}`)
            return Schema.decodeUnknownSync(protocolBackgroundSchema(domain))({ experimentView: null })
          },
        })
      },
    })

    expect(clients).toBe(0)
    expect(await lane.moduleSnapshot("experiment_view", "old-chat")).toEqual({ experimentView: null })
    expect(clients).toBe(1)
    expect(asked).toEqual(["experiment_view:old-chat"])
  })

  test("records a failed foreground read at ERROR, a failed summary read at WARN, and an interrupted read at DEBUG only", async () => {
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    const interrupted = new DOMException("Runtime background call interrupted", "AbortError")
    const summaryReads = [interrupted, new Error("summary index unavailable")]
    const lane = createRuntimeBackgroundLane("/cwd", {
      createClient: () => backgroundClient({
        sessionSummaryImmediate: async () => { throw summaryReads.shift() },
        sessionDetail: async () => { throw new Error("session history unreadable") },
        recall: async () => { throw new Error("search index unreadable") },
      }),
    })
    try {
      await expect(lane.sessionSummaryImmediate(["s1"])).rejects.toBe(interrupted)
      await expect(lane.sessionSummaryImmediate(["s1"])).rejects.toThrow("summary index unavailable")
      await expect(lane.sessionDetail({ sessionId: "s1" })).rejects.toThrow("session history unreadable")
      await expect(lane.recall("conversation", { scope: "all" })).rejects.toThrow("search index unreadable")
      // Only the records a default level keeps are compared, so the case holds
      // whatever level an earlier file in this process left behind.
      expect(record.mock.calls.map(([input]) => input).filter((input) => input.type !== "log.debug")).toEqual([
        expect.objectContaining({ type: "log.warn", payload: expect.objectContaining({ message: "runtime background session summary failed", error: "summary index unavailable" }) }),
        expect.objectContaining({ type: "log.error", payload: expect.objectContaining({ message: "runtime background session detail failed", error: "session history unreadable" }) }),
        expect.objectContaining({ type: "log.error", payload: expect.objectContaining({ message: "runtime background conversation search failed", error: "search index unreadable" }) }),
      ])
    } finally {
      mock.restore()
      await lane.dispose()
    }
  })
})
