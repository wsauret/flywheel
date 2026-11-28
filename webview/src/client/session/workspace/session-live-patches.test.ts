import assert from "node:assert/strict"
import { test } from "node:test"
import type { FrontendEvent, SessionCatalogRow } from "../../../../../src/protocol/runtime/app-service-types.js"
import type { RuntimeConnection } from "../../../../../src/protocol/client/runtime/connection.js"
import { createRuntimeSession } from "../session.js"
import { createViewProjection } from "../view-state.js"
import { layoutSessionRows } from "../../../app/sessions/session-rows.js"
import { fakeConnection, settle } from "../../../test-support/session-connection-fixture.js"
import { statusView } from "../../../../../tests/helpers/runtime-views.js"
import { recordedQuery, runtimeQuery } from "../../../../../tests/helpers/runtime-dispatch.js"

/** Detail reads follow membership, not every patch.
 *
 *  A streaming chat republishes its catalog row as its readings move. Reading
 *  every live session's status and question on each of those, over a sealed
 *  channel from a phone, was a burst of round trips the list learned nothing
 *  from. Questions arrive as patches of their own. */
interface FanOutConnection extends RuntimeConnection {
  readonly reads: (type: string) => number
  readonly deliver: (event: FrontendEvent) => void
}

const LIVE_ROW: SessionCatalogRow = { id: "live", kind: "chat", title: "Live", lifecycleState: "active", activity: "generating", inputMode: { kind: "chat" }, lastUpdated: "2026-01-01T00:00:00.000Z", notices: [], executionCwd: "/project", totalsLoading: true }

function fanOutConnection(): FanOutConnection {
  const reads = new Map<string, number>()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const base = fakeConnection([])
  const answer = runtimeQuery({
    snapshot: async () => ({ rows: [LIVE_ROW], activeRuntimeCount: 1, errors: [], snapshotPosition: 0, projectRoot: "/project", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }),
    statusSnapshot: async () => ({ snapshotPosition: 0, views: [{ sessionId: "live", view: statusView("generating") }] }),
    questionSnapshot: async () => ({ snapshotPosition: 0, views: [] }),
  }, base.query)
  const query = recordedQuery((request) => { reads.set(request.type, (reads.get(request.type) ?? 0) + 1) }, answer)
  return {
    ...base,
    reads: (type: string) => reads.get(type) ?? 0,
    deliver: (event) => { for (const listener of listeners) listener(event) },
    query,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

test("a streaming chat's row patch does not re-read every session's detail", async () => {
  const connection = fanOutConnection()
  const session = createRuntimeSession({ connection })
  await settle()
  await settle()
  const before = connection.reads("statusSnapshot")
  assert.ok(before >= 1)
  const row: SessionCatalogRow = { ...LIVE_ROW, totalsLoading: false, totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalTokens: 500, contextPercent: 0, contextPromptTokens: 0, durationMs: 0 }
  connection.deliver({ type: "patch", patch: { cursor: { scope: "session", domain: "session", sessionId: "live" }, position: 1, prevPosition: 0, payload: { kind: "session.updated", row } } })
  await settle()
  assert.equal(session.sessions[0]?.totalTokens, 500)
  assert.equal(connection.reads("statusSnapshot"), before)
  assert.equal(connection.reads("questionSnapshot"), before)
  session.dispose()
})

test("a question patch marks the row as waiting and its removal clears it", async () => {
  const connection = fanOutConnection()
  const session = createRuntimeSession({ connection })
  await settle()
  await settle()
  assert.equal(session.pendingQuestions.has("live"), false)
  connection.deliver({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: "live" }, position: 1, prevPosition: 0, payload: { kind: "question.updated", question: { kind: "question", toolUseId: "q1", questions: [], timestamp: 100 } } } })
  assert.equal(session.pendingQuestions.has("live"), true)
  connection.deliver({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: "live" }, position: 2, prevPosition: 1, payload: { kind: "question.removed" } } })
  assert.equal(session.pendingQuestions.has("live"), false)
  session.dispose()
})

