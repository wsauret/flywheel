import { errorMessage } from "../../infra/error-message.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { SettingsEditResult, SettingsEditSpec } from "./settings-modal-types.js"
import { AUTH_PROFILE_PENDING } from "./auth-profile-selection.js"
import type { RuntimeAuthProfileWriteScope } from "../../protocol/auth-profile-selection-protocol-types.js"

interface AuthProfileEditDeps {
  auth: () => RuntimeAuthView | undefined
  appService: Pick<RuntimeClient, "dispatch">
  onWarning?: (message: string) => void
}

async function submitProfileEdit(
  deps: AuthProfileEditDeps,
  command: Parameters<AuthProfileEditDeps["appService"]["dispatch"]>[0],
): Promise<SettingsEditResult> {
  try {
    const result = await deps.appService.dispatch(command)
    if (result === undefined) return { ok: false, error: "Auth profile command returned no result" }
    if ("ok" in result && result.ok === false) {
      const message = "error" in result && typeof result.error === "string" ? result.error : "Auth profile command failed"
      return { ok: false, error: message }
    }
    if ("warning" in result && typeof result.warning === "string") deps.onWarning?.(result.warning)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

export function createProfileEdit(deps: AuthProfileEditDeps, scope: RuntimeAuthProfileWriteScope = { kind: "defaults" }): SettingsEditSpec {
  return {
    hint: "Enter a display name for the new auth profile.",
    current: () => deps.auth()?.profile.displayName ?? "",
    initialDraft: () => "",
    submit: (draft: string): SettingsEditResult | Promise<SettingsEditResult> => {
      const displayName = draft.trim()
      if (!displayName) return { ok: false, error: "Enter a profile name" }
      return submitProfileEdit(deps, { type: "auth.profile.create", scope, displayName })
    },
  }
}

export function renameProfileEdit(deps: AuthProfileEditDeps, id: string, currentDisplayName: string): SettingsEditSpec {
  return {
    hint: `Enter a new display name for the ${currentDisplayName} auth profile.`,
    current: () => currentDisplayName,
    initialDraft: () => currentDisplayName,
    submit: (draft: string): SettingsEditResult | Promise<SettingsEditResult> => {
      const displayName = draft.trim()
      if (!displayName) return { ok: false, error: "Enter a profile name" }
      if (!deps.auth()) return { ok: false, error: AUTH_PROFILE_PENDING }
      return submitProfileEdit(deps, { type: "auth.profile.rename", scope: { kind: "defaults" }, id, displayName })
    },
  }
}
