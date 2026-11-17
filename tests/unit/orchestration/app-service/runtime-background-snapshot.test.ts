import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { resolveEventStoreDbFile, resolveSessionSummaryDbFile } from "../../../../src/infra/paths.js"
import { createRuntimeBackgroundSnapshotProjector } from "../../../../src/orchestration/app-service/runtime-background-snapshot.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { acquireSessionSummaryIndex } from "../../../../src/orchestration/session/session-summary-index.js"
import { buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { createSessionMetadataProjection } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { historicalSessionCreatedFacts } from "../../../fixtures/tolerant-reprojection-fixtures.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { entriesVisited } from "../../../helpers/entries-visited.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"
import { minimalSession } from "../session/_session-persistence-fixtures.js"
import { contextEvent, recordRuntimeEvent } from "../session/_budget-store-fixtures.js"

const temporary = temporaryDirectories()

/** A store of `count` chat sessions `s0`, `s1`, ..., each updated one second after the one before. */
function storeOfSessions(count: number) {
  const root = temporary("runtime-background-scoped-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  store.appendBatch(Array.from({ length: count }, (_, index) => buildSessionMetadataAppend(`s${index}`, buildSessionCreatedFact(minimalSession({
    label: `s${index}`,
    lifecycleState: "inactive",
    lastUpdated: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
  })))))
  const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(root), asAsyncEventReadSurface(store), { shared: false })
  return {
    root,
    store,
    index,
    async close() {
      await index.dispose()
      store.close()
    },
  }
}

