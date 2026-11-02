import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { isRolePayload, rolesCursor, type RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import { createPerSessionCache, type PerSessionCache } from "./create-per-session-cache.js"

export type RoleCache = PerSessionCache<RoleAssignmentView>

export function createRoleCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): RoleCache {
  return createPerSessionCache({
    domain: "roles",
    cursor: rolesCursor,
    client: deps.appService,
    query: (sessionIds) => deps.appService.query({ type: "roleSnapshot", sessionIds }),
    isPayload: isRolePayload,
    payloadView: (payload) => (payload.kind === "roles.updated" ? payload.roles : null),
  })
}
