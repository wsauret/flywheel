import type { SessionRow } from "../../../src/protocol/app-service-types.js"
import type { BudgetSummary } from "../../../src/protocol/client/host-contract.js"
import { budgetCursor, isBudgetPayload, type BudgetView } from "../../../src/protocol/budget-protocol-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { mergeBudgetView } from "../../../src/protocol/client/known-totals.js"
import { createSessionReadingFamily, type SessionViewStore } from "../../../src/protocol/client/session-reading-family.js"
import { isStatusPayload, statusCursor, type StatusView } from "../../../src/protocol/status-protocol-types.js"
import { isQuestionPayload, questionCursor, type PendingQuestionView } from "../../../src/protocol/question-protocol-types.js"

/** Status, budget, and question readings follow every live catalog row,
 *  every held child, the selection, which no list may name yet, and every
 *  child whose card watches its status. They reach every client whichever
 *  session it shows, so a return to a session shows its known budget in the
 *  tap and reads nothing for it. The shared reading family decides every
 *  read: it reads each followed session once on each lane, reads what it
 *  follows in one batch per domain, orders each read against its live
 *  patches, and keeps the visible readings across a reconnect without
 *  depending on catalog changes. The question reading is the durable question
 *  projection, which every settlement path advances, so the dock never waits
 *  on a transcript patch that may never come (ARCH-PROTOCOL-068). */
