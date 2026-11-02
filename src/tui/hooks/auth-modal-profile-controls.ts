import type { Accessor } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import type { RuntimeAuthProfileWriteScope } from "../../protocol/auth-profile-selection-protocol-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { createProfileEdit, renameProfileEdit } from "./auth-profile-edits.js"
import type { AuthProfileScopeLabel } from "./auth-profile-selection.js"
import type { AuthRow, AuthView } from "./auth-modal-options.js"
import type { ShellServices } from "./shell-state.js"

interface AuthModalProfileControlDeps {
  auth: Accessor<RuntimeAuthView | undefined>
  appService: Pick<RuntimeClient, "query" | "dispatch">
  showToast: ShellServices["showToast"]
  rows: Accessor<readonly AuthRow[]>
  cursor: Accessor<number>
  attemptPending: Accessor<boolean>
  baseScope: () => RuntimeAuthProfileWriteScope
  scopeMode: Accessor<"tab" | "defaults">
  setScopeMode: (mode: "tab" | "defaults") => void
  view: Accessor<AuthView>
  setEditor: (view: Extract<AuthView, { kind: "profile-create-input" | "profile-rename-input" }>, draft: string) => void
  setDeleteConfirmation: (view: Extract<AuthView, { kind: "profile-delete-confirmation" }>) => void
  beginAttempt: (kind: "profile") => { id: number }
  attemptCurrent: (id: number) => boolean
  settleAttempt: (id: number) => boolean
  restoreList: () => void
  invalidateProviderModels: () => void
  modelPolicy: () => { readonly override?: boolean; readonly revision?: number; readonly changing: boolean }
  setModelPolicy: (state: { readonly override?: boolean; readonly profileId?: string; readonly revision?: number; readonly changing: boolean; readonly feedback?: string }) => void
}

