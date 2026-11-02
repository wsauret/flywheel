import type { Accessor } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { RuntimeAuthProfileScope } from "../../protocol/auth-profile-selection-protocol-types.js"
import type { ShellServices } from "./shell-state.js"

export const AUTH_PROFILE_PENDING = "Auth profiles are unavailable until the runtime publishes its auth view"

export type AuthProfileScopeLabel = "This Tab" | "New Session Defaults"

export interface AuthProfileSelection {
  scope: () => RuntimeAuthProfileScope
  scopeLabel: () => AuthProfileScopeLabel
  select: (id: string, displayName: string) => Promise<void>
}

/** Adapts profile selection to the foreground tab or account defaults and owns result feedback. */
export function createAuthProfileSelection(deps: {
  appService: Pick<RuntimeClient, "dispatch">
  foregroundSessionId: Accessor<string | undefined>
  showToast: ShellServices["showToast"]
  /** Asks the newly active profile's paid-use question; resolves whether one opened. */
  reviewActiveProfile?: () => Promise<boolean>
}): AuthProfileSelection {
  function scope(): RuntimeAuthProfileScope {
    const sessionId = deps.foregroundSessionId()
    return sessionId === undefined ? { kind: "defaults" } : { kind: "session", sessionId }
  }

  function scopeLabel(): AuthProfileScopeLabel {
    return scope().kind === "session" ? "This Tab" : "New Session Defaults"
  }

  async function select(id: string, displayName: string): Promise<void> {
    try {
      const selectionScope = scope()
      const selected = await deps.appService.dispatch({ type: "auth.profile.select", scope: selectionScope, id })
      if (selected === undefined) {
        deps.showToast({ message: "Auth profile selection returned no result", variant: "error" })
        return
      }
      if ("ok" in selected && selected.ok === false) {
        const message = "error" in selected && typeof selected.error === "string" ? selected.error : "Auth profile selection failed"
        deps.showToast({ message, variant: "error" })
        return
      }
      await deps.reviewActiveProfile?.()
      if ("warning" in selected && typeof selected.warning === "string") {
        deps.showToast({ message: selected.warning, variant: "warning", duration: 8000 })
        return
      }
      deps.showToast({ message: `Auth profile set to ${displayName}`, variant: "success" })
    } catch (err) {
      deps.showToast({ message: errorMessage(err), variant: "error" })
    }
  }

  return { scope, scopeLabel, select }
}
