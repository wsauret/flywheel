import type { ChildSessionRow, FrontendActivity, FrontendEvent, FrontendMutation, SessionCatalogError, SessionRow } from "../../../src/protocol/app-service-types.js"
import type { BudgetView } from "../../../src/protocol/budget-protocol-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { RuntimeUiPatch } from "../../../src/protocol/runtime-ui-protocol-types.js"
import type { RuntimeSession } from "./session.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"
import { detailView, statusView } from "../../../tests/helpers/runtime-views.js"
import { authView, CONNECTED_PROVIDER, type Provider } from "./session-connection-fixture.js"

const BUDGET: BudgetView = { totalsLoading: false, tokens: 100, contextPromptTokens: 50, cost: 1.25, billedCost: 0.5, priceUnavailable: true, contextPercent: 10 }

/** A runtime with one listed chat and its workflow-agent and subagent children. */
interface SelectionConnection extends RuntimeConnection {
  readonly dispatched: readonly FrontendMutation[]
  readonly clearDispatched: () => void
  /** Session ids read through `sessionDetail`, in order. */
  readonly detailReads: readonly string[]
  /** Publishes one status patch for a session, as the runtime would. */
  readonly publishStatus: (sessionId: string, activity: FrontendActivity) => void
  readonly publishCatalog: () => void
}

export function selectionConnection(errors: readonly SessionCatalogError[] = [], sendError?: string, beforeDetail?: (sessionId: string) => Promise<void>, providers: readonly Provider[] = [CONNECTED_PROVIDER]): SelectionConnection {
  const dispatched: FrontendMutation[] = []
  const rows: SessionRow[] = [
    {
      id: "cold-chat",
      kind: "chat",
      title: "Cold chat",
      shortTitle: "Cold chat",
      lifecycleState: "inactive",
      activity: "idle",
      inputMode: { kind: "chat" },
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
      notices: [],
      executionCwd: "/workspace",
      totalsLoading: true,
    },
    {
      id: "cold-workflow",
      kind: "workflow-agent",
      workflowMembership: { kind: "attempt", workflowId: "workflow", attemptId: "attempt" },
      title: "Cold workflow agent",
      shortTitle: "Cold workflow agent",
      lifecycleState: "inactive",
      activity: "idle",
      inputMode: { kind: "message" },
      admittedActions: ["session.send", "chat.interrupt", "session.delete"],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
      parentSessionId: "cold-chat",
      notices: [],
      executionCwd: "/workspace",
      totalsLoading: true,
    },
  ]
  // A child is never a catalog row (ARCH-PROTOCOL-048): the client reads it through
  // sessionDetail, whose admitted actions follow the child's activity.
  let childActivity: FrontendActivity = "generating"
  const childRow = (): ChildSessionRow => ({
    id: "cold-subagent", kind: "subagent", title: "Cold subagent", shortTitle: "Cold subagent", lifecycleState: "active", activity: childActivity,
    inputMode: { kind: "message" }, admittedActions: childActivity === "idle" ? ["session.delete"] : ["session.send", "subagent.interrupt", "background.terminate", "session.delete"],
    parentToolUseId: "subagent-tool",
    createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", parentSessionId: "cold-workflow", notices: [], executionCwd: "/workspace", totalsLoading: true,
  })
  let deleted = false
  const detailReads: string[] = []
  const listeners = new Set<(event: FrontendEvent) => void>()
  let position = 0
  const publish = (patch: RuntimeUiPatch) => { for (const listener of listeners) listener({ type: "patch", patch }) }
  const base = fakeRuntimeConnection()

  // Every other read stays unanswered, as a runtime still loading it leaves
  // it: no session shows a failure the selection tests do not stage.
  const query = runtimeQuery({
    snapshot: async () => ({
      rows: rows.filter(row => row.kind === "chat"), activeRuntimeCount: 0, errors, snapshotPosition: 0, projectRoot: "/workspace",
      runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "pending" }, executor: { kind: "serving" }, service: { kind: "serving" },
    }),
    sessionDetailSnapshot: async (request) => {
      for (const id of request.sessionIds) await beforeDetail?.(id)
      return { snapshotPosition: position, views: request.sessionIds.map(sessionId => {
        detailReads.push(sessionId)
        const row = sessionId === "cold-subagent" && !deleted ? childRow() : rows.find(candidate => candidate.id === sessionId)
        return { sessionId, view: row ? detailView(row, "conv") : null }
      }) }
    },
    authStatusSnapshot: async () => ({ snapshotPosition: 0, auth: authView(providers) }),
    budgetSnapshot: async () => ({ snapshotPosition: 0, views: rows.map((row) => ({ sessionId: row.id, view: BUDGET })) }),
  }, () => new Promise<never>(() => {}))

  const acknowledge = async () => ({ ok: true as const })
  const dispatch = recordedDispatch((command) => { dispatched.push(command) }, runtimeDispatch({
    "session.send": async (command) => command.sessionId === "cold-workflow" && sendError ? { ok: false, error: sendError } : { ok: true },
    "session.delete": async (command) => {
      const index = rows.findIndex((row) => row.id === command.sessionId)
      if (index >= 0) rows.splice(index, 1)
      if (command.sessionId === "cold-subagent") deleted = true
      return { ok: true }
    },
    "session.activate": acknowledge, "session.release": acknowledge, "session_detail.release": acknowledge,
    "chat.interrupt": acknowledge, "background.terminate": acknowledge,
  }))

  return {
    ...base,
    dispatched,
    detailReads,
    clearDispatched: () => { dispatched.length = 0 },
    publishCatalog() {
      const row = rows[0]
      if (row?.kind !== "chat") return
      publish({ cursor: { scope: "session", domain: "session", sessionId: "cold-chat" }, position: ++position, prevPosition: 0, payload: { kind: "session.updated", row } })
    },
    publishStatus(sessionId: string, activity: FrontendActivity) {
      if (sessionId === "cold-subagent") childActivity = activity
      const index = rows.findIndex(row => row.id === "cold-workflow")
      const listed = rows[index]
      if (sessionId === "cold-workflow" && listed?.kind === "workflow-agent") {
        rows[index] = { ...listed, activity, admittedActions: activity === "idle" ? ["session.delete"] : ["session.send", "chat.interrupt", "session.delete"] }
      }
      const workflow = rows.find(row => row.id === "cold-workflow")
      publish({ cursor: { scope: "session", domain: "status", sessionId }, position: ++position, prevPosition: position - 1, payload: { kind: "status.updated", status: statusView(activity) } })
      publish({
        cursor: { scope: "session", domain: "session_detail", sessionId },
        position, prevPosition: position - 1, payload: { kind: "session_detail.changed", row: sessionId === "cold-workflow" ? workflow ?? null : childRow() },
      })
    },
    query,
    dispatch,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

export async function waitForSelection(session: RuntimeSession, id: string): Promise<void> {
  if (session.sessionId === id) return
  await new Promise<void>(resolve => {
    const release = session.onChange(() => {
      if (session.sessionId !== id) return
      release()
      resolve()
    })
  })
}
