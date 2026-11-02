import { errorMessage } from "../../infra/error-message.js"
import type { ConfigWriteResult } from "../config/writer.js"
import type { AuthProfileManager, AuthProfileResolution } from "../auth/auth-profile-manager.js"
import type { SessionManager } from "../session/manager.js"
import type { RoleAssignments } from "../session/schemas.js"
import type {
  RuntimeAuthProfileBindMutation,
  RuntimeAuthProfileBindResult,
  RuntimeAuthProfileCreateMutation,
  RuntimeAuthProfileCreateResult,
  RuntimeAuthProfileDeleteMutation,
  RuntimeAuthProfileDeleteResult,
  RuntimeAuthProfileDeletionPreview,
  RuntimeAuthProfileMutation,
  RuntimeAuthProfileMutationResult,
  RuntimeAuthProfileRenameMutation,
  RuntimeAuthProfileRenameResult,
  RuntimeAuthProfileSelectMutation,
  RuntimeAuthProfileSelectResult,
  RuntimeAuthProfileWriteScope,
  RuntimeAuthProfileUnbindMutation,
  RuntimeAuthProfileUnbindResult,
} from "../../protocol/auth-profile-selection-protocol-types.js"

export interface RuntimeAuthProfileSelectionServiceDeps {
  readonly profileManager: Pick<AuthProfileManager, "resolve" | "create" | "select" | "rename" | "bind" | "unbind" | "delete" | "previewDelete">
  readonly sessionManager: Pick<SessionManager, "read" | "selectAuthProfileWithRoleSnapshot">
  /** Selects a workflow's profile, which every agent of the workflow runs
   *  on. Resolves false when the workflow is gone. */
  readonly selectWorkflowProfile: (workflowId: string, profileId: string) => Promise<boolean>
  readonly prepareSessionTarget: (profileId: string) => Promise<{
    readonly roles: RoleAssignments
    readonly publish: (scope: RuntimeAuthProfileWriteScope) => Promise<void>
  }>
  readonly refresh?: (profileId?: string) => Promise<void>
  readonly preRemoveProfile?: (profileId: string) => Promise<() => void>
}

export interface RuntimeAuthProfileSelectionService {
  previewDelete(id: string): Promise<RuntimeAuthProfileDeletionPreview>
  mutate(command: RuntimeAuthProfileMutation): Promise<RuntimeAuthProfileMutationResult>
  select(command: RuntimeAuthProfileSelectMutation): Promise<RuntimeAuthProfileSelectResult>
  create(command: RuntimeAuthProfileCreateMutation): Promise<RuntimeAuthProfileCreateResult>
  rename(command: RuntimeAuthProfileRenameMutation): Promise<RuntimeAuthProfileRenameResult>
  bindCurrentProject(command: RuntimeAuthProfileBindMutation): Promise<RuntimeAuthProfileBindResult>
  unbindCurrentProject(command: RuntimeAuthProfileUnbindMutation): Promise<RuntimeAuthProfileUnbindResult>
  delete(command: RuntimeAuthProfileDeleteMutation): Promise<RuntimeAuthProfileDeleteResult>
  refresh(profileId?: string): Promise<void>
}

