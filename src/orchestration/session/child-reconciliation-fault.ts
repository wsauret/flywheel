import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { SessionNoticeOperation } from "../../infra/session-notice.js"

const log = Log.create({ service: "child-session-reconciliation" })

/** The one notice of a parent whose finished children cannot report back. */
export const CHILD_RESULTS_NOTICE_SCOPE = "child-results"

/** Takes a session notice for the session it names. */
export type ChildResultNoticeSink = (parentSessionId: string, operation: SessionNoticeOperation) => void

interface FaultBook {
  /** Each parent whose last sweep failed, with the count of failed sweeps since its last success. */
  readonly failures: Map<string, number>
  sink?: ChildResultNoticeSink
  readonly retries: Map<string, ReturnType<typeof setTimeout>>
  retryFirstMs: number
}

const books = new WeakMap<AsyncEventStateReadSurface, FaultBook>()

function book(store: AsyncEventStateReadSurface): FaultBook {
  const existing = books.get(store)
  if (existing) return existing
  const created: FaultBook = { failures: new Map(), retries: new Map(), retryFirstMs: 1_000 }
  books.set(store, created)
  return created
}

/** Routes the fault notices of one store's completion sweeps to the sessions
 *  that own the parents. The composition that holds the session store
 *  registers the sink once; the returned function removes it. */
export function routeChildResultNotices(store: AsyncEventStateReadSurface, sink: ChildResultNoticeSink, retryFirstMs = 1_000): () => void {
  const target = book(store)
  target.sink = sink
  target.retryFirstMs = retryFirstMs
  return () => {
    if (target.sink !== sink) return
    delete target.sink
    for (const timer of target.retries.values()) clearTimeout(timer)
    target.retries.clear()
  }
}

/** Re-drives retained completion evidence while the project composition owns
 * the reader. Teardown cancels only the timer; recovery reads the same facts. */
export function retryChildResults<A>(store: AsyncEventStateReadSurface, parentSessionId: string, sweep: () => Promise<A>): void {
  const target = book(store)
  if (!target.sink || target.retries.has(parentSessionId)) return
  const failures = target.failures.get(parentSessionId) ?? 0
  const timer = setTimeout(() => {
    target.retries.delete(parentSessionId)
    void sweep().catch(() => { retryChildResults(store, parentSessionId, sweep) })
  }, Math.min(target.retryFirstMs * 2 ** Math.min(failures, 5), 30_000))
  timer.unref?.()
  target.retries.set(parentSessionId, timer)
}

/** Runs a sweep, coalesces its fault notice, and re-schedules a failed
 * publication from the same durable evidence without re-running a child. */
export async function sweepWithFaultNotice<T>(store: AsyncEventStateReadSurface, parentSessionId: string, sweep: () => Promise<T>): Promise<T> {
  const target = book(store)
  try {
    const outcome = await sweep()
    const failures = target.failures.get(parentSessionId)
    if (failures !== undefined) {
      target.failures.delete(parentSessionId)
      log.info("child completions reach their parent again", { parentSessionId, failedSweeps: failures })
      target.sink?.(parentSessionId, { type: "resolve", id: CHILD_RESULTS_NOTICE_SCOPE })
    }
    return outcome
  } catch (error) {
    const cause = errorMessage(error).split("\n")[0] ?? ""
    const failures = (target.failures.get(parentSessionId) ?? 0) + 1
    target.failures.set(parentSessionId, failures)
    if (failures === 1) log.warn("child completions cannot reach their parent", { parentSessionId, error: cause })
    target.sink?.(parentSessionId, { type: "upsert", notice: childResultsNotice(cause) })
    retryChildResults(store, parentSessionId, () => sweepWithFaultNotice(store, parentSessionId, sweep))
    throw error
  }
}

function childResultsNotice(cause: string) {
  return {
    id: CHILD_RESULTS_NOTICE_SCOPE,
    scope: CHILD_RESULTS_NOTICE_SCOPE,
    presentation: "session.child_results_blocked" as const,
    severity: "warning" as const,
    title: "Finished work cannot report back",
    message: `Flywheel could not give this session the results of its finished subagents or workflows, so it keeps waiting for them. Cause: ${cause}. Flywheel keeps trying to deliver them.`,
  }
}
