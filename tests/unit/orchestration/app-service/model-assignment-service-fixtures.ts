import type { RoleCaptureStore } from "../../../../src/orchestration/config/model-assignment-controller.js"
import type { SessionManager } from "../../../../src/orchestration/session/manager.js"
import { normalizeRoleAssignments, type RoleSettings, type RoleAssignments, type RoleAssignmentSnapshot, type Session } from "../../../../src/orchestration/session/schemas.js"
import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import { createDefinitionAvailability, type DefinitionAvailabilityOwner } from "../../../../src/orchestration/app-service/definition-availability.js"
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js"
import type { ModuleId } from "../../../../src/orchestration/modules.js"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"

export const EXPLORER: Extract<AgentDefinition, { readonly kind: "persona" }> = {
  kind: "persona", name: "explorer", description: "Investigates.", systemPrompt: "Investigate.",
  tools: ["read"], role: "explorer", maxTurns: 20,
}

/** The availability of a project whose personas are `installed`, by default the explorer alone, under `capabilities`
 *  and with the agent types that `disabledTypes` reads turned off. */
export function availabilityOwner(capabilities: readonly ModuleId[], disabledTypes: () => readonly string[] = () => [], installed: readonly AgentDefinition[] = [EXPLORER]): Promise<DefinitionAvailabilityOwner> {
  const skills = testSkillRevision([testSkill("plan"), testSkill("fly.spec-create"), testSkill("fly.spec-review")])
  const personas = { revision: installed.map(({ name }) => name).join(","), personas: new Map(installed.map((persona) => [persona.name, persona])), resolutions: [] }
  const definitionRevision = { ...repoDefinitions().captureRevision(), skills, personaRevision: personas, personas: personas.personas }
  return createDefinitionAvailability({
    definitions: { captureRevision: () => definitionRevision },
    modules: repoModules,
    capabilities: { state: () => ({ ...decodeModuleState(""), capabilities, moduleIds: capabilities }) },
    agentTypes: { disabled: disabledTypes },
  })
}

type CreateChatOptions = Parameters<SessionManager["createChat"]>[0]

export interface ManagerDouble extends RoleCaptureStore {
  createChat: SessionManager["createChat"]
  read(id: string): Promise<Session | null>
  created(): readonly CreateChatOptions[]
  failNextCreateAfterWrite(): void
  failRoleWrites(): void
  seed(id: string, roles: RoleAssignments): void
}

export function managerDouble(): ManagerDouble {
  const sessions = new Map<string, Session>()
  const roleAssignments = new Map<string, RoleAssignmentSnapshot>()
  const created: CreateChatOptions[] = []
  let failAfterWrite = false
  let roleWritesFail = false

  return {
    created: () => created,
    failNextCreateAfterWrite: () => { failAfterWrite = true },
    failRoleWrites: () => { roleWritesFail = true },
    seed: (id, roles) => {
      sessions.set(id, chatSession(id))
      roleAssignments.set(id, roleSnapshot(roles))
    },
    read: async (id) => {
      const session = sessions.get(id)
      if (!session) return null
      const roles = roleAssignments.get(id)
      return roles ? { ...session, roleAssignments: roles } : session
    },
    async createChat(opts) {
      const id = opts.id ?? "created-id"
      if (sessions.has(id)) throw new Error(`Session already exists: ${id}`)
      created.push(opts)
      sessions.set(id, chatSession(id, { conversationId: opts.conversationId }))
      if (opts.initialRoles) roleAssignments.set(id, roleSnapshot(opts.initialRoles))
      if (failAfterWrite) {
        failAfterWrite = false
        throw new Error(`Session already exists: ${id}`)
      }
      return id
    },
    async captureRolesIfAbsent(id, roles) {
      if (!sessions.has(id) || roleAssignments.has(id)) return false
      roleAssignments.set(id, roleSnapshot(roles))
      return true
    },
    async replaceRoleSnapshot(id, roles, overrides = {}) {
      if (roleWritesFail) throw new Error("role write refused")
      if (!sessions.has(id)) return false
      roleAssignments.set(id, { defaults: structuredClone(roles), overrides: structuredClone(overrides) })
      return true
    },
    async updateRoleAssignment(id, roleId, assignment) {
      if (roleWritesFail) throw new Error("role write refused")
      const snapshot = roleAssignments.get(id)
      if (!snapshot) return false
      roleAssignments.set(id, { ...snapshot, overrides: { ...snapshot.overrides, [roleId]: assignment } })
      return true
    },
    async removeRoleAssignment(id, roleId) {
      const snapshot = roleAssignments.get(id)
      if (!snapshot) return false
      const defaults = { ...snapshot.defaults }
      const overrides = { ...snapshot.overrides }
      Reflect.deleteProperty(defaults, roleId)
      Reflect.deleteProperty(overrides, roleId)
      roleAssignments.set(id, { defaults, overrides })
      return true
    },
  }
}

function chatSession(id: string, opts: { conversationId?: string; roleAssignments?: RoleAssignmentSnapshot } = {}): Session {
  const now = "2026-01-01T00:00:00.000Z"
  return {
    kind: "chat",
    command: "chat",
    conversationId: opts.conversationId ?? "conv-new",
    label: "New Chat",
    lastUpdated: now,
    lifecycleState: "active",
    executionCwd: "/scratch",
    name: "New Chat",
    createdAt: now,
    ...(opts.roleAssignments ? { roleAssignments: structuredClone(opts.roleAssignments) } : {}),
  }
}

function roleSnapshot(roles: RoleSettings): RoleAssignmentSnapshot {
  return { defaults: {}, overrides: normalizeRoleAssignments(roles) }
}

export const AVAILABLE_MODELS: ReadonlyMap<ModelFamily, ReadonlySet<string>> = new Map([
  ["openai", new Set(["gpt-5.5", "gpt-5-mini"])],
])

/** Every model of {@link AVAILABLE_MODELS} eligible for the picker through the OpenAI API. */
export function pickerEligibility() {
  return new Map([...AVAILABLE_MODELS.values()].flatMap((models) => [...models].map((model) => [model, {
    explicitlyEnabled: false,
    transport: "openai-responses" as const,
    offering: {
      candidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" },
      wireModelId: model,
      dataUse: "standard",
      transport: "openai-responses",
      resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
    },
  }] as const)))
}

export function providerModelCatalogs() {
  return new Map([["openai_api", {
    catalog: new Set(["gpt-5.5", "gpt-5-mini"]),
    curatedDefault: new Set(["gpt-5.5", "gpt-5-mini"]),
    enabled: new Set<string>(),
    disabled: new Set<string>(),
    effective: new Set(["gpt-5.5", "gpt-5-mini"]),
  }]] as const)
}
