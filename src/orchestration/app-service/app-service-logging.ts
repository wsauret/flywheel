import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { loggedOperation, type CompletionLevel, type OperationFailure, type OperationLogger } from "../../infra/operation-log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { FrontendMutation, FrontendEvent, RuntimeClient } from "../../protocol/app-service-types.js"
import { declinedByPausedProject, lostWithLane, supersededByGenerationChange } from "../../protocol/client/connection-failures.js"
import type { FlywheelAppService } from "./app-service.js"

interface MutationLogFields {
  [field: string]: unknown
}

interface QueryCounts {
  [query: string]: number
}

/** A client dispatch that takes this long is latency a person notices, and
 *  set beside the runtime's own record it shows where the time went. */
const CLIENT_DISPATCH_SLOW_MS = 1_000
/** How long one failure condition collects repeats before reporting them. */
const QUERY_FAILURE_WINDOW_MS = 30_000

/** Which end of the protocol a wrapped client serves. The runtime records
 *  every user mutation once; background cleanup records its own decision.
 *  The client records a dispatch only when it failed or ran slow. */
type ProtocolSide = "runtime" | "client"

const DISPATCH_LEVEL = {
  runtime: { level: "info" },
  client: { slowMs: CLIENT_DISPATCH_SLOW_MS },
} as const satisfies { readonly [side in ProtocolSide]: CompletionLevel }

export function withLoggedFlywheelAppService(service: FlywheelAppService, log: OperationLogger): FlywheelAppService {
  return {
    ...withLoggedRuntimeClient(service, log, "app-service", "runtime"),
    publish: service.publish,
    // The protocol handlers record each client stream's subscription once;
    // these are the service-internal steps under it.
    subscribe(listener: (event: FrontendEvent) => void) {
      const unsubscribe = service.subscribe(listener)
      log.debug("subscribed")
      return () => {
        unsubscribe()
        log.debug("unsubscribed")
      }
    },
    // No logging wrapper on the shutdown steps: the barrier that runs them logs
    // every step's start, duration, and failure by name.
    shutdown: service.shutdown,
    admission: service.admission,
    hasLiveSession: service.hasLiveSession,
    watchOutput: service.watchOutput,
    hideSession: service.hideSession,
  }
}

/** A call that ended as an outcome rather than a failure: its lane took it
 *  down, a clean close in a routine stop such as a planned replacement
 *  included (the connection records the lane's end once), a paused
 *  project declined it, or an executor generation change voided a read the
 *  change asked every client to take again. Each records where its
 *  completion would. */
function endedAsOutcome(error: unknown): boolean {
  return lostWithLane(error) || declinedByPausedProject(error) || supersededByGenerationChange(error)
}

export function withLoggedRuntimeClient(client: RuntimeClient, log: OperationLogger, prefix: string, side: ProtocolSide): RuntimeClient {
  // One lost connection fails every query in flight and every query sent
  // after it. The first failure records with its stack; the rest count by
  // query kind and report once, when a query succeeds again or the window
  // closes.
  const failures = coalesceRepeats<OperationFailure>({
    windowMs: QUERY_FAILURE_WINDOW_MS,
    first: (_key, failure) => {
      log.error(`${prefix} query failed`, { ...failure.fields, durationMs: failure.durationMs, error: errorMessage(failure.error), errorDetail: errorDetail(failure.error) })
    },
    repeated: (key, repeats) => {
      const byQuery: QueryCounts = {}
      for (const failure of repeats.events) {
        const query = String(failure.fields.query)
        byQuery[query] = (byQuery[query] ?? 0) + 1
      }
      log.error(`${prefix} query failed again`, { error: key, count: repeats.count, windowMs: repeats.windowMs, byQuery })
    },
  })
  return {
    query: (query) => loggedOperation(
      {
        log, operation: `${prefix} query`, level: "debug", fields: { query: query.type }, interruptedBy: endedAsOutcome,
        onFailure: (failure) => { failures.observe(errorMessage(failure.error), failure) },
      },
      async () => {
        const result = await client.query(query)
        failures.end()
        return result
      },
    ),
    dispatch: (mutation) => loggedOperation(
      { log, operation: `${prefix} dispatch`, fields: mutationFields(mutation), interruptedBy: endedAsOutcome, ...(side === "runtime" && mutation.type === "session.delete" && mutation.inactiveBefore !== undefined ? { level: "debug" } : DISPATCH_LEVEL[side]) },
      () => client.dispatch(mutation),
    ),
    subscribe: (listener) => client.subscribe(listener),
    close: () => {
      failures.end()
      return loggedOperation({ log, operation: `${prefix} close` }, () => client.close())
    },
  }
}

function mutationFields(mutation: FrontendMutation): MutationLogFields {
  return { mutation: mutation.type, sessionId: "sessionId" in mutation ? mutation.sessionId : undefined }
}
