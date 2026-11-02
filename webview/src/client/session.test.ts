import assert from "node:assert/strict"
import { test } from "node:test"

import { createRuntimeSession } from "./session.js"
import { createViewProjection } from "./view-state.js"
import { changesLabel } from "./changes-label.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { FrontendEvent, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import type { SessionChangesResult } from "../../../src/protocol/session-changes-protocol-types.js"
import type { RuntimeQuestionSnapshotResult } from "../../../src/protocol/question-protocol-types.js"
import { fakeConnection, settle } from "./session-connection-fixture.js"
import { mountActivityStatus } from "../app/render-ownership-loader-fixture.js"
import { selectionConnection } from "./session-selection-fixture.js"
import { detailView, statusView } from "../../../tests/helpers/runtime-views.js"
import { spyOn } from "bun:test"
import type { RuntimeClientDiagnostic } from "../../../src/protocol/runtime-client-diagnostics.js"
import { backgroundReads } from "../../../src/protocol/client/background-reads.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"
import { fakeLanes, LANE_BREAK } from "../../../tests/helpers/fake-lanes.js"

test("the open session's pending question and the newest open time follow the question projection's snapshots and patches, across a lane break", async () => {
  const base = selectionConnection()
  const snapshot = await base.query({ type: "snapshot" })
  const row = { ...snapshot.rows[0]!, lifecycleState: "active" as const }
  let rows = [row, { ...row, id: "other" }]
  const first = Promise.withResolvers<RuntimeQuestionSnapshotResult>()
  let current = first.promise
  let questionReads = 0
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const query = runtimeQuery({
    snapshot: async () => ({ ...snapshot, rows, projectRoot: "/scratch/project" }),
    questionSnapshot: async () => { questionReads++; return current },
  }, base.query)
  const session = createRuntimeSession({ connection: {
    ...base, ...lanes.client, query,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  } })
  const publish = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  const project = createViewProjection()
  try {
    await settle()
    assert.equal(session.projectRoot, "/scratch/project")
    assert.equal(project(session).newestQuestionOpenedAt, undefined)
    first.resolve({ snapshotPosition: 0, views: [
      { sessionId: row.id, view: { kind: "question", toolUseId: "q", questions: [], timestamp: 100 } },
      { sessionId: "other", view: { kind: "question", toolUseId: "other-q", questions: [], timestamp: 200 } },
    ] })
    await settle()
    assert.equal(project(session).newestQuestionOpenedAt, 200)
    assert.equal(session.sessionId, row.id)
    assert.equal(project(session).pendingQuestion?.toolUseId, "q")
    assert.equal(project(session).sessions[0]?.awaitingAnswer, true)
    publish({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: "other" }, position: 1, prevPosition: 0, payload: { kind: "question.removed" } } })
    assert.equal(project(session).newestQuestionOpenedAt, 100)
    publish({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: row.id }, position: 1, prevPosition: 0, payload: { kind: "question.removed" } } })
    assert.equal(project(session).pendingQuestion, undefined)
    publish({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: row.id }, position: 2, prevPosition: 1, payload: { kind: "question.updated", question: { kind: "question", toolUseId: "new", questions: [], timestamp: 300 } } } })
    assert.equal(project(session).newestQuestionOpenedAt, 300)
    publish({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: row.id }, position: 3, prevPosition: 2, payload: { kind: "question.updated", question: { kind: "question", toolUseId: "newer", questions: [], timestamp: 400 } } } })
    assert.equal(project(session).newestQuestionOpenedAt, 400)
    assert.equal(project(session).pendingQuestion?.toolUseId, "newer")
    // The question is settled while the lane is down: no patch reports it,
    // so the next lane reads it again, and the dock keeps its question
    // until that read answers.
    const reread = Promise.withResolvers<RuntimeQuestionSnapshotResult>()
    current = reread.promise
    lanes.end()
    publish(LANE_BREAK)
    lanes.open()
    await settle()
    assert.equal(project(session).pendingQuestion?.toolUseId, "newer")
    reread.resolve({ snapshotPosition: 5, views: [{ sessionId: row.id, view: null }, { sessionId: "other", view: null }] })
    await settle()
    assert.equal(project(session).newestQuestionOpenedAt, undefined)
    assert.equal(project(session).sessions[0]?.awaitingAnswer, undefined)
    assert.equal(project(session).pendingQuestion, undefined)
    // A read that answers at an older position than a removal that arrived
    // while it was in flight does not bring the question back.
    const stale = Promise.withResolvers<RuntimeQuestionSnapshotResult>()
    current = stale.promise
    lanes.end()
    publish(LANE_BREAK)
    lanes.open()
    await settle()
    publish({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: row.id }, position: 6, prevPosition: 5, payload: { kind: "question.updated", question: { kind: "question", toolUseId: "late", questions: [], timestamp: 500 } } } })
    publish({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: row.id }, position: 7, prevPosition: 6, payload: { kind: "question.removed" } } })
    stale.resolve({ snapshotPosition: 5, views: [{ sessionId: row.id, view: { kind: "question", toolUseId: "newer", questions: [], timestamp: 400 } }, { sessionId: "other", view: null }] })
    await settle()
    assert.equal(project(session).pendingQuestion, undefined)
  } finally { session.dispose() }
  rows = []
  const readsBeforeEmpty = questionReads
  const sessionWithoutRows = createRuntimeSession({ connection: { ...base, query } })
  try {
    await settle()
    assert.equal(project(sessionWithoutRows).newestQuestionOpenedAt, undefined)
    assert.equal(questionReads, readsBeforeEmpty)
  } finally { sessionWithoutRows.dispose() }
})

