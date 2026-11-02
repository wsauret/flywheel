import { createSignal } from "solid-js"
import type { CredentialProviderId } from "../../infra/auth/auth-store-types.js"
import type { AuthModalDeps } from "./auth-modal-types.js"
import { soleAccount, type AuthRow, type AuthView } from "./auth-modal-options.js"
import type { SettingsEditSpec } from "./settings-modal-types.js"
import { createProfileEdit, renameProfileEdit } from "./auth-profile-edits.js"
import { createTerminalSettingEdit } from "./terminal-setting-edit.js"

/** Auth names use the same completion and pending-write owner as Settings. */
export function createAuthModalSettingEdits(deps: Pick<AuthModalDeps, "auth" | "appService" | "showToast"> & {
  view: () => AuthView
  draft: () => string
  leave: () => void
  accountEdit: (providerId: CredentialProviderId, instanceId: string) => SettingsEditSpec
}) {
  const [error, setError] = createSignal<string | undefined>()
  const profileDeps = { ...deps, onWarning: (message: string) => deps.showToast({ message, variant: "warning", duration: 8000 }) }
  function target() {
    const view = deps.view()
    if (view.kind === "profile-rename-input") return { id: `profile:${view.id}`, edit: renameProfileEdit(profileDeps, view.id, view.label) }
    if (view.kind === "profile-create-input") return { id: "profile:create", edit: createProfileEdit(profileDeps, view.scope), action: true }
    if (view.kind === "rename-input") return { id: `account:${view.providerId}:${view.instanceId}`, edit: deps.accountEdit(view.providerId, view.instanceId) }
    return undefined
  }
  const completion = createTerminalSettingEdit({
    target, draft: deps.draft, leave: deps.leave, setError,
    onError: (message) => deps.showToast({ message, variant: "error" }),
  })
  function projectedView(): AuthView {
    const current = deps.view()
    const edit = target()
    return edit && (current.kind === "rename-input" || current.kind === "profile-rename-input" || current.kind === "profile-create-input")
      ? { ...current, saving: completion.saving(edit.id), error: error() } : current
  }
  function projectedRows(rows: AuthRow[]): AuthRow[] {
    return rows.map((row) => {
      const account = row.kind === "account" ? row.account : row.kind === "provider" ? soleAccount(row.option) : undefined
      const id = row.kind === "profile" ? `profile:${row.profile.id}` : account && (row.kind === "account" || row.kind === "provider") ? `account:${row.option.id}:${account.instanceId}` : undefined
      return id === undefined ? row : { ...row, saving: completion.saving(id) }
    })
  }
  return { ...completion, view: projectedView, rows: projectedRows, clearError: () => setError(undefined), pending: () => { const current = target(); return current !== undefined && completion.saving(current.id) } }
}
