import type { ChildSessionRow, FrontendEvent } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { RuntimeSessionDetailSnapshotResult } from "../../../src/protocol/session-detail-protocol-types.js"
import { runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"
import { createRuntimeSession } from "../client/session.js"
import { selectionConnection } from "../client/session-selection-fixture.js"
import { detailView } from "../../../tests/helpers/runtime-views.js"
import { fakeClient, fakeClientActions } from "./client-context-fixture.js"

/** A real held-detail owner behind a scripted transport for mounted cards. */
export function agentGroupClient(admittedActions: readonly ("subagent.interrupt" | "subagent.resume")[], failDetail: boolean) {
  const mutations: unknown[] = []
  const failures: unknown[] = []
  const detailReads: string[] = []
  let failNextDetail = failDetail
  let actions = admittedActions
  let position = 0
  const base = selectionConnection()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const control = async (mutation: unknown) => { mutations.push(mutation); return { ok: true as const } }
  const row = (): ChildSessionRow => ({
    id: "child", kind: "subagent", admittedActions: actions, parentSessionId: "cold-chat",
    title: "Child", shortTitle: "Child", lifecycleState: "active", notices: [],
    createdAt: "2026-01-01T00:00:00Z", lastUpdated: "2026-01-01T00:00:00Z",
    executionCwd: "/workspace", inputMode: { kind: "message" }, totalsLoading: true,
    parentToolUseId: "dispatch",
  })
  const connection: RuntimeConnection = {
    ...base,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    query: runtimeQuery({ sessionDetailSnapshot: async (request) => {
      detailReads.push(...request.sessionIds)
      if (failNextDetail) { failNextDetail = false; throw new Error("detail unavailable") }
      const snapshot: RuntimeSessionDetailSnapshotResult = { snapshotPosition: position, views: request.sessionIds.map(sessionId => ({
        sessionId, view: detailView(row()),
      })) }
      return snapshot
    } }, base.query),
    dispatch: runtimeDispatch({
      "session_detail.release": async () => ({ ok: true }),
      "subagent.interrupt": control, "subagent.resume": control,
    }),
  }
  const session = createRuntimeSession({ connection, initialNewChat: true })
  const client = fakeClient({
    connection,
    sessionDetails: { get: session.sessionDetail, subscribe: session.subscribeSessionDetail },
    report(_severity, message) { failures.push(message) },
    actions: fakeClientActions({ async run(_key, work) { try { await work(); return true } catch (cause) { failures.push(cause); return false } } }, session, connection),
  })
  return {
    client, mutations, failures, detailReads,
    dispose: () => session.dispose(),
    heldDetails: () => session.children.length,
    replaceAdmission(next: typeof admittedActions) {
      actions = next
      const prevPosition = position++
      const event: FrontendEvent = { type: "patch", patch: {
        cursor: { scope: "session", domain: "session_detail", sessionId: "child" },
        position, prevPosition, payload: { kind: "session_detail.changed", row: row() },
      } }
      for (const listener of listeners) listener(event)
    },
  }
}