test("a failed resident detail retries once without rereading healthy residents", async () => {
  const base = selectionConnection()
  const reads: string[] = []
  const phases: string[] = []
  let fails = true
  let failingId = "failed"
  const query = runtimeQuery({
    modelAssignments: async () => [],
    statusSnapshot: async () => ({ snapshotPosition: 0, views: [] }),
    sessionDetailSnapshot: async (request) => {
      reads.push(...request.sessionIds)
      if (fails && request.sessionIds.includes(failingId)) throw new Error("unavailable")
      const snapshot = await base.query({ type: "sessionDetailSnapshot", sessionIds: ["cold-chat"] })
      return { ...snapshot, views: request.sessionIds.map(sessionId => {
        const view = snapshot.views[0]?.view
        return { sessionId, view: view ? detailView({ ...view.row, id: sessionId }, view.conversationId) : null }
      }) }
    },
  }, base.query)
  const connection: RuntimeConnection = {
    ...base,
    reportDiagnostic(record: RuntimeClientDiagnostic) {
      if (record.kind === "background_read" && record.reader === "session detail") phases.push(record.phase)
    },
    query,
  }
  const session = createRuntimeSession({ connection })
  const timers: (() => void)[] = []
  let clock: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">> | undefined
  let clear: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">> | undefined
  try {
    await settle()
    for (let index = 0; index < 6; index++) { await session.select(`healthy-${index}`); await settle() }
    // A real handle, already cleared, stands in for each manually delivered timer.
    const inert = setTimeout(() => {}, 0)
    clearTimeout(inert)
    clock = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(globalThis.setTimeout, {
      apply(_target, _receiver, [callback]: Parameters<typeof setTimeout>) { timers.push(() => callback()); return inert },
    }))
    clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {})
    await session.select("failed")
    await settle()
    assert.deepEqual(phases, ["failed"])
    const before = reads.length
    fails = false
    assert.ok(timers.length > 0)
    for (const retry of timers.splice(0)) retry()
    await settle()
    assert.deepEqual(reads.slice(before), ["failed"])
    assert.deepEqual(phases, ["failed", "recovered"])
    const otherFailures = backgroundReads(connection).state.pending.size
    fails = true
    failingId = "retired"
    await session.select("retired")
    await settle()
    assert.equal(backgroundReads(connection).state.pending.size, otherFailures + 1)
    await session.remove("retired")
    assert.equal(backgroundReads(connection).state.pending.size, otherFailures, "forgetting the failed detail releases its notice contribution before the retry clock advances")
    assert.deepEqual(phases, ["failed", "recovered", "failed", "recovered"])
  } finally { session.dispose(); clock?.mockRestore(); clear?.mockRestore() }
})

