import { type FixedBriefFields, briefFixedRoleId, briefPersonaRoleId, briefRoleId } from "../../protocol/brief-role-id.js"
import type { AgentDefinition } from "../../infra/agent-definition.js"
import type { ResolvedAgent } from "../../workflows/agent-resolution.js"
import { agentRecords, type AgentRecordKeys, type WorkflowDefinition } from "../../workflows/workflow-schema.js"
import type { ProviderConnectionCapture } from "../agent-runtime/factory.js"
import type { RoleSettings } from "../session/schemas.js"
import type { WorkflowLaunchAgentModels } from "../../infra/workflow-types.js"
import { resolveSessionRoles } from "./session-role-resolver.js"
import { resolveWorkflowAgentRole } from "./role-selection.js"

interface ModelPair {
  readonly model: string
  readonly effort: string
}

/** A temporary launch preview, not persisted request policy. */
export interface WorkflowAgentModels {
  readonly pairs: readonly (ModelPair & { readonly definitionIds: readonly string[] })[]
  readonly unavailable?: readonly { readonly definitionId: string; readonly reason: "no-selection" | "access-pending" }[]
  readonly personas: readonly { readonly persona: string; readonly agentIds: readonly string[] }[]
}

interface BindWorkflowAgentModelsInput {
  readonly workflow: WorkflowDefinition
  readonly agents?: WorkflowLaunchAgentModels
  readonly resolvedAgents: ReadonlyMap<string, ResolvedAgent>
  readonly userDataRoot: string
  readonly capture: ProviderConnectionCapture
  readonly personas: ReadonlyMap<string, AgentDefinition>
}

function fixedFields(keys: Pick<AgentRecordKeys, "model" | "effort">): FixedBriefFields | undefined {
  if (keys.model !== undefined) return keys.effort === undefined ? "model" : "both"
  return keys.effort === undefined ? undefined : "effort"
}

/** Retains only file/client-authored fields. Unreachable choices never refuse launch.
 * The preview uses current availability; every later request resolves the stored intent again. */
export async function bindWorkflowAgentModels(input: BindWorkflowAgentModelsInput): Promise<{ readonly roles: RoleSettings; readonly models: WorkflowAgentModels }> {
  const ordered = [...input.resolvedAgents.values()].sort((left, right) => left.definitionId.localeCompare(right.definitionId))
  const records = agentRecords(input.workflow)
  const roles: { [roleId: string]: RoleSettings[string] } = {}
  const roleIds = new Set<string>()
  for (const agent of ordered) {
    roleIds.add(briefRoleId(agent.briefId))
    const persona = agent.persona === undefined ? undefined : input.personas.get(agent.persona)
    if (persona?.kind === "persona") {
      roleIds.add(persona.role)
      roleIds.add(briefPersonaRoleId(agent.briefId, persona.role))
    }
    const keys = input.agents?.[agent.definitionId] ?? records.get(agent.definitionId)?.keys ?? {}
    const fixed = fixedFields(keys)
    if (fixed !== undefined) roles[briefFixedRoleId(agent.briefId, agent.definitionId, fixed)] = {
      ...(keys.model === undefined ? {} : { model: keys.model }),
      ...(keys.effort === undefined ? {} : { effort: keys.effort }),
    }
  }
  const resolved = await resolveSessionRoles({ defaults: roles, overrides: {} }, input.capture, input.userDataRoot, roleIds)
  const groups = new Map<string, ModelPair & { definitionIds: string[] }>()
  const unavailable: NonNullable<WorkflowAgentModels["unavailable"]>[number][] = []
  const personas = new Map<string, string[]>()
  for (const agent of ordered) {
    const persona = agent.persona === undefined ? undefined : input.personas.get(agent.persona)
    const selected = resolveWorkflowAgentRole(agent, resolved, persona?.kind === "persona" ? persona.role : undefined)
    if (selected) {
      const key = JSON.stringify([selected.model, selected.effort])
      const group = groups.get(key) ?? { model: selected.model, effort: selected.effort, definitionIds: [] }
      group.definitionIds.push(agent.definitionId)
      groups.set(key, group)
    } else {
      unavailable.push({ definitionId: agent.definitionId, reason: input.capture.eligibility?.accessPending?.(input.capture.runtimeConfig.allowTrainingRoutes) ? "access-pending" : "no-selection" })
    }
    if (agent.persona !== undefined) personas.set(agent.persona, [...personas.get(agent.persona) ?? [], agent.definitionId])
  }
  return {
    roles,
    models: {
      pairs: [...groups.values()], personas: [...personas].map(([persona, agentIds]) => ({ persona, agentIds })),
      ...(unavailable.length === 0 ? {} : { unavailable }),
    },
  }
}