describe("createRuntimeBackgroundSnapshotProjector", () => {
  test("returns cold metadata immediately, then exact summary totals after joined replay", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-background-snapshot-test-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(tmpDir), asAsyncEventReadSurface(store), { shared: false })
    try {
      const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
      const sessionId = await manager.createChat({ name: "Session bug", initialState: "inactive" })
      const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
      await recordRuntimeEvent(writer.record, {
        type: "model.turn.completed",
        data: {
          total_cost_usd: 8.24,
          usage: { input_tokens: 550_000, output_tokens: 1_900 },
        },
      })
      await recordRuntimeEvent(writer.record, contextEvent(20, 100))
      await writer.record({
        type: "session.duration.recorded",
        version: 1,
        actor: "flywheel",
        payload: { accumulatedActiveMs: 524_000 },
      })
      writer.dispose()

      const projector = createRuntimeBackgroundSnapshotProjector(asAsyncEventReadSurface(store), index, tmpDir)
      const immediate = await projector.readImmediate()
      expect(immediate.totalsLoading).toBe(true)
      expect(immediate.rows[0]).toMatchObject({ id: sessionId, title: "Session bug" })
      expect(immediate.rows[0]?.totalCost).toBeUndefined()
      expect(immediate.rows[0]?.durationMs).toBeUndefined()

      const snapshot = await projector.waitForTotals()

      expect(snapshot.rows.map((row) => row.id)).toEqual([sessionId])
      expect(snapshot.totalsLoading).toBe(false)
      expect(snapshot.rows[0]).toMatchObject({
        id: sessionId,
        title: "Session bug",
        totalCost: 8.24,
        totalTokens: 551_900,
        contextPercent: 20,
        durationMs: 524_000,
      })
      expect(snapshot.errors).toEqual([])
    } finally {
      await index.dispose()
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("a corrupt stream summary states a budget error naming the generation speed and keeps the totals", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-background-snapshot-generation-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(tmpDir), asAsyncEventReadSurface(store), { shared: false })
    try {
      const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
      const sessionId = await manager.createChat({ name: "Damaged speed", initialState: "inactive" })
      const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
      await recordRuntimeEvent(writer.record, { type: "model.turn.completed", data: { total_cost_usd: 1.5, usage: { input_tokens: 1_000, output_tokens: 200 } } })
      writer.dispose()
      store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "model.stream.summary.recorded", version: 3, actor: "flywheel", timestamp: Date.now(), payload: {}, payloadJson: "{{not-json" })

      const snapshot = await createRuntimeBackgroundSnapshotProjector(asAsyncEventReadSurface(store), index, tmpDir).waitForTotals()

      expect(snapshot.rows[0]).toMatchObject({ id: sessionId, totalsLoading: false, totalCost: 1.5, totalTokens: 1_200 })
      expect(snapshot.generationSpeeds).toEqual({})
      expect(snapshot.errors).toEqual([{ sessionId, scope: "budget", reason: expect.stringMatching(/^generation speed: corrupt event row /) }])
    } finally {
      await index.dispose()
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("publishes exact zero totals for a ready session with no usage", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-background-snapshot-zero-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(tmpDir), asAsyncEventReadSurface(store), { shared: false })
    try {
      const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
      const sessionId = await manager.createChat({ name: "No usage", initialState: "inactive" })
      const snapshot = await createRuntimeBackgroundSnapshotProjector(asAsyncEventReadSurface(store), index, tmpDir).waitForTotals()

      expect(snapshot.rows[0]).toMatchObject({
        id: sessionId,
        totalCost: 0,
        totalBilledCost: 0,
        priceUnavailable: false,
        totalTokens: 0,
        contextPercent: 0,
        contextPromptTokens: 0,
        durationMs: 0,
      })
      expect(snapshot.errors).toEqual([])
    } finally {
      await index.dispose()
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("catches up incrementally: rows reflect facts appended after the first snapshot", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-background-snapshot-incremental-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(tmpDir), asAsyncEventReadSurface(store), { shared: false })
    try {
      const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
      const sessionId = await manager.createChat({ name: "Incremental", initialState: "inactive" })
      const projector = createRuntimeBackgroundSnapshotProjector(asAsyncEventReadSurface(store), index, tmpDir)

      const first = await projector.waitForTotals()
      expect(first.rows.map((row) => row.id)).toEqual([sessionId])
      expect(first.rows[0]?.totalCost).toBe(0)

      const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
      await recordRuntimeEvent(writer.record, {
        type: "model.turn.completed",
        data: { total_cost_usd: 1.5, usage: { input_tokens: 1_000, output_tokens: 200 } },
      })
      await writer.record({
        type: "session.duration.recorded",
        version: 1,
        actor: "flywheel",
        payload: { accumulatedActiveMs: 12_000 },
      })
      writer.dispose()

      const second = await projector.waitForTotals()
      expect(second.rows[0]).toMatchObject({
        id: sessionId,
        totalCost: 1.5,
        totalTokens: 1_200,
        durationMs: 12_000,
      })
    } finally {
      await index.dispose()
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("a scoped refresh of 3 ids over 100 or 5,000 sessions issues the same state requests and builds 3 rows", async () => {
    // The summary projection refreshes the few held sessions that a commit
    // touched, about once per model response; building the whole catalog to
    // pick them made each refresh cost the workspace.
    const scopedRefresh = async (sessions: number) => {
      const workspace = storeOfSessions(sessions)
      try {
        const { reader, take } = countStateRequests(asAsyncEventReadSurface(workspace.store))
        const projector = createRuntimeBackgroundSnapshotProjector(reader, workspace.index, workspace.root)
        const requested = ["s2", "s0", "s1"]
        await projector.waitForTotals(requested)
        workspace.store.append(buildSessionMetadataAppend("s1", { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: "changed", shortLabel: "changed", name: "changed", lastUpdated: "2026-01-01T00:00:00.000Z" } }))
        take()
        let rows: readonly { readonly id: string; readonly title: string }[] = []
        const visits = await entriesVisited(async () => {
          rows = (await projector.readImmediate(requested)).rows
          rows = (await projector.waitForTotals(requested)).rows
        }, { state: createSessionMetadataProjection(reader).getState() })
        expect(rows.map((row) => row.id).toSorted()).toEqual(["s0", "s1", "s2"])
        expect(rows.find((row) => row.id === "s1")?.title).toBe("changed")
        const requests = take()
        return { visits, requests: requests.map((request) => request.method), facts: factsRead(requests) }
      } finally {
        await workspace.close()
      }
    }
    expect(await scopedRefresh(5_000)).toEqual(await scopedRefresh(100))
  })

  test("an unscoped refresh still returns the full catalog, the most recently updated first", async () => {
    const workspace = storeOfSessions(3)
    try {
      const projector = createRuntimeBackgroundSnapshotProjector(asAsyncEventReadSurface(workspace.store), workspace.index, workspace.root)
      expect((await projector.readImmediate()).rows.map((row) => row.id)).toEqual(["s2", "s1", "s0"])
      expect((await projector.waitForTotals()).rows.map((row) => row.id)).toEqual(["s2", "s1", "s0"])
    } finally {
      await workspace.close()
    }
  })

  test("matches foreground resolved execution directories for v1, v2, and identity-only sessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-background-metadata-parity-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(tmpDir), asAsyncEventReadSurface(store), { shared: false })
    try {
      store.appendBatch(historicalSessionCreatedFacts("background-parity"))
      store.append({ aggregateId: "session:identity-only", sessionId: "identity-only", type: "session.created", version: 3, actor: "flywheel", timestamp: 3, payload: { kind: "chat", command: "chat", conversationId: "identity", label: "Identity", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" } })
      const foreground = (await createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store }).listMetadata()).sessions
      const background = (await createRuntimeBackgroundSnapshotProjector(asAsyncEventReadSurface(store), index, tmpDir).waitForTotals()).rows
      expect(background.map(({ id, executionCwd }) => ({ id, executionCwd }))).toEqual(
        foreground.map(({ id, executionCwd }) => ({ id, executionCwd })),
      )
    } finally {
      await index.dispose()
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("matches foreground degraded recovery rows", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-background-degraded-parity-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(tmpDir), asAsyncEventReadSurface(store), { shared: false })
    try {
      const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
      const sessionId = await manager.createChat({ name: "Recovered", initialState: "inactive" })
      store.append({
        aggregateId: `session:${sessionId}`,
        type: "session.auth.profile.selected",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId,
        payload: { authProfileId: "work" },
        payloadJson: "{{not-json",
      })

      const foreground = (await manager.listMetadata()).sessions[0]
      const background = (await createRuntimeBackgroundSnapshotProjector(asAsyncEventReadSurface(store), index, tmpDir).waitForTotals()).rows[0]

      expect(foreground).toMatchObject({ id: sessionId, degraded: true, unavailableFields: ["metadata"] })
      expect(background).toMatchObject({ id: sessionId, degraded: true, unavailableFields: ["metadata"] })
    } finally {
      await index.dispose()
      store.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
