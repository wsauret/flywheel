import type { AsyncEventReadSurface } from "../../infra/event-store-types.js"
import { resolveCurrentRoles } from "./model-selection.js"
import { canonicalRoleId, RETIRED_COMPACTION_ROLE_IDS } from "./retired-config-names.js"
import { parentRoleId, type ResolvedRole, type ResolvedRoles, type RoleId, type RoleResolver } from "./roles.js"
import { parseBriefRoleId, briefPersonaRoleId, briefAtRoleId, briefRoleId } from "../../protocol/brief-role-id.js"
import type { FlywheelConfig } from "./schema.js"
import type { ModelFamily } from "../../infra/llm/model-family.js"
import type { ModelInfo, ModelsClient } from "../../infra/llm/models.js"
import { offeringTransportFamily } from "../../infra/llm/model-catalog-resolution.js"
import type { PickerModelEligibility } from "./provider-model-eligibility.js"
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js"
import { normalizeRoleAssignments, type RoleAssignmentEntry, type RoleAssignments, type RoleAssignmentSnapshot, type RoleSettingEntry, type RoleSettings } from "../session/schemas.js"
import { createSingleSessionMetadataProjection } from "../session/session-metadata-projection.js"
import { registeredRoleIds, captureRoleResolver, resolveRoleFromModels, type RoleSetting } from "./role-resolution.js"
import { beginTierResolutionOperation, type TierResolutionOptions } from "./model-tiers.js"
import type { CaptureProviderConnection, ProviderConnectionCapture } from "../agent-runtime/factory.js"
import { workflowRunOwner } from "../module-catalog.js"

type MaterializeRoleSnapshotDeps = {
  readonly userDataRoot: string
  readonly availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined
  readonly modelInfos?: Pick<ReadonlyMap<string, ModelInfo>, "get" | "keys">
  readonly modelsClient?: ModelsClient
  readonly personaRoleIds?: ReadonlySet<string>
} & (
  | { readonly config: Pick<FlywheelConfig, "profiles">; readonly activeProfileId?: string; readonly profileRoles?: never }
  | { readonly config?: never; readonly activeProfileId?: never; readonly profileRoles: FlywheelConfig["profiles"][string]["roles"] }
)

function roleAssignmentsFromResolvedRoles(roles: ResolvedRoles): RoleAssignments {
  return Object.fromEntries([...roles].map(([roleId, role]) => [roleId, roleAssignmentEntryFromSelection(role)]))
}

/** Chooses one whole saved object before applying independently fixed launch fields.
 * Profile settings stay live. The defaults table contains only authored launch fields. */
export function effectiveRoleAssignments(snapshot: RoleAssignmentSnapshot, profileRoles: RoleSettings = {}): RoleSettings {
  const defaults = normalizeRoleAssignments(snapshot.defaults)
  const overrides = normalizeRoleAssignments(snapshot.overrides)
  const profile = Object.fromEntries(Object.entries(normalizeRoleAssignments(profileRoles)).filter(([id]) => parseBriefRoleId(id) === undefined))
  const settings: { [roleId: string]: RoleSettingEntry } = {}
  const ids = new Set([...Object.keys(profile), ...Object.keys(overrides)])
  for (const id of ids) {
    if (RETIRED_COMPACTION_ROLE_IDS.has(id)) continue
    settings[id] = applicableSetting(id, overrides) ?? applicableSetting(id, profile) ?? {}
  }
  for (const [id, fixed] of Object.entries(defaults)) {
    const selector = parseBriefRoleId(id)
    if (selector?.definitionId === undefined) continue
    const follows = overrides[id] ?? applicableSetting(briefAtRoleId(selector.briefId, selector.definitionId), overrides)
      ?? applicableSetting(briefRoleId(selector.briefId), overrides)
      ?? applicableSetting(briefRoleId(selector.briefId), profile) ?? {}
    settings[briefAtRoleId(selector.briefId, selector.definitionId)] = { ...follows, ...fixed }
  }
  return settings
}

