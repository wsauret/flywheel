import type { AsyncEventReadSurface } from "../../../../infra/store/event-store-types.js"
import { RETIRED_COMPACTION_ROLE_IDS, normalizeRoleAssignments } from "../../../config/retired-config-names.js"
import type { ResolvedRole, ResolvedRoles, RoleId, RoleResolver } from "../../../config/roles.js"
import { captureRoleResolver } from "../../../config/models/role-resolution.js"
import type { AgentPersonaRoles } from "../../../config/models/role-selection.js"
import { effectiveRoleAssignments, resolveSessionSettings, withInheritedRoles } from "../../../config/models/session-role-resolver.js"
import type { RoleAssignmentSnapshot, RoleSettings } from "../../../session/metadata/schemas.js"
import { createSingleSessionMetadataProjection } from "../../../session/metadata/session-metadata-projection.js"
import { workflowRunOwner } from "../../../module-catalog.js"
import type { CaptureProviderConnection, ProviderConnectionCapture } from "../model-runtime-capture.js"

/** Resolves replayed authored fields against the current immutable profile capture.
 * No request selection is written back to session metadata. */
export async function resolveSessionRoles(snapshot: RoleAssignmentSnapshot, capture: ProviderConnectionCapture, userDataRoot: string, additionalRoleIds: Iterable<string> = [], inherited?: RoleAssignmentSnapshot, personas?: AgentPersonaRoles): Promise<ResolvedRoles> {
  const resolve = captureRoleResolver({
    selection: capture.providers.selection, connection: capture.connection, eligibility: capture.eligibility, allowTrainingRoutes: capture.runtimeConfig.allowTrainingRoutes,
  }, userDataRoot)
  return resolveSessionSettings(snapshot, capture.runtimeConfig.profileRoles, async (roleId, setting) => {
    const result = await resolve(roleId, setting)
    return result.kind === "selected" || result.kind === "unserved" ? result.role : undefined
  }, additionalRoleIds, undefined, inherited, personas)
}

/** Projects complete saved pairs for consumers without a request capture.
 * Live runners pass a capture to createSessionRoleResolver instead. */
function resolvedRolesFromAssignments(roles: RoleSettings): ResolvedRoles {
  const resolved = new Map<RoleId, ResolvedRole>()
  for (const [roleId, assignment] of Object.entries(normalizeRoleAssignments(roles))) {
    if (RETIRED_COMPACTION_ROLE_IDS.has(roleId) || assignment.model === undefined || assignment.effort === undefined) continue
    resolved.set(roleId, { roleId, model: assignment.model, effort: assignment.effort, providerOptions: assignment.providerOptions, setting: assignment, settingScope: "session" })
  }
  return resolved
}

export function createSessionRoleResolver(deps: {
  projectRoot: string
  sessionId: string
  reader: AsyncEventReadSurface
  userDataRoot?: string
  capture?: CaptureProviderConnection
  requiredRoleIds?: ReadonlySet<string>
  /** For a workflow agent's session, the persona roles of its agent record, by record id. */
  personas?: AgentPersonaRoles
}): RoleResolver {
  const projection = createSingleSessionMetadataProjection(deps.reader, deps.sessionId)
  return async (requestCapture) => {
    const session = (await projection.replay()).sessions[deps.sessionId]
    if (!session) throw new Error(`Session not found: ${deps.sessionId}`)
    const snapshot = session.roleAssignments ?? { defaults: {}, overrides: {} }
    const inherited = session.kind === "workflow-agent" ? await workflowRunOwner().settings(deps.reader).read(session.workflowMembership.workflowId) : undefined
    if (session.kind === "workflow-agent" && !inherited) throw new Error(`Workflow not found: ${session.workflowMembership.workflowId}`)
    const capture = requestCapture ?? await deps.capture?.()
    return capture
      ? resolveSessionRoles(snapshot, capture, deps.userDataRoot ?? deps.projectRoot, deps.requiredRoleIds, inherited?.roleAssignments, deps.personas)
      : resolvedRolesFromAssignments(effectiveRoleAssignments(inherited ? withInheritedRoles(inherited.roleAssignments, snapshot) : snapshot, {}, deps.personas))
  }
}