test("selected session recovers an opaque settlement barrier before its view allows exit", async () => {
  const base = selectionConnection()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let recovering = false
  const status: StatusView = { activity: "generating", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: false, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [] }
  const query = runtimeQuery({
    statusSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map(sessionId => ({ sessionId, view: status })) }),
    outputWindow: async () => {
      if (recovering) { entered.resolve(); await gate.promise }
      return { snapshotPosition: 0, totalBlocks: 1, visibleMessageCount: 1, range: {
        kind: "ok", consistencyToken: "fixture", anchor: { kind: "tail" }, streamingToolText: {}, streamingOutputChars: 0,
        blocks: [{ kind: "text", id: "answer", content: recovering ? "Final answer" : "Old answer", timestamp: 0 }],
        window: { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, contentBytes: 0 },
      } }
    },
  }, base.query)
  const connection: RuntimeConnection = {
    ...base, query,
    subscribe(listener) { listeners.add(listener); const stop = base.subscribe(listener); return () => { listeners.delete(listener); stop() } },
  }
  const session = createRuntimeSession({ connection })
  try {
    await settle()
    await session.select("cold-chat")
    await settle()
    recovering = true
    for (const listener of listeners) listener({ type: "patch", patch: {
      cursor: { scope: "session", domain: "status", sessionId: "cold-chat" }, position: 1, prevPosition: 0,
      payload: { kind: "status.updated", status: { ...status, activity: "idle", settledOutputPosition: { recovery: "final" } } },
    } })
    await entered.promise
    const project = createViewProjection()
    assert.deepEqual(project(session).settledOutputPosition, { recovery: "final" })
    gate.resolve()
    await settle()
    assert.equal(project(session).settledOutputPosition, null)
    assert.equal(session.transcript?.view.blocks[0]?.kind, "text")
    assert.equal(session.transcript?.settledOutputRecovery, "final")
  } finally { gate.resolve(); session.dispose() }
})

