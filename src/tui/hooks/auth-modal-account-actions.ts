import { errorMessage } from "../../infra/error-message.js"
import type { CredentialProviderId } from "../../infra/auth/auth-store-types.js"
import type { AuthModalDeps } from "./auth-modal-types.js"
import type { SettingsEditSpec, SettingsEditResult } from "./settings-modal-types.js"

type AuthModalAccountActionDeps = Pick<AuthModalDeps, "auth" | "appService" | "showToast"> & {
  beginAttempt: () => { id: number }
  settleAttempt: (id: number) => boolean
}

/** Disconnect and rename, sent to the runtime that serves this session. The
 *  runtime owns every credential write and republishes the auth view; each
 *  request names the profile the modal shows. */
export function createAuthModalAccountActions(deps: AuthModalAccountActionDeps) {
  function shownProfileId(): string {
    const profileId = deps.auth()?.profile.id
    if (profileId === undefined) throw new Error("Auth profile is unavailable")
    return profileId
  }

  async function disconnect(providerId: CredentialProviderId, label: string, instanceId?: string): Promise<void> {
    const attempt = deps.beginAttempt()
    try {
      const result = await deps.appService.dispatch({ type: "auth.account.disconnect", providerId, profileId: shownProfileId(), ...(instanceId === undefined ? {} : { instanceId }) })
      if (!result.ok) throw new Error(result.error)
      if (!deps.settleAttempt(attempt.id)) return
      deps.showToast({ message: `${label} disconnected`, variant: "success" })
    } catch (err) {
      if (!deps.settleAttempt(attempt.id)) return
      deps.showToast({ message: `${label} disconnect failed: ${errorMessage(err)}`, variant: "error" })
    }
  }

  function renameEdit(providerId: CredentialProviderId, instanceId: string): SettingsEditSpec {
    const current = () => deps.auth()?.providers.find((provider) => provider.providerId === providerId)?.accounts.find((account) => account.instanceId === instanceId)?.label ?? ""
    return {
      hint: "Leave blank to clear the account label.",
      current, initialDraft: current,
      submit: async (draft): Promise<SettingsEditResult> => {
        const label = draft.trim()
        try {
          const result = await deps.appService.dispatch({ type: "auth.account.rename", providerId, instanceId, profileId: shownProfileId(), ...(label === "" ? {} : { label }) })
          return result.ok ? { ok: true } : { ok: false, error: `Account rename failed: ${result.error}` }
        } catch (err) {
          return { ok: false, error: `Account rename failed: ${errorMessage(err)}` }
        }
      },
    }
  }

  return { disconnect, renameEdit }
}