export function createAuthModalProfileControls(deps: AuthModalProfileControlDeps) {
  function profileLocked(): boolean {
    return deps.auth()?.profile.source === "environment"
  }

  function profileControlsAvailable(): boolean {
    return !deps.attemptPending() && deps.auth()?.profile !== undefined && !profileLocked()
  }

  function currentProfileRow(): Extract<AuthRow, { kind: "profile" }> | undefined {
    const row = deps.rows()[deps.cursor()]
    return row?.kind === "profile" ? row : undefined
  }

  function profileScopeLabel(): AuthProfileScopeLabel {
    return deps.baseScope().kind === "session" && deps.scopeMode() === "tab" ? "This Tab" : "New Session Defaults"
  }

  function profileSelectionScope(): RuntimeAuthProfileWriteScope {
    const base = deps.baseScope()
    if (base.kind !== "session" || deps.scopeMode() === "tab") return base
    return { kind: "defaults-and-session", sessionId: base.sessionId }
  }

  function toggleProfileScope(): void {
    if (!profileControlsAvailable() || currentProfileRow() === undefined) return
    if (deps.baseScope().kind !== "session") return
    deps.setScopeMode(deps.scopeMode() === "tab" ? "defaults" : "tab")
  }

  function handleListKey(key: string): boolean {
    const row = currentProfileRow()
    if (row === undefined) return false
    if (key === "a") { if (!deps.attemptPending()) void toggleModelPolicy(); return true }
    if (key === "g") { toggleProfileScope(); return true }
    if (key === "n") { beginProfileCreate(); return true }
    if (key === "r") { beginProfileRename(); return true }
    if (key === "d" && row.profile.availableProfiles.some((profile) => profile.id === row.profile.id)) {
      beginProfileDelete()
      return true
    }
    return false
  }

  async function toggleModelPolicy(): Promise<void> {
    const auth = deps.auth()
    const policy = auth?.autoEnableNewModels
    const state = deps.modelPolicy()
    if (auth === undefined || policy === undefined || state.changing || deps.attemptPending()) return
    const profileId = auth.profile.id
    const enabled = !(state.override ?? policy.enabled)
    deps.setModelPolicy({ override: state.override, profileId, revision: state.revision, changing: true })
    try {
      const result = await deps.appService.dispatch({ type: "provider_models.set_auto_enable", queriedProfileId: profileId, queriedEligibilityRevision: state.revision ?? policy.eligibilityRevision, enabled })
      if (deps.auth()?.profile.id !== profileId) return
      deps.setModelPolicy({ override: result.autoEnableNewModels, profileId: result.profileId, revision: result.eligibilityRevision, changing: false })
    } catch (error) {
      if (deps.auth()?.profile.id !== profileId) return
      deps.setModelPolicy({ profileId, changing: false, feedback: errorMessage(error) })
    }
  }

  const profileEditDeps = { auth: deps.auth, appService: deps.appService }

  function beginProfileCreate(): void {
    if (!profileControlsAvailable() || currentProfileRow() === undefined) return
    const edit = createProfileEdit(profileEditDeps)
    deps.setEditor({ kind: "profile-create-input", scope: profileSelectionScope() }, edit.initialDraft())
  }

  function beginProfileRename(): void {
    const profile = deps.auth()?.profile
    if (!profileControlsAvailable() || currentProfileRow() === undefined || profile === undefined) return
    const edit = renameProfileEdit(profileEditDeps, profile.id, profile.displayName)
    deps.setEditor({ kind: "profile-rename-input", id: profile.id, label: profile.displayName }, edit.initialDraft())
  }

  function beginProfileDelete(): void {
    const profile = deps.auth()?.profile
    if (!profileControlsAvailable() || currentProfileRow() === undefined || profile === undefined) return
    const view = { kind: "profile-delete-confirmation", phase: "loading", id: profile.id, label: profile.displayName, choice: "cancel" } as const
    void loadProfileDeletion(view)
  }

  async function loadProfileDeletion(view: Extract<AuthView, { kind: "profile-delete-confirmation" }>): Promise<void> {
    const identity = { kind: view.kind, id: view.id, label: view.label, choice: "cancel" } as const
    deps.setDeleteConfirmation({ ...identity, phase: "loading" })
    const attempt = deps.beginAttempt("profile")
    try {
      const preview = await deps.appService.query({ type: "authProfileDeletionPreview", id: view.id })
      if (!deps.settleAttempt(attempt.id)) return
      deps.setDeleteConfirmation({ ...identity, phase: "ready", preview })
    } catch (error) {
      if (!deps.settleAttempt(attempt.id)) return
      deps.setDeleteConfirmation({ ...identity, phase: "preview-error", error: errorMessage(error) })
    }
  }

  async function submitProfileDelete(): Promise<void> {
    const view = deps.view()
    if (view.kind !== "profile-delete-confirmation") return
    if (view.choice === "cancel") { deps.restoreList(); return }
    if (deps.attemptPending()) return
    if (view.phase === "preview-error") { await loadProfileDeletion(view); return }
    if (view.phase !== "ready") return
    const successorId = view.preview.kind === "fresh-default" ? null : view.preview.kind === "automatic" ? view.preview.successor.id : view.successorId
    if (successorId === undefined) return
    const attempt = deps.beginAttempt("profile")
    deps.invalidateProviderModels()
    try {
      const result = await deps.appService.dispatch({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: view.id, successorId })
      if (!deps.attemptCurrent(attempt.id)) return
      if (result === undefined) {
        deps.settleAttempt(attempt.id)
        deps.showToast({ message: "Auth profile deletion returned no result", variant: "error" })
        deps.setDeleteConfirmation({ ...view, error: "Auth profile deletion returned no result" })
        return
      }
      if ("ok" in result && result.ok === false) {
        deps.settleAttempt(attempt.id)
        deps.showToast({ message: result.error, variant: "error" })
        deps.setDeleteConfirmation({ ...view, error: result.error })
        return
      }
      if ("warning" in result && typeof result.warning === "string") deps.showToast({ message: result.warning, variant: "warning", duration: 8000 })
      else deps.showToast({ message: `Profile ${view.label} deleted`, variant: "success" })
      if (!deps.settleAttempt(attempt.id)) return
      deps.restoreList()
    } catch (err) {
      if (!deps.settleAttempt(attempt.id)) return
      deps.showToast({ message: errorMessage(err), variant: "error" })
      deps.setDeleteConfirmation({ ...view, error: errorMessage(err) })
    }
  }

  async function selectProfile(profile: { id: string; displayName: string }): Promise<void> {
    if (!profileControlsAvailable()) return
    const attempt = deps.beginAttempt("profile")
    deps.invalidateProviderModels()
    try {
      const result = await deps.appService.dispatch({ type: "auth.profile.select", scope: profileSelectionScope(), id: profile.id })
      if (!deps.attemptCurrent(attempt.id)) return
      if (result === undefined) {
        deps.settleAttempt(attempt.id)
        deps.showToast({ message: "Auth profile selection returned no result", variant: "error" })
        return
      }
      if ("ok" in result && result.ok === false) {
        deps.settleAttempt(attempt.id)
        deps.showToast({ message: "error" in result && typeof result.error === "string" ? result.error : "Auth profile selection failed", variant: "error" })
        return
      }
      if ("warning" in result && typeof result.warning === "string") deps.showToast({ message: result.warning, variant: "warning", duration: 8000 })
      else deps.showToast({ message: `Auth profile set to ${profile.displayName}`, variant: "success" })
      if (!deps.settleAttempt(attempt.id)) return
      deps.restoreList()
    } catch (err) {
      if (!deps.settleAttempt(attempt.id)) return
      deps.showToast({ message: errorMessage(err), variant: "error" })
    }
  }

  return { profileScopeLabel, profileControlsAvailable, handleListKey, toggleProfileScope, toggleModelPolicy, beginProfileCreate, beginProfileRename, beginProfileDelete, submitProfileDelete, selectProfile }
}
