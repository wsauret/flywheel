import type { ResolvedRoles } from "../config/roles.js"
import type { RoleSettings, ReplayedSession, RoleAssignmentSnapshot } from "../session/schemas.js"
import type { WorkflowMembership } from "../../infra/session-workflow-membership.js"
import type { RoleAssignmentView, RuntimeRoleAssignments } from "../../protocol/role-protocol-types.js"
import { activeServingSeat } from "../../protocol/active-serving-seat.js"
import { parseBriefRoleId } from "../../protocol/brief-role-id.js"
import type { AgentPersonas } from "../workflow-host/frontend-attempts.js"
import type { ProviderConnectionCapture } from "../agent-runtime/factory.js"
import { resolveSessionRoles } from "../config/session-role-resolver.js"
import { childServingSeat, roleSlot, type BriefScope } from "../config/role-selection.js"

/** Reads next-request policy without persisting resolved pairs. Missing sessions return null. */
export function createRoleAssignmentReader(deps: {
  readonly readSession: (sessionId: string) => Promise<(Pick<ReplayedSession, "kind" | "roleAssignments"> & { readonly workflowMembership?: WorkflowMembership }) | null>
  readonly inheritedRoles: (workflowId: string) => Promise<RoleAssignmentSnapshot>
  readonly capture: (sessionId: string) => Promise<ProviderConnectionCapture>
  readonly personas: (sessionId: string) => Promise<AgentPersonas>
  readonly childRole: (sessionId: string) => Promise<{ readonly roleId: string; readonly briefScope?: BriefScope } | undefined>
  readonly workflowSeat: (membership: WorkflowMembership) => Promise<{ readonly briefId: string; readonly definitionId: string } | undefined>
  readonly userDataRoot: string
}): (sessionId: string) => Promise<RoleAssignmentView | null> {
  return async (sessionId) => {
    const session = await deps.readSession(sessionId)
    if (!session) return null
    if (session.kind !== "workflow-agent") {
      const child = session.kind === "subagent" ? await deps.childRole(sessionId) : undefined
      const roles = await resolveSessionRoles(session.roleAssignments ?? { defaults: {}, overrides: {} },
        await deps.capture(sessionId), deps.userDataRoot, child === undefined ? [] : [child.roleId])
      const seat = session.kind === "subagent"
        ? child === undefined ? { roleId: "chat", selection: undefined } : childServingSeat(child.roleId, roles, child.briefScope)
        : { roleId: "chat", selection: roles.get("chat") }
      return {
        assignments: projectRoleAssignments(Object.fromEntries(roles)),
        serving: { slot: roleSlot(seat.roleId), ...(seat.selection === undefined ? {} : { selection: { model: seat.selection.model, effort: seat.selection.effort } }) },
      }
    }
    if (!session.workflowMembership) throw new Error(`Workflow role membership is unavailable: ${sessionId}`)
    const inherited = await deps.inheritedRoles(session.workflowMembership.workflowId)
    const personas = await deps.personas(session.workflowMembership.workflowId)
    const roles = await resolveSessionRoles(session.roleAssignments ?? { defaults: {}, overrides: {} },
      await deps.capture(sessionId), deps.userDataRoot,
      [...personas.values()].flatMap((persona) => persona.roles), inherited)
    const seat = await deps.workflowSeat(session.workflowMembership)
    const assignments = projectWorkflowRoleAssignments(roles, personas)
    if (seat === undefined) return { assignments }
    const active = activeServingSeat({ ...seat, personaRoles: personas.get(seat.definitionId)?.roles }, (id) => roles.get(id))
    return {
      assignments,
      serving: {
        slot: roleSlot(active.recordSeat),
        ...(active.selection === undefined ? {} : { selection: { model: active.selection.model, effort: active.selection.effort } }),
      },
    }
  }
}

/** Resolve record inheritance before reducing request selections to client pairs.
 * Provider options and authored-field metadata stay on the server. */
function projectWorkflowRoleAssignments(roles: ResolvedRoles, personas: AgentPersonas): RuntimeRoleAssignments {
  const entries = [...roles].flatMap(([role, resolved]) => {
    const record = parseBriefRoleId(role)
    const assignment = record?.definitionId === undefined ? resolved : activeServingSeat({
      ...record, personaRoles: personas.get(record.definitionId)?.roles,
    }, (id) => roles.get(id)).selection
    return assignment === undefined ? [] : [[role, assignment] as const]
  })
  return projectRoleAssignments(Object.fromEntries(entries))
}

export function projectRoleAssignments(roles: RoleSettings): RuntimeRoleAssignments {
  return Object.fromEntries(Object.entries(roles).flatMap(([role, assignment]) =>
    assignment.model === undefined || assignment.effort === undefined ? [] : [[
      role, { model: assignment.model, effort: assignment.effort },
    ] as const]))
}