export function createSessionReadings(options: {
  readonly connection: RuntimeConnection
  readonly changed: () => void
}) {
  const { connection, changed } = options
  let statuses: ReadonlyMap<string, StatusView> = new Map()
  let budgets: ReadonlyMap<string, BudgetView> = new Map()
  let selected: string | undefined
  let pendingQuestions: ReadonlyMap<string, PendingQuestionView> = new Map()
  /** The sessions the last reconcile admitted: listed rows and held children. */
  let admitted: ReadonlySet<string> = new Set()
  /** The status listeners of the cards on screen, by the child each watches. */
  const watchers = new Map<string, Set<(view: StatusView | undefined) => void>>()
  let disposed = false
  /** A session whose readings this page follows: an admitted one, the
   *  selected one, which no list may name yet, such as a chat just created,
   *  or a child whose card watches it. The bus broadcasts the readings of
   *  every running session, unopened children among them; any other session
   *  costs nothing here. */
  const follows = (sessionId: string): boolean => admitted.has(sessionId) || sessionId === selected || watchers.has(sessionId)

  function put<View>(views: ReadonlyMap<string, View>, sessionId: string, value: View | undefined): ReadonlyMap<string, View> {
    const next = new Map(views)
    if (value === undefined) next.delete(sessionId); else next.set(sessionId, value)
    return next
  }
  function putStatus(sessionId: string, value: StatusView | undefined): void {
    statuses = put(statuses, sessionId, value)
    for (const listener of watchers.get(sessionId) ?? []) listener(value)
  }
  const statusViews: SessionViewStore<StatusView> = {
    get: (sessionId) => statuses.get(sessionId),
    set: putStatus,
    delete: (sessionId) => { putStatus(sessionId, undefined) },
    keys: () => statuses.keys(),
  }
  const budgetViews: SessionViewStore<BudgetView> = {
    get: (sessionId) => budgets.get(sessionId),
    set: (sessionId, view) => { budgets = put(budgets, sessionId, view) },
    delete: (sessionId) => { budgets = put(budgets, sessionId, undefined) },
    keys: () => budgets.keys(),
  }
  const questionViews: SessionViewStore<PendingQuestionView> = {
    get: (sessionId) => pendingQuestions.get(sessionId),
    set: (sessionId, view) => { pendingQuestions = put(pendingQuestions, sessionId, view) },
    delete: (sessionId) => { pendingQuestions = put(pendingQuestions, sessionId, undefined) },
    keys: () => pendingQuestions.keys(),
  }

  const status = createSessionReadingFamily({
    domain: "status",
    cursor: statusCursor,
    client: connection,
    query: (sessionIds) => disposed || !sessionIds.some(follows) ? Promise.resolve({ snapshotPosition: 0, views: [] }) : connection.query({ type: "statusSnapshot", sessionIds: sessionIds.filter(follows) }),
    isPayload: isStatusPayload,
    payloadView: (payload) => (payload.kind === "status.updated" ? payload.status : null),
    admits: follows,
    views: statusViews,
    changed,
  })
  const budget = createSessionReadingFamily({
    domain: "budget",
    cursor: budgetCursor,
    client: connection,
    query: (sessionIds) => disposed || !sessionIds.some(follows) ? Promise.resolve({ snapshotPosition: 0, views: [] }) : connection.query({ type: "budgetSnapshot", sessionIds: sessionIds.filter(follows) }),
    isPayload: isBudgetPayload,
    payloadView: (payload) => (payload.kind === "budget.updated" ? payload.budget : null),
    settle: mergeBudgetView,
    admits: follows,
    views: budgetViews,
    changed,
  })
  const question = createSessionReadingFamily({
    domain: "question",
    cursor: questionCursor,
    client: connection,
    query: (sessionIds) => disposed || !sessionIds.some(follows) ? Promise.resolve({ snapshotPosition: 0, views: [] }) : connection.query({ type: "questionSnapshot", sessionIds: sessionIds.filter(follows) }),
    isPayload: isQuestionPayload,
    payloadView: (payload) => (payload.kind === "question.updated" ? payload.question : null),
    admits: follows,
    views: questionViews,
    changed,
  })
  const families = [status, budget, question]

  function follow(sessionIds: readonly string[]): void {
    for (const family of families) family.ensure(sessionIds)
  }

  function retire(sessionId: string): void {
    for (const family of families) family.retire(sessionId)
  }

  return {
    get statuses() { return statuses },
    /** The known budget of every followed session, by id. */
    get budgets() { return budgets },
    /** The question each session waits on, by id. */
    get pendingQuestions() { return pendingQuestions },
    /** Admit live rows without re-reading unchanged rows; retire removed owners. */
    reconcile(rows: readonly SessionRow[]): void {
      if (disposed) return
      admitted = new Set(rows.map((row) => row.id))
      for (const id of new Set(families.flatMap((family) => family.sessionIds()))) if (!follows(id)) retire(id)
      follow(rows.flatMap((row) => row.lifecycleState === "active" ? [row.id] : []))
    },
    /** Follows the selection, which no list may name yet. The readings of the
     *  session left stay while a list names it, so a return shows them. */
    select(sessionId: string | undefined): void {
      if (disposed) return
      const left = selected
      selected = sessionId
      if (left !== undefined && left !== sessionId && !follows(left)) retire(left)
      if (sessionId !== undefined) follow([sessionId])
    },
    /** Follows the status of a session while a card shows it, and tells the
     *  listener each reading. The last release stops following it, unless a
     *  list, a hold, or the selection still follows it. */
    subscribeStatus(sessionId: string, listener: (view: StatusView | undefined) => void): () => void {
      if (disposed) return () => {}
      const listeners = watchers.get(sessionId) ?? new Set()
      watchers.set(sessionId, listeners)
      listeners.add(listener)
      follow([sessionId])
      listener(statuses.get(sessionId))
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || watchers.get(sessionId) !== listeners) return
        watchers.delete(sessionId)
        if (!disposed && !follows(sessionId)) retire(sessionId)
      }
    },
    /** Reads the session's activity again after an explicit send, interrupt,
     *  or selection. */
    refreshStatus(sessionId: string | undefined): void {
      if (disposed || sessionId === undefined) return
      status.refresh([sessionId])
    },
    /** Returns the selected session's known totals with the workspace threshold. */
    budgetSummary(compactionThreshold: number): BudgetSummary | undefined {
      const known = selected === undefined ? undefined : budgets.get(selected)
      if (known === undefined) return undefined
      if (known.totalsLoading) return { totalsLoading: true, compactionThreshold }
      const { tokens, ...summary } = known
      return { ...summary, totalTokens: tokens, compactionThreshold }
    },
    dispose(): void {
      disposed = true
      for (const family of families) family.dispose()
      watchers.clear()
    },
  }
}
