import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { isStatusPayload, statusCursor, type StatusView } from "../../protocol/status-protocol-types.js"
import { createPerSessionCache, type PerSessionCache } from "./create-per-session-cache.js"

export type StatusCache = PerSessionCache<StatusView>

export function createStatusCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): StatusCache {
  return createPerSessionCache({
    domain: "status",
    cursor: statusCursor,
    client: deps.appService,
    query: (sessionIds) => deps.appService.query({ type: "statusSnapshot", sessionIds }),
    isPayload: isStatusPayload,
    payloadView: (payload) => (payload.kind === "status.updated" ? payload.status : null),
    heldAcrossBreak: activeTimeAt,
  })
}

/** The status with its active time counted up to `at` and its clock stopped
 *  there. A running clock is the runtime's claim that the turn still runs,
 *  and a broken lane stops vouching for it: a planned replacement cuts the
 *  turn just before it closes the lane, and the successor reports the time
 *  up to the cut. A clock the client kept advancing past the break would
 *  step back when that report replaced it (PI-REMOTE-012). */
function activeTimeAt(status: StatusView, at: number): StatusView {
  if (status.streamingStartedAt === null) return status
  return { ...status, accumulatedActiveMs: status.accumulatedActiveMs + Math.max(0, at - status.streamingStartedAt), streamingStartedAt: null }
}