test("only the client missing final public output recovers a numeric idle barrier", async () => {
  const gate = Promise.withResolvers<void>()
  const mounted = mountActivityStatus({
    sessionId: "cold-chat", activity: "generating", transcriptAvailable: true, atTail: true,
    settledOutputPosition: null, appliedOutputPosition: 0, transcriptText: "Old answer",
  })
  const status: StatusView = { activity: "generating", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: false, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [] }
  const clients = [false, true].map((losesOutput) => {
    const base = selectionConnection()
    const listeners = new Set<(event: FrontendEvent) => void>()
    let reads = 0
    const query = runtimeQuery({
      statusSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map(sessionId => ({ sessionId, view: status })) }),
      outputWindow: async () => {
        const recovering = ++reads > 1
        if (recovering) await gate.promise
        return { snapshotPosition: recovering ? 1 : 0, totalBlocks: 1, visibleMessageCount: 1, range: {
          kind: "ok", consistencyToken: "fixture", anchor: { kind: "tail" }, streamingToolText: {}, streamingOutputChars: 0,
          blocks: [{ kind: "text", id: "answer", content: recovering ? "Final answer" : "Old answer", timestamp: 0 }],
          window: { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, contentBytes: 0 },
        } }
      },
    }, base.query)
    const session = createRuntimeSession({ connection: {
      ...base, query,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    } })
    return { session, losesOutput, reads: () => reads, emit: (event: FrontendEvent) => { for (const listener of listeners) listener(event) } }
  })
  try {
    await settle()
    for (const client of clients) await client.session.select("cold-chat")
    await settle()
    for (const client of clients) {
      if (!client.losesOutput) client.emit({ type: "patch", patch: {
        cursor: { scope: "session", domain: "output", sessionId: "cold-chat" }, position: 1, prevPosition: 0,
        payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [
          { kind: "upsert", index: 0, blockId: "text:answer", block: { kind: "text", id: "answer", content: "Final answer", timestamp: 0 } },
        ] } },
      } })
      client.emit({ type: "patch", patch: {
        cursor: { scope: "session", domain: "status", sessionId: "cold-chat" }, position: 2, prevPosition: 0,
        payload: { kind: "status.updated", status: { ...status, activity: "idle", settledOutputPosition: 1 } },
      } })
    }
    await settle()
    assert.deepEqual(clients.map(client => client.reads()), [1, 2])
    assert.equal(clients[1]!.session.transcript?.view.appliedOutputPosition, null)
    const renderLagging = () => {
      const session = clients[1]!.session
      const view = createViewProjection()(session)
      const block = session.transcript?.view.blocks[0]
      mounted.setFrame({
        sessionId: session.sessionId, activity: "idle", transcriptAvailable: true, atTail: true,
        settledOutputPosition: view.settledOutputPosition,
        appliedOutputPosition: session.transcript?.view.appliedOutputPosition ?? null,
        transcriptText: block?.kind === "text" ? block.content : "",
      })
    }
    renderLagging()
    assert.equal(mounted.text(), "Old answerGenerating…")
    assert.equal(mounted.pendingFrames(), 0)
    gate.resolve()
    await settle()
    for (const { session } of clients) {
      assert.deepEqual(session.transcript?.view.blocks, [{ kind: "text", id: "answer", content: "Final answer", timestamp: 0 }])
      assert.equal(session.transcript?.view.appliedOutputPosition, 1)
      assert.equal(createViewProjection()(session).settledOutputPosition, 1)
    }
    renderLagging()
    assert.equal(mounted.text(), "Final answerGenerating…")
    mounted.flushFrame()
    assert.equal(mounted.statusExiting(), false)
    mounted.flushFrame()
    assert.equal(mounted.statusExiting(), true)
  } finally { gate.resolve(); for (const client of clients) client.session.dispose(); mounted.dispose() }
})

test("Changes control stays neutral while review errors remain in controller state", () => {
  assert.equal(changesLabel(undefined), "Changes")
  assert.equal(changesLabel({ status: "loading" }), "Changes")
  assert.equal(changesLabel({ status: "error", error: "disconnected" }), "Changes")
  assert.equal(changesLabel({ status: "ready", data: { fileCount: 0, unknownFileMutationGaps: 0, snapshotPosition: 0 } }), "0 changed")
})

test("Changes keeps its last known count while a reconnect reads it again", () => {
  const data = { fileCount: 3, unknownFileMutationGaps: 0, snapshotPosition: 4 }
  assert.equal(changesLabel({ status: "loading", data }), "3 changed")
  assert.equal(changesLabel({ status: "stale", data }), "3 changed")
})

test("each resident session keeps its own Changes across a switch, a return reads nothing, and disposal retires them", async () => {
  const reads: string[] = []
  const base = selectionConnection()
  const changes = {
    status: "ready", cursor: "0".repeat(64), offset: 0, nextOffset: null, totalFiles: 0,
    revision: 0, unknownFileMutationGaps: 0, executionCwd: "/work", files: [], excludedFileCount: 0,
  } satisfies SessionChangesResult
  const query = runtimeQuery({
    sessionChangeSummary: async (request) => {
      reads.push(request.sessionId)
      return { fileCount: 71, unknownFileMutationGaps: 0, snapshotPosition: 0 }
    },
    sessionChanges: async () => changes,
  }, base.query)
  const connection: RuntimeConnection = { ...base, query }
  const session = createRuntimeSession({ connection })
  await settle()
  await session.select("cold-chat")
  await settle()
  assert.equal(session.changes?.sessionId, "cold-chat")
  assert.deepEqual(createViewProjection()(session).changes?.summary, {
    status: "ready", data: { fileCount: 71, unknownFileMutationGaps: 0, snapshotPosition: 0 },
  })
  const previous = session.changes!
  await previous.openReview()
  assert.deepEqual(createViewProjection()(session).changes?.summary, {
    status: "ready", data: { fileCount: 71, unknownFileMutationGaps: 0, snapshotPosition: 0 },
  })
  assert.deepEqual(previous.snapshot.list, { status: "ready", data: changes })
  await session.select("cold-workflow")
  await settle()
  assert.notEqual(session.changes, previous)
  assert.equal(session.changes?.sessionId, "cold-workflow")
  const before = reads.length
  await session.select("cold-chat")
  await settle()
  assert.equal(session.changes, previous)
  assert.equal(reads.length, before)
  session.dispose()
  await previous.refresh()
  assert.equal(reads.length, before)
})