function applicableSetting(roleId: string, settings: RoleSettings): RoleSettingEntry | undefined {
  const selector = parseBriefRoleId(roleId)
  const role = selector?.personaRole ?? roleId
  const parent = parentRoleId(role)
  const chain = selector?.personaRole
    ? [roleId, ...(parent ? [briefPersonaRoleId(selector.briefId, parent)] : []), role, ...(parent ? [parent] : [])]
    : selector ? [roleId, briefRoleId(selector.briefId), "workflow-agent"] : [roleId, ...(parent ? [parent] : [])]
  return chain.map((id) => settings[id]).find((setting) => setting !== undefined)
}

/** Builds authored role policy, leaving absent fields to inherit from the profile. */
export function roleAssignmentEntryFromSelection(
  input: { model: string; effort: string; providerOptions?: ProviderRequestOptions },
): RoleAssignmentEntry
export function roleAssignmentEntryFromSelection(input: RoleSettingEntry): RoleSettingEntry
export function roleAssignmentEntryFromSelection(input: RoleSettingEntry): RoleSettingEntry {
  return {
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
  }
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

/** Groups one eligibility decision's effective model IDs for role previews. */
export function enabledModelsFromEligibility(entries: Iterable<readonly [string, PickerModelEligibility]>): ReadonlyMap<ModelFamily, ReadonlySet<string>> {
  const available = new Map<ModelFamily, Set<string>>()
  for (const [modelId, eligibility] of entries) {
    if (eligibility.transport === undefined) continue
    const family = offeringTransportFamily(eligibility.transport)
    const models = available.get(family) ?? new Set<string>()
    models.add(modelId)
    available.set(family, models)
  }
  return available
}

/** Computes a transient preview. Callers must not persist this resolved map as session policy. */
export async function captureRoleAssignments(deps: MaterializeRoleSnapshotDeps): Promise<RoleAssignments> {
  const roles = deps.config !== undefined
    ? await resolveCurrentRoles({ ...deps, additionalRoleIds: deps.personaRoleIds, authProfileId: deps.activeProfileId === undefined ? undefined : () => deps.activeProfileId ?? "" })
    : await resolveCurrentRoles({ ...deps, additionalRoleIds: deps.personaRoleIds })
  return roleAssignmentsFromResolvedRoles(roles)
}

/** Installs empty authored settings once, without catalog reads or generated defaults. */
export async function ensureSessionRoleSnapshot(deps: {
  manager: {
    read(id: string): Promise<{ roleAssignments?: RoleAssignmentSnapshot } | null>
    captureRolesIfAbsent(id: string, roles: RoleSettings): Promise<boolean>
  }
  sessionId: string
}): Promise<RoleSettings> {
  const session = await deps.manager.read(deps.sessionId)
  if (!session) throw new Error(`Session not found: ${deps.sessionId}`)
  if (session.roleAssignments) return effectiveRoleAssignments(session.roleAssignments)
  await deps.manager.captureRolesIfAbsent(deps.sessionId, {})
  const current = await deps.manager.read(deps.sessionId)
  if (!current) throw new Error(`Session not found: ${deps.sessionId}`)
  return effectiveRoleAssignments(current.roleAssignments ?? { defaults: {}, overrides: {} })
}

/** Resolves replayed authored fields against the current immutable profile capture.
 * No request selection is written back to session metadata. */
export async function resolveSessionRoles(snapshot: RoleAssignmentSnapshot, capture: ProviderConnectionCapture, userDataRoot: string, additionalRoleIds: Iterable<string> = [], inherited?: RoleAssignmentSnapshot): Promise<ResolvedRoles> {
  const resolve = captureRoleResolver({
    selection: capture.providers.selection, connection: capture.connection, eligibility: capture.eligibility, allowTrainingRoutes: capture.runtimeConfig.allowTrainingRoutes,
  }, userDataRoot)
  return resolveSessionSettings(snapshot, capture.runtimeConfig.profileRoles, async (roleId, setting) => {
    const result = await resolve(roleId, setting)
    return result.kind === "selected" ? result.role : undefined
  }, additionalRoleIds, undefined, inherited)
}

/** Previews the same authored policy as requests, using the picker's admitted catalog.
 * Only `requestedRoleIds` resolve. A request resolves a brief seat only when a
 * setting names it, so a preview never generates one either: an unset seat
 * falls through to the next seat that its agent reads. */
export function previewSessionRoles(snapshot: RoleAssignmentSnapshot, profileRoles: FlywheelConfig["profiles"][string]["roles"], available: ReadonlyMap<ModelFamily, ReadonlySet<string>>, options: TierResolutionOptions, requestedRoleIds: Iterable<string>): Promise<ResolvedRoles> {
  const operation = beginTierResolutionOperation(options)
  const requested = new Set(requestedRoleIds)
  const generated = [...requested].filter((roleId) => parseBriefRoleId(roleId) === undefined)
  return resolveSessionSettings(snapshot, profileRoles, (roleId, setting) => resolveRoleFromModels(roleId, setting, available, operation), generated, requested)
}

async function resolveSessionSettings(snapshot: RoleAssignmentSnapshot, profileRoles: FlywheelConfig["profiles"][string]["roles"], resolve: (roleId: string, setting: RoleSetting) => Promise<ResolvedRole | undefined>, additionalRoleIds: Iterable<string>, onlyRoleIds?: ReadonlySet<string>, inherited?: RoleAssignmentSnapshot): Promise<ResolvedRoles> {
  const profile = Object.fromEntries(Object.entries(profileRoles).filter(([id]) => parseBriefRoleId(canonicalRoleId(id)) === undefined).map(([id, role]) => [canonicalRoleId(id), {
    model: role.model, effort: role.effort, providerOptions: role.provider_options,
  }]))
  const settings = inherited
    ? { ...effectiveRoleAssignments(inherited, profile), ...normalizeRoleAssignments(snapshot.overrides) }
    : effectiveRoleAssignments(snapshot, profile)
  const ids = new Set([...registeredRoleIds(additionalRoleIds), ...Object.keys(settings)])
  const roles = new Map<RoleId, ResolvedRole>()
  for (const roleId of ids) {
    if (onlyRoleIds && !onlyRoleIds.has(roleId)) continue
    const setting = applicableSetting(roleId, settings) ?? applicableSetting(roleId, profile) ?? {}
    const selector = parseBriefRoleId(roleId)
    const fixedEntry = selector?.definitionId === undefined ? undefined : Object.entries({ ...inherited?.defaults, ...snapshot.defaults }).find(([id]) => {
      const fixed = parseBriefRoleId(id)
      return fixed?.definitionId === selector.definitionId && fixed.briefId === selector.briefId && fixed.fixed === "effort"
    })?.[1]
    const fixedEffort = fixedEntry?.effort
    const role = await resolve(selector?.personaRole ?? roleId, { model: setting.model, effort: setting.effort, fixedEffort, provider_options: setting.providerOptions })
    if (role) roles.set(roleId, {
      ...role,
      roleId,
      setting: { ...setting, ...(fixedEffort === undefined ? {} : { fixedEffort }) },
      ...(applicableSetting(roleId, snapshot.overrides) ? { settingScope: "session" as const } : applicableSetting(roleId, profile) ? { settingScope: "profile" as const } : {}),
    })
  }
  return roles
}

export function createSessionRoleResolver(deps: {
  projectRoot: string
  sessionId: string
  reader: AsyncEventReadSurface
  userDataRoot?: string
  capture?: CaptureProviderConnection
  requiredRoleIds?: ReadonlySet<string>
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
      ? resolveSessionRoles(snapshot, capture, deps.userDataRoot ?? deps.projectRoot, deps.requiredRoleIds, inherited?.roleAssignments)
      : resolvedRolesFromAssignments(inherited ? { ...effectiveRoleAssignments(inherited.roleAssignments), ...normalizeRoleAssignments(snapshot.overrides) } : effectiveRoleAssignments(snapshot))
  }
}