export function createRuntimeAuthProfileSelectionService(
  deps: RuntimeAuthProfileSelectionServiceDeps,
): RuntimeAuthProfileSelectionService {
  async function refresh(profileId?: string): Promise<void> {
    await deps.refresh?.(profileId)
  }

  async function select(command: RuntimeAuthProfileSelectMutation): Promise<RuntimeAuthProfileSelectResult> {
    const resolution = await deps.profileManager.resolve()
    const session = await preflightSelection(command, resolution, deps.sessionManager)
    // An agent of a workflow has no profile of its own: selecting one for it
    // selects its workflow's, which publishes every scope the run backs.
    const workflowId = session?.kind === "workflow-agent" ? session.workflowMembership.workflowId : undefined
    if (command.scope.kind === "session" && workflowId !== undefined) {
      return await deps.selectWorkflowProfile(workflowId, command.id) ? { id: command.id, mirrored: true } : { id: command.id, mirrored: false, warning: "This tab was not updated" }
    }
    const changesSession = command.scope.kind !== "defaults" && workflowId === undefined && session?.authProfileId !== command.id
    const target = changesSession ? await deps.prepareSessionTarget(command.id) : undefined

    if (command.scope.kind === "session") {
      if (!target) return { id: command.id, mirrored: true }
      const mirrored = await deps.sessionManager.selectAuthProfileWithRoleSnapshot(command.scope.sessionId, command.id, {})
      if (!mirrored) return { id: command.id, mirrored: false, warning: "This tab was not updated" }
      await target.publish(command.scope)
      return { id: command.id, mirrored: true }
    }

    await deps.profileManager.select(command.id)
    const effective = await deps.profileManager.resolve()
    const projectWarning = effective.source === "project" && effective.id !== command.id
      ? `Default profile saved, but this project still uses ${effective.displayName} because it is pinned.`
      : undefined
    if (command.scope.kind === "defaults") {
      await refresh(command.id)
      return projectWarning === undefined ? { id: command.id } : { id: command.id, warning: projectWarning }
    }

    let result: RuntimeAuthProfileSelectResult
    let mirrored = true
    if (workflowId !== undefined) {
      mirrored = await deps.selectWorkflowProfile(workflowId, command.id)
      result = mirrored ? { id: command.id, mirrored: true } : { id: command.id, mirrored: false, warning: "Default selected, but this tab was not updated" }
      await refresh(command.id)
      return projectWarning === undefined ? result : { ...result, warning: result.warning === undefined ? projectWarning : `${projectWarning} ${result.warning}` }
    }
    if (!target) {
      result = { id: command.id, mirrored: true }
    } else {
      try {
        mirrored = await deps.sessionManager.selectAuthProfileWithRoleSnapshot(command.scope.sessionId, command.id, {})
        result = mirrored
          ? { id: command.id, mirrored: true }
          : { id: command.id, mirrored: false, warning: "Default selected, but this tab was not updated" }
      } catch (error) {
        result = {
          id: command.id,
          mirrored: false,
          warning: `Default selected, but this tab was not updated: ${errorMessage(error)}`,
        }
        mirrored = false
      }
    }
    if (target && mirrored) await target.publish(command.scope)
    if (!target) await refresh(command.id)
    return projectWarning === undefined ? result : { ...result, warning: result.warning === undefined ? projectWarning : `${projectWarning} ${result.warning}` }
  }

  async function create(command: RuntimeAuthProfileCreateMutation): Promise<RuntimeAuthProfileCreateResult> {
    const before = await deps.profileManager.resolve()
    await preflightScope(command.scope, before, deps.sessionManager)
    const id = await deps.profileManager.create(command.displayName)
    return select({ type: "auth.profile.select", scope: command.scope, id })
  }

  async function rename(command: RuntimeAuthProfileRenameMutation): Promise<RuntimeAuthProfileRenameResult> {
    const resolution = await deps.profileManager.resolve()
    if (resolution.source === "environment") throw new Error("cannot rename the environment-selected auth profile")
    await deps.profileManager.rename(command.id, command.displayName)
    await refresh()
    return { id: command.id, displayName: command.displayName }
  }

  async function bindCurrentProject(command: RuntimeAuthProfileBindMutation): Promise<RuntimeAuthProfileBindResult> {
    const result = await deps.profileManager.bind(command.id)
    ensureConfigWriteSucceeded(result)
    await refresh()
    return result.durabilityError === undefined
      ? { id: command.id }
      : { id: command.id, warning: result.durabilityError.message }
  }

  async function unbindCurrentProject(_command: RuntimeAuthProfileUnbindMutation): Promise<RuntimeAuthProfileUnbindResult> {
    const result = await deps.profileManager.unbind()
    ensureConfigWriteSucceeded(result)
    await refresh()
    return result.durabilityError === undefined
      ? { bound: false }
      : { bound: false, warning: result.durabilityError.message }
  }

  async function deleteProfile(command: RuntimeAuthProfileDeleteMutation): Promise<RuntimeAuthProfileDeleteResult> {
    const result = await deps.profileManager.delete(command.id, deps.preRemoveProfile, command.successorId)
    ensureConfigWriteSucceeded(result)
    await refresh()
    return result.durabilityError === undefined ? { id: command.id } : { id: command.id, warning: result.durabilityError.message }
  }

  async function mutate(command: RuntimeAuthProfileMutation): Promise<RuntimeAuthProfileMutationResult> {
    switch (command.type) {
      case "auth.profile.select": return select(command)
      case "auth.profile.create": return create(command)
      case "auth.profile.rename": return rename(command)
      case "auth.profile.bind_current_project": return bindCurrentProject(command)
      case "auth.profile.unbind_current_project": return unbindCurrentProject(command)
      case "auth.profile.delete": return deleteProfile(command)
    }
  }

  return { mutate, select, create, rename, bindCurrentProject, unbindCurrentProject, delete: deleteProfile, refresh, previewDelete: (id) => deps.profileManager.previewDelete(id) }
}

async function preflightSelection(
  command: RuntimeAuthProfileSelectMutation,
  resolution: AuthProfileResolution,
  sessionManager: Pick<SessionManager, "read">,
): Promise<Awaited<ReturnType<Pick<SessionManager, "read">["read"]>> | undefined> {
  if (resolution.source === "environment") throw new Error("cannot switch the environment-selected auth profile")
  if (!resolution.availableProfiles.some((profile) => profile.id === command.id)) throw new Error(`auth profile does not exist: ${command.id}`)
  if (command.scope.kind === "defaults") return undefined

  return preflightScope(command.scope, resolution, sessionManager)
}

async function preflightScope(
  scope: RuntimeAuthProfileWriteScope,
  resolution: AuthProfileResolution,
  sessionManager: Pick<SessionManager, "read">,
): Promise<Awaited<ReturnType<Pick<SessionManager, "read">["read"]>> | undefined> {
  if (resolution.source === "environment") throw new Error("cannot switch the environment-selected auth profile")
  if (scope.kind === "defaults") return undefined
  const session = await sessionManager.read(scope.sessionId)
  if (!session) throw new Error(`Session not found: ${scope.sessionId}`)
  return session
}

function ensureConfigWriteSucceeded(result: ConfigWriteResult): asserts result is Extract<ConfigWriteResult, { readonly ok: true }> {
  if (!result.ok) throw result.error
}