test("status invalidation refreshes the exact unselected session", async () => {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const reads: string[] = []
  const base = fakeConnection([])
  const query = runtimeQuery({
    statusSnapshot: async (request) => {
      reads.push(...request.sessionIds)
      return { snapshotPosition: 3, views: request.sessionIds.map((sessionId) => ({ sessionId, view: statusView("idle") })) }
    },
    // The page lists the session idle and opens another one, so only the
    // invalidation reads its status.
    snapshot: async () => ({
      rows: ["open", "unselected"].map((id): SessionCatalogRow => ({ id, kind: "chat", title: id, lifecycleState: "inactive", inputMode: { kind: "chat" }, notices: [], lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/workspace", totalsLoading: true })),
      activeRuntimeCount: 0, errors: [], snapshotPosition: 0, projectRoot: "/workspace", runtimeVersion: "test", runtimeBuildId: null,
      chatDefault: { kind: "pending" }, executor: { kind: "serving" }, service: { kind: "serving" },
    }),
  }, base.query)
  const connection: RuntimeConnection = {
    ...base,
    query,
    subscribe(next) { listeners.add(next); return () => { listeners.delete(next) } },
  }
  const session = createRuntimeSession({ connection })
  await settle()
  const event: FrontendEvent = {
    type: "patch",
    patch: {
      cursor: { scope: "session", domain: "status", sessionId: "unselected" },
      position: 3, prevPosition: 2, payload: { kind: "runtime.invalidate", reason: "overflow" },
    },
  }
  for (const listener of listeners) listener(event)
  await settle()
  assert.deepEqual(reads.filter((id) => id !== "open"), ["unselected"])
  assert.equal(session.statuses.get("unselected")?.activity, "idle")
  session.dispose()
})

test("catalog metadata errors remain separate from healthy sessions", async () => {
  const error = { sessionId: "unreadable-session", scope: "metadata" as const, reason: "invalid metadata" }
  const session = createRuntimeSession({ connection: selectionConnection([error]) })
  await settle()

  assert.deepEqual(session.sessions.map(({ id }) => id), ["cold-chat"])
  assert.deepEqual(session.sessionErrors, [error])
  session.dispose()
})


test("a session control the runtime refuses says why instead of doing nothing", async () => {
  const commands: unknown[] = []
  const refuse = async () => ({ ok: false as const, error: "the runtime refused" })
  const dispatch = recordedDispatch((command) => { commands.push(command) }, runtimeDispatch({
    "session.rename": refuse, "session.close": refuse, "session.reorder": refuse, "session.dismiss_notice": refuse,
  }))
  const connection: RuntimeConnection = { ...fakeConnection([]), dispatch }
  const session = createRuntimeSession({ connection })
  try {
    await settle()
    await assert.rejects(session.rename("chat", { title: "Plans" }), /the runtime refused/)
    await assert.rejects(session.rename("chat", { shortTitle: "Tab only" }), /the runtime refused/)
    assert.deepEqual(commands.slice(0, 2), [{ type: "session.rename", sessionId: "chat", title: "Plans" }, { type: "session.rename", sessionId: "chat", shortTitle: "Tab only" }])
    await assert.rejects(session.close("chat"), /the runtime refused/)
    await assert.rejects(session.reorder("chat", null), /the runtime refused/)
    await assert.rejects(session.dismissNotice("chat", "runtime.notice"), /the runtime refused/)
  } finally { session.dispose() }
})
