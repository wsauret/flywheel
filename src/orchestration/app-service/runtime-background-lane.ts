import { isAbortError } from "../../infra/abort.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { loggedOperation, type LoggedOperationOptions, type OperationFailure } from "../../infra/operation-log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import { DeadlineExceeded, OUTPUT_HISTORY_RPC_DEADLINE_MS, withDeadline } from "../../infra/with-deadline.js"
import { Log } from "../../infra/log.js"
import type { RuntimeQuery, RuntimeQueryResult } from "../../protocol/app-service-types.js"
import type { RuntimeSessionDetailQuery, RuntimeSessionDetailResult } from "../../protocol/session-detail-protocol-types.js"
import type { RuntimeBackgroundSummaryResult } from "../../protocol/runtime-protocol-schemas.js"
import { RuntimeCallTimeout } from "../../protocol/runtime-client-deadlines.js"
import { PROTOCOL_BACKGROUND_DOMAINS, protocolDomain, type ProtocolBackgroundDomain, type ProtocolBackgroundSnapshot } from "../../protocol/modules.js"
import type { RuntimeBackgroundClient } from "./worker-background-client.js"
import type { SessionFileChangeCounts } from "../../protocol/session-changes-protocol-types.js"
import { createRuntimeBackgroundConversationSearch, type RuntimeBackgroundConversationSearch } from "./runtime-background-conversation-search.js"
import { budgetViewsFromSummary } from "./runtime-summary-projection.js"

/** A read-only optimization lane. Its results are unpositioned domain data;
 * the authoritative app-service bus publication boundary owns all positions. */