test("closed chats that wait on a question or stopped unread are in Needs you, from the project's sets alone, and the sets' patches apply with no read", async () => {
  const closed: SessionCatalogRow = { ...LIVE_ROW, id: "closed", title: "Closed", lifecycleState: "inactive", activity: "absent", lastUpdated: "2025-12-01T00:00:00.000Z" }
  const done: SessionCatalogRow = { ...closed, id: "done", title: "Done", lastUpdated: "2025-11-01T00:00:00.000Z" }
  const stop = { sessionId: "done", ending: { kind: "completed" }, firstLine: "All set", stoppedAt: 5, stopKey: "entry-done" } as const
  const reads = new Map<string, number>()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const waiting = [{ sessionId: "closed", openedAt: 1 }, { sessionId: "deleted", openedAt: 2 }]
  const base = fakeConnection([])
  const connection: RuntimeConnection = {
    ...base,
    query: recordedQuery((request) => { reads.set(request.type, (reads.get(request.type) ?? 0) + 1) }, runtimeQuery({
      snapshot: async () => ({ rows: [LIVE_ROW, closed, done], activeRuntimeCount: 1, errors: [], snapshotPosition: 0, projectRoot: "/project", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }),
      statusSnapshot: async () => ({ snapshotPosition: 0, views: [{ sessionId: "live", view: statusView("generating") }] }),
      questionSnapshot: async () => ({ snapshotPosition: 0, views: [] }),
      waitingSessionsSnapshot: async () => ({ snapshotPosition: 0, sessions: waiting }),
      unreadChatsSnapshot: async () => ({ snapshotPosition: 0, stopped: [stop], unread: ["live"], turns: {} }),
    }, base.query)),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const session = createRuntimeSession({ connection })
  await settle()
  await settle()
  const project = createViewProjection()
  const rows = () => { const frame = project(session); return layoutSessionRows(frame.sessions, frame.needsYou, frame.turns, true, []).map((row) => [row.session.id, row.group, row.need ?? (row.unread ? "unread" : "")]) }
  // A session in the set that the catalog does not list, such as a deleted
  // one or a subagent, shows nowhere.
  assert.deepEqual(rows(), [["closed", "Needs you", "question"], ["done", "Needs you", "stopped"], ["live", "Working", "unread"]])
  assert.equal(project(session).needsYou.count, 2)
  assert.equal(session.pendingQuestions.has("closed"), false)
  // A patch carries the whole set, so the list adopts it without a read.
  for (const listener of listeners) listener({ type: "patch", patch: { cursor: { scope: "workspace", domain: "waitingSessions" }, position: 1, prevPosition: 0, payload: { kind: "waitingSessions.changed", sessions: [] } } })
  await settle()
  assert.deepEqual(rows(), [["done", "Needs you", "stopped"], ["live", "Working", "unread"], ["closed", "Recent", ""]])
  for (const listener of listeners) listener({ type: "patch", patch: { cursor: { scope: "workspace", domain: "unreadChats" }, position: 1, prevPosition: 0, payload: { kind: "unreadChats.changed", places: { stopped: [], unread: [] }, turns: {}, newStops: [] } } })
  await settle()
  assert.deepEqual(rows(), [["live", "Working", ""], ["closed", "Recent", ""], ["done", "Recent", ""]])
  assert.equal(project(session).needsYou.count, 0)
  assert.equal(session.unreadChats?.stopped.length, 0)
  assert.equal(reads.get("waitingSessionsSnapshot"), 1)
  assert.equal(reads.get("unreadChatsSnapshot"), 1)
  session.dispose()
})

/** A session whose unread set answers when `answer` settles, beside one
 *  closed chat that waits on a question and two quiet chats. */
async function heldList(answer: Promise<{ readonly turns: { readonly [sessionId: string]: number } }>) {
  const asks: SessionCatalogRow = { ...LIVE_ROW, id: "asks", title: "Asks", lifecycleState: "inactive", activity: "absent", createdAt: "2025-10-01T00:00:00.000Z" }
  const older: SessionCatalogRow = { ...asks, id: "older", title: "Older", createdAt: "2025-11-01T00:00:00.000Z" }
  const newer: SessionCatalogRow = { ...asks, id: "newer", title: "Newer", createdAt: "2025-12-01T00:00:00.000Z" }
  const base = fakeConnection([])
  const connection: RuntimeConnection = {
    ...base,
    query: runtimeQuery({
      snapshot: async () => ({ rows: [asks, older, newer], activeRuntimeCount: 0, errors: [], snapshotPosition: 0, projectRoot: "/project", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }),
      statusSnapshot: async () => ({ snapshotPosition: 0, views: [] }),
      questionSnapshot: async () => ({ snapshotPosition: 0, views: [] }),
      waitingSessionsSnapshot: async () => ({ snapshotPosition: 0, sessions: [{ sessionId: "asks", openedAt: 1 }] }),
      unreadChatsSnapshot: async () => ({ snapshotPosition: 0, stopped: [], unread: [], ...await answer }),
    }, base.query),
  }
  const session = createRuntimeSession({ connection })
  await settle()
  await settle()
  const project = createViewProjection()
  const rows = () => { const frame = project(session); return layoutSessionRows(frame.sessions, frame.needsYou, frame.turns, true, []).map((row) => [row.session.id, row.group]) }
  return { session, rows }
}

test("rows show at once by when each chat was created, and take the order of the latest turn times when they arrive", async () => {
  const answer = Promise.withResolvers<{ readonly turns: { readonly [sessionId: string]: number } }>()
  const { session, rows } = await heldList(answer.promise)
  assert.deepEqual(rows(), [["asks", "Needs you"], ["newer", "Recent"], ["older", "Recent"]])
  // The newest turn is the older chat's, so it leads Recent.
  answer.resolve({ turns: { older: 20, newer: 10 } })
  await settle()
  await settle()
  assert.deepEqual(rows(), [["asks", "Needs you"], ["older", "Recent"], ["newer", "Recent"]])
  session.dispose()
})

test("a failed read of the latest turn times shows every row at once, ordered by when each chat was created", async () => {
  const { session, rows } = await heldList(Promise.reject(new Error("refused")))
  await settle()
  assert.deepEqual(rows(), [["asks", "Needs you"], ["newer", "Recent"], ["older", "Recent"]])
  session.dispose()
})
