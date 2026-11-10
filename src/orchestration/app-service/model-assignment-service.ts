import type { RoleAssignments } from "../session/schemas.js"
import type { FirstPartyModuleSnapshot } from "../modules.js"
import { workflowRunReader } from "../module-catalog.js"
import { agentPersonas, installedPersonaRole } from "../workflow-host/frontend-attempts.js"
import type { RuntimeModelRolesResult } from "../../protocol/model-role-protocol-types.js"
import { modelRoleAdmission, publishedModelRoles } from "./model-role-projection.js"
import type { ModelPickerConfigDeps } from "../config/model-assignment-types.js"
import type { FlywheelConfig } from "../config/schema.js"
import { EffortSchema } from "../../infra/workflow-types.js"
import { Schema } from "effect"
import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventWriter, AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import {
  createModelAssignmentController,
  loadGlobalDefaultRoles,
  type RoleCaptureStore,
} from "../config/model-assignment-controller.js"
import { ensureDurableChatSession } from "./session-chat-durability.js"
import type { DefinitionAvailabilityOwner } from "./definition-availability.js"
import { isProfileModelRole } from "../../protocol/brief-role-id.js"
import type { SessionManager } from "../session/manager.js"
import type { SessionStore } from "../session-store/types.js"
import { personaRoleIds, type ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js"
import type { ConfigValidity } from "../config/writer.js"
import type {
  ModelSelectionSlot,
  RuntimeEffortOptionsQuery,
  RuntimeGlobalDefaultRolesResult,
  RuntimeModelAssignmentsQuery,
  RuntimeModelAssignmentScope,
  RuntimeModelOptionsQuery,
  RuntimeResetModelAssignmentsMutation,
  RuntimeResetModelAssignmentsResult,
  RuntimeSaveModelEffortMutation,
  RuntimeSaveModelEffortResult,
} from "../../protocol/model-assignment-protocol-types.js"
const SESSION_ALREADY_EXISTS = "Session already exists:"
const DEFAULTS_SCOPE = { kind: "defaults" } as const


export interface RuntimeModelAssignmentService {
  loadAssignments(query: RuntimeModelAssignmentsQuery): ReturnType<ReturnType<typeof createModelAssignmentController>["loadAssignments"]>
  listModelOptions(query: RuntimeModelOptionsQuery): ReturnType<ReturnType<typeof createModelAssignmentController>["listModelOptions"]>
  listEffortOptions(query: RuntimeEffortOptionsQuery): ReturnType<ReturnType<typeof createModelAssignmentController>["listEffortOptions"]>
  saveEffort(command: RuntimeSaveModelEffortMutation): Promise<RuntimeSaveModelEffortResult>
  resetDefaults(command: RuntimeResetModelAssignmentsMutation): Promise<RuntimeResetModelAssignmentsResult>
  globalDefaultRoles(): Promise<RuntimeGlobalDefaultRolesResult>
  /** Every currently listed model role, with the metadata a client needs to
   *  present them. Published rather than importable: the registry sits behind
   *  imports that reach Bun. */
  modelRoles(): Promise<RuntimeModelRolesResult>
}

interface RuntimeModelAssignmentServiceDeps {
  readonly roleCaptureStore: RoleCaptureStore & Pick<SessionManager, "createChat" | "read">
  readonly sessionStore: Pick<SessionStore, "get">
  readonly projectRoot: string
  /** Supplies the admitted profile's immutable model catalogs and picker projection. */
  readonly configDepsForScope: (scope: RuntimeModelAssignmentScope) => ModelPickerConfigDeps & { readonly authProfileId: () => string }
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly eventStore: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  /** Published availability projection (ARCH-STRUCTURE-026, ARCH-STRUCTURE-044). The client sends the slots it
   *  renders; this service answers, saves, and resets only the ones that the current selection admits, so no
   *  roster copies a capability flag. */
  readonly availability: Pick<DefinitionAvailabilityOwner, "snapshot">
  /** Current immutable config snapshot owned by the runtime config owner. */
  readonly config: () => FlywheelConfig
  /** Publishes a completed defaults write before any dependent read. */
  readonly refreshConfig: () => Promise<FlywheelConfig>
  readonly materializeDefaults?: () => Promise<RoleAssignments>

  readonly prepareModelEligibility?: () => Promise<void>
}

/** Only persona roles have a complete pruning authority. Workflow files can use any brief id. */
export function modelConfigValidity(
  revision: Pick<ProjectDefinitionRegistryRevision, "personas">,
): ConfigValidity {
  return {
    roleIds: personaRoleIds(revision.personas),
  }
}

export function createRuntimeModelAssignmentService(deps: RuntimeModelAssignmentServiceDeps): RuntimeModelAssignmentService {
  const prepareModelEligibility = () => deps.prepareModelEligibility?.() ?? Promise.resolve()
  const admission = () => modelRoleAdmission(deps.moduleSelection(), deps.availability.snapshot())
  const modelRoles = () => publishedModelRoles(admission())
  const configDeps = (scope: RuntimeModelAssignmentScope = DEFAULTS_SCOPE): ModelPickerConfigDeps & { readonly authProfileId: () => string } => {
    const revision = deps.availability.snapshot().definitionRevision
    return {
      ...deps.configDepsForScope(scope),
      config: deps.config(),
      configValidity: modelConfigValidity(revision),
    }
  }
  // The global defaults are a value of their inputs: the configured roles, the
  // persona roles of the definition revision, and the admitted profile's
  // enabled models and model metadata. Every auth publication, config write,
  // and skill reload refreshes the chat default through here with fresh
  // snapshot identities, so the inputs are compared by content: the
  // resolution runs once per change of an input.
  let heldDefaults: { readonly inputs: string; readonly roles: Promise<RoleAssignments> } | undefined
  const loadDefaults = (): Promise<RoleAssignments> => {
    if (deps.materializeDefaults) return deps.materializeDefaults()
    const scoped = configDeps()
    const inputs = defaultRoleInputs(scoped)
    if (heldDefaults?.inputs === inputs) return heldDefaults.roles
    const roles = loadGlobalDefaultRoles(scoped)
    const held = { inputs, roles }
    heldDefaults = held
    roles.catch(() => { if (heldDefaults === held) heldDefaults = undefined })
    return roles
  }
  const materializeDefaults = async () => {
    await prepareModelEligibility()
    return loadDefaults()
  }
  // The run policy and the persona roles that a workflow agent's record seats read.
  const runSeats = async (workflowId: string) => {
    const runs = workflowRunReader(deps.eventStore)
    const run = await runs.read(workflowId)
    return run && {
      inheritedRoles: run.roleAssignments,
      personas: agentPersonas(await runs.readDefinitionLineage(workflowId), installedPersonaRole(deps.availability.snapshot().definitionRevision.personas)),
    }
  }
  const controller = async (scope: RuntimeModelAssignmentsQuery["scope"]) => {
    await prepareModelEligibility()
    await ensureSessionScopeBacked(scope, deps)
    const manager: Pick<SessionManager, "read"> = deps.roleCaptureStore
    const session = scope.kind === "session" ? await manager.read(scope.sessionId) : null
    const run = session?.kind === "workflow-agent" ? await runSeats(session.workflowMembership.workflowId) : null
    return createModelAssignmentController({
      scope: scope.kind === "defaults" ? scope : run
        ? { kind: "workflow-agent", sessionId: scope.sessionId, roleCaptureStore: deps.roleCaptureStore, ...run }
        : { kind: "session", sessionId: scope.sessionId, roleCaptureStore: deps.roleCaptureStore },
      configDeps: configDeps(scope),
      afterGlobalConfigWrite: deps.refreshConfig,
    })
  }

  const assignable = (slots: readonly ModelSelectionSlot[]): readonly ModelSelectionSlot[] => {
    const { admits } = admission()
    return slots.filter((slot) => admits(slot.roleId))
  }
  // A request for the seat of an agent type that is off changes and lists nothing (PI-CAP-022).
  const refuseTurnedOff = (slot: ModelSelectionSlot): void => {
    const refusal = admission().typeRefusal(slot.roleId)
    if (refusal !== undefined) throw new Error(`The model of ${slot.roleId} cannot be listed or set: ${refusal}`)
  }

  return {
    async loadAssignments(query) {
      return (await controller(query.scope)).loadAssignments(assignable(query.slots))
    },
    async listModelOptions(query) {
      refuseTurnedOff(query.slot)
      return (await controller(query.scope)).listModelOptions(query.slot)
    },
    async listEffortOptions(query) {
      refuseTurnedOff(query.slot)
      return (await controller(query.scope)).listEffortOptions(query.slot, query.model)
    },
    async saveEffort(command) {
      const { slot, model, effort } = command
      refuseTurnedOff(slot)
      if (command.scope.kind === "defaults-and-session" && (await deps.roleCaptureStore.read(command.scope.sessionId))?.kind === "workflow-agent") {
        return (await controller({ kind: "session", sessionId: command.scope.sessionId })).saveEffort(slot, model, effort)
      }
      if (command.scope.kind === "defaults-and-session" && isProfileModelRole(slot.roleId)) {
        return (await controller({ kind: "session", sessionId: command.scope.sessionId })).saveEffort(slot, model, effort)
      }
      if (command.scope.kind !== "defaults-and-session") {
        return (await controller(command.scope)).saveEffort(slot, model, effort)
      }
      const defaults = await (await controller(DEFAULTS_SCOPE)).saveEffort(slot, model, effort)
      // Effort-inherit on a concrete model has no session-snapshot
      // representation, so the defaults write intentionally stands alone and
      // the open tab keeps its current assignment.
      if (model !== null && effort == null) return defaults
      try {
        await (await controller({ kind: "session", sessionId: command.scope.sessionId })).saveEffort(slot, model, effort)
        return { label: defaults.label, mirrored: true }
      } catch (err) {
        return { label: defaults.label, warning: `Default saved, but this tab was not updated: ${errorMessage(err)}`, mirrored: false }
      }
    },
    async resetDefaults(command) {
      // A reset changes only the roles that the settings offer: an off role keeps its saved value.
      const { admits } = admission()
      const slots = command.slots.filter((slot) => admits(slot.roleId))
      if (command.scope.kind === "defaults-and-session" && (await deps.roleCaptureStore.read(command.scope.sessionId))?.kind === "workflow-agent") {
        return { rows: await (await controller({ kind: "session", sessionId: command.scope.sessionId })).resetDefaults(slots, admits) }
      }
      if (command.scope.kind !== "defaults-and-session") {
        return { rows: await (await controller(command.scope)).resetDefaults(slots, admits) }
      }
      const rows = await (await controller(DEFAULTS_SCOPE)).resetDefaults(slots, admits)
      try {
        await (await controller({ kind: "session", sessionId: command.scope.sessionId })).resetDefaults(slots, admits)
        return { rows, mirrored: true }
      } catch (err) {
        return { rows, warning: `Defaults reset, but this tab was not updated: ${errorMessage(err)}`, mirrored: false }
      }
    },
    async modelRoles() {
      return { roles: modelRoles() }
    },
    async globalDefaultRoles() {
      return runtimeGlobalDefaultRoles(await materializeDefaults())
    },
  }
}

async function ensureSessionScopeBacked(
  scope: RuntimeModelAssignmentsQuery["scope"],
  deps: RuntimeModelAssignmentServiceDeps,
): Promise<void> {
  if (scope.kind === "defaults" || await deps.roleCaptureStore.read(scope.sessionId)) return

  const entry = deps.sessionStore.get(scope.sessionId)
  if (entry?.kind !== "chat") return

  try {
    await ensureDurableChatSession({
      sessionId: scope.sessionId,
      projectRoot: deps.projectRoot,
      manager: deps.roleCaptureStore,
      eventStore: deps.eventStore,
      projectionReader: deps.eventStore,
      eventWriter: deps.eventWriter,
    }, entry.conversationId)
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith(SESSION_ALREADY_EXISTS)) throw err
    await ensureDurableChatSession({
      sessionId: scope.sessionId,
      projectRoot: deps.projectRoot,
      manager: deps.roleCaptureStore,
      eventStore: deps.eventStore,
      projectionReader: deps.eventStore,
      eventWriter: deps.eventWriter,
    }, entry.conversationId)
  }
}

/** Everything a defaults resolution reads, as content: the configured roles
 *  and the profile's overlay, the persona roles, the enabled models by family,
 *  and the models with route metadata. */
function defaultRoleInputs(scoped: ModelPickerConfigDeps): string {
  const profileId = scoped.authProfileId?.()
  return JSON.stringify([
    profileId ?? null,
    profileId === undefined ? null : scoped.config.profiles[profileId]?.roles ?? null,
    [...scoped.configValidity?.roleIds ?? []].sort(),
    [...scoped.availableModels ?? []].map(([family, models]) => [family, [...models].sort()]).sort(),
    scoped.eligibilityRevision ?? null,
    [...scoped.modelInfos?.keys() ?? []].sort(),
  ])
}

function runtimeGlobalDefaultRoles(roles: RoleAssignments): RuntimeGlobalDefaultRolesResult {
  if (!roles.chat) return {}
  const { model, effort } = roles.chat
  return { chat: { model, effort: Schema.decodeUnknownSync(EffortSchema)(effort) } }
}
