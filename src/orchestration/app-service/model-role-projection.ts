import { AGENT_ROLE_IDS, AUX_ROLE_IDS, DEFAULT_ROLES, parentRoleId, ROLE_GROUP_ORDER, TOP_LEVEL_ROLE_IDS, type RoleId, type RoleMetadata } from "../config/roles.js"
import type { RuntimeModelRole } from "../../protocol/model-role-protocol-types.js"
import { parseBriefRoleId } from "../../protocol/brief-role-id.js"
import type { FirstPartyModuleComposition } from "../modules.js"
import { agentTypeRefusal, type DefinitionAvailabilitySnapshot } from "./definition-availability.js"

/** The model roles and seats that the model settings offer under one module selection and one definition
 *  availability (ARCH-STRUCTURE-044). Every model-settings entry point reads it: the published role list, the
 *  assignment rows, option and effort lists, saves, and the scope of a reset. The configuration keeps every role,
 *  offered or not, so a model saved for a role stays saved (PI-CAP-022). */
export interface ModelRoleAdmission {
  /** Whether the settings offer `roleId`: a module-owned role needs its module, and a seat of an agent type needs
   *  that type. */
  admits(roleId: string): boolean
  /** Why the agent type that `roleId` seats is not offered, naming the type and how to turn it on, or undefined when
   *  `roleId` seats no agent type or its type is offered. */
  typeRefusal(roleId: string): string | undefined
}

export function modelRoleAdmission(composition: FirstPartyModuleComposition, availability: DefinitionAvailabilitySnapshot): ModelRoleAdmission {
  const moduleRoles = new Set(composition.contributions.flatMap((contribution) => contribution.domain === "modelRoles" ? contribution.value : []))
  // A core agent role, the role of an installed persona such as a custom role, and the parent role that covers
  // either: the seats whose agent type availability decides.
  const personaRoles = [...availability.definitionRevision.personas.values()].flatMap((persona) => persona.kind === "persona" ? [persona.role] : [])
  const agentRoles = new Set([...AGENT_ROLE_IDS, ...personaRoles].flatMap((role) => [role, parentRoleId(role) ?? role]))
  // A brief seat of a persona role seats that type; a brief or record seat of a workflow's own agent seats none.
  const seatedType = (roleId: string): string | undefined => {
    const selector = parseBriefRoleId(roleId)
    if (!selector) return agentRoles.has(roleId) ? roleId : undefined
    return selector.definitionId === undefined ? selector.personaRole : undefined
  }
  const typeRefusal = (roleId: string): string | undefined => {
    const type = seatedType(roleId)
    return type === undefined ? undefined : agentTypeRefusal(availability, type)
  }
  return {
    admits: (roleId) => {
      const meta: RoleMetadata | undefined = DEFAULT_ROLES[roleId]
      return (!meta?.moduleOwned || moduleRoles.has(roleId)) && typeRefusal(roleId) === undefined
    },
    typeRefusal,
  }
}

/** Projects the roles that `admission` offers into client settings. */
export function publishedModelRoles(admission: ModelRoleAdmission): readonly RuntimeModelRole[] {
  const ids: readonly RoleId[] = [...TOP_LEVEL_ROLE_IDS, ...AGENT_ROLE_IDS, ...AUX_ROLE_IDS]
  return ids
    .flatMap((id) => {
      const meta: RoleMetadata | undefined = DEFAULT_ROLES[id]
      // A role id with no metadata is one this build does not describe. It is
      // still assignable, but a client cannot present it, so it is left out
      // rather than shown with an invented label.
      if (!meta || !admission.admits(id)) return []
      return [{ id, label: meta.label, group: meta.group, order: meta.order, description: meta.description }]
    })
    .toSorted((left, right) => ROLE_GROUP_ORDER.indexOf(left.group) - ROLE_GROUP_ORDER.indexOf(right.group) || left.order - right.order)
}
