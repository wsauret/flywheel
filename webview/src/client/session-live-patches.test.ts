import assert from "node:assert/strict"
import { test } from "node:test"
import type { FrontendEvent, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createRuntimeSession } from "./session.js"
import { fakeConnection, settle } from "./session-connection-fixture.js"
import { statusView } from "../../../tests/helpers/runtime-views.js"
import { recordedQuery, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

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