export interface RuntimeBackgroundLane extends Pick<RuntimeBackgroundClient, "transcriptSearch">, RuntimeBackgroundConversationSearch {
  start(): void
  snapshot(): Promise<RuntimeBackgroundSummaryResult>
  sessionSummaryImmediate(sessionIds: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
  waitForTotals(sessionIds: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
  sessionDetail(query: RuntimeSessionDetailQuery): Promise<RuntimeSessionDetailResult>
  sessionChangeSummary(sessionId: string): Promise<SessionFileChangeCounts>
  /** One module domain's durable history for a session that is not live. */
  moduleSnapshot<Domain extends ProtocolBackgroundDomain>(domain: Domain, sessionId: string): Promise<ProtocolBackgroundSnapshot<Domain>>
  dispose(): Promise<void>
}

export interface RuntimeBackgroundLaneOptions {
  readonly createClient: (projectRoot: string) => RuntimeBackgroundClient
  readonly setTimer?: (fire: () => void) => () => void
}

/** Serve one durable-only protocol read and stamp its account-side baseline.
 * Returns undefined for queries that require a live or non-history owner,
 * which includes every transcript read: the executor answers those (ARCH-RUNTIME-016). */
export function serveRuntimeBackgroundQuery<Q extends RuntimeQuery>(
  history: RuntimeBackgroundLane,
  request: Q,
  snapshotPosition: number,
): Promise<RuntimeQueryResult<Q> | undefined>
export async function serveRuntimeBackgroundQuery(
  history: RuntimeBackgroundLane,
  request: RuntimeQuery,
  snapshotPosition: number,
): Promise<RuntimeQueryResult<RuntimeQuery> | undefined> {
  switch (request.type) {
    case "sessionDetail": return history.sessionDetail(request)
    case "sessionChangeSummary": return { snapshotPosition, ...await history.sessionChangeSummary(request.sessionId) }
    // One summary read answers the batch; a budget reads no session history.
    case "budgetSnapshot": return { snapshotPosition, views: budgetViewsFromSummary(await history.sessionSummaryImmediate(request.sessionIds), request.sessionIds) }
    case "statusSnapshot": return { snapshotPosition, views: await Promise.all(request.sessionIds.map(async (sessionId) => ({ sessionId, view: (await history.sessionDetail({ sessionId })).view?.status ?? null }))) }
  }
  const domain = PROTOCOL_BACKGROUND_DOMAINS.find((name) => protocolDomain(name).snapshot.query === request.type)
  if (!domain) return undefined
  const ownerId = "sessionId" in request ? request.sessionId : "workflowId" in request ? request.workflowId : undefined
  if (ownerId === undefined) return undefined
  return { snapshotPosition, ...await history.moduleSnapshot(domain, ownerId) }
}

interface RuntimeBackgroundLogFields {
  [field: string]: unknown
}
/** How one read records its outcome; see the lane below for who records what. */
type RuntimeBackgroundReadRecord<A> = Pick<LoggedOperationOptions<A>, "summarize" | "failureLevel">
const log = Log.create({ service: "runtime.background" })

/** How long one repeating call failure collects its repeats. */
const CALL_FAILURE_WINDOW_MS = 10 * 60_000

/** The first line of a failure: a decode failure's first issue, without the
 *  union dump that follows it. It keys the repeats of one failure and names
 *  them in their summary; the first record carries the whole error. */
function firstLine(message: string): string {
  const end = message.indexOf("\n")
  return end < 0 ? message : message.slice(0, end)
}

/** One persistent typed client owns one background Worker. Effect owns Worker
 *  respawn after a thread crash; this lane owns lazy acquisition, per-call
 *  deadlines, and one awaited disposal. No PID, socket, or parallel lifetime
 *  exists to reconcile.
 *
 *  The lane records the outcome of each read, and the readers at its call
 *  sites record nothing about it. A failed read records at ERROR, because most
 *  readers pass the failure on to a person or a model. The summary reads
 *  record at WARN, because the summary projection keeps its held totals and
 *  its next admission retries them. Repeats of one failure coalesce into one
 *  count at the same level. A read that the owner's shutdown refuses or
 *  interrupts rejects as an abort and records `interrupted` at DEBUG. */
export function createRuntimeBackgroundLane(
  projectRoot: string,
  options: RuntimeBackgroundLaneOptions,
): RuntimeBackgroundLane {
  let client: RuntimeBackgroundClient | null = null
  let disposed = false
  // One settlement, however many callers join it: a second caller joins the
  // close in flight rather than resolve while the Worker is still unwinding.
  let disposal: Promise<void> | null = null
  // A broken read fails the same way on every read of the same data. The
  // first failure of an operation records in full, with its stack; repeats
  // count by the failure's first line until the window closes or the lane ends.
  const failures = coalesceRepeats<OperationFailure>({
    windowMs: CALL_FAILURE_WINDOW_MS,
    first: (_key, failure) => {
      log[failure.level](`${failure.operation} failed`, { ...failure.fields, durationMs: failure.durationMs, error: errorMessage(failure.error), errorDetail: errorDetail(failure.error) })
    },
    repeated: (_key, repeats) => {
      const first = repeats.events[0]
      log[first?.level ?? "error"](`${first?.operation ?? "runtime background call"} failed again`, { count: repeats.count, windowMs: repeats.windowMs, ...(first ? { error: firstLine(errorMessage(first.error)) } : {}) })
    },
  })
  const recordFailure = (failure: OperationFailure): void => {
    failures.observe(`${failure.operation}\0${firstLine(errorMessage(failure.error))}`, failure)
  }

  function ensureClient(): RuntimeBackgroundClient {
    if (disposed) throw new DOMException("Runtime background lane is disposed", "AbortError")
    client ??= options.createClient(projectRoot)
    return client
  }

  async function call<A>(
    operation: string,
    fields: RuntimeBackgroundLogFields,
    run: (active: RuntimeBackgroundClient) => Promise<A>,
    record: RuntimeBackgroundReadRecord<A> = {},
  ): Promise<A> {
    return loggedOperation({ log, operation, level: "debug", fields: { projectRoot, ...fields }, ...record, onFailure: recordFailure }, async () => {
      try {
        return await withDeadline(run(ensureClient()), OUTPUT_HISTORY_RPC_DEADLINE_MS, { setTimer: options.setTimer })
      } catch (err) {
        if (err instanceof DeadlineExceeded) throw RuntimeCallTimeout.forDeadline(err.deadlineMs)
        throw err
      }
    })
  }

  async function ownedCall<A>(
    operation: string,
    fields: RuntimeBackgroundLogFields,
    run: (active: RuntimeBackgroundClient) => Promise<A>,
    record: RuntimeBackgroundReadRecord<A> = {},
  ): Promise<A> {
    return loggedOperation({ log, operation, level: "debug", fields: { projectRoot, ...fields }, ...record, onFailure: recordFailure }, () => run(ensureClient()))
  }

  const conversationSearch = createRuntimeBackgroundConversationSearch(projectRoot, log, ensureClient)

  return {
    // Warming spawns the Worker and opens its reader off the user path; a
    // failure here is not an error state, the first real call just boots cold.
    // A warm that the owner's shutdown interrupts has nothing to report.
    start() {
      void ensureClient().warm().catch((err: unknown) => {
        if (isAbortError(err)) return
        log.warn("runtime background warm failed", { projectRoot, error: errorMessage(err), errorDetail: errorDetail(err) })
      })
    },
    snapshot: () => call("runtime background snapshot", {}, (active) => active.snapshot(), { failureLevel: "warn", summarize: (result) => ({ rows: result.rows.length, errors: result.errors.length }) }),
    sessionSummaryImmediate: (sessionIds) => call("runtime background session summary", { sessions: sessionIds.length }, (active) => active.sessionSummaryImmediate(sessionIds), { failureLevel: "warn", summarize: (result) => ({ rows: result.rows.length, errors: result.errors.length, totalsLoading: result.totalsLoading }) }),
    waitForTotals: (sessionIds) => ownedCall("runtime background wait for totals", { sessions: sessionIds.length }, (active) => active.waitForTotals(sessionIds), { failureLevel: "warn", summarize: (result) => ({ rows: result.rows.length, errors: result.errors.length }) }),
    sessionDetail: (query) => call("runtime background session detail", { sessionId: query.sessionId }, (active) => active.sessionDetail(query), { summarize: (result) => ({ view: result.view ? "present" : "null", source: result.view?.source, kind: result.view?.kind }) }),
    sessionChangeSummary: (sessionId) => call("runtime background session change summary", { sessionId }, (active) => active.sessionChangeSummary(sessionId)),
    moduleSnapshot: (domain, sessionId) => call("runtime background module snapshot", { domain, sessionId }, (active) => active.moduleSnapshot(domain, sessionId)),
    ...conversationSearch,
    transcriptSearch: (request) => call("runtime background transcript search", { sessionId: request.sessionId }, (active) => active.transcriptSearch(request)),
    dispose() {
      disposal ??= (async () => {
        disposed = true
        failures.end()
        const active = client
        client = null
        if (active) await active.close()
      })()
      return disposal
    },
  }
}
