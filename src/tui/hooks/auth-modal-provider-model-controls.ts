import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { ProviderModelTarget } from "../../protocol/provider-model-preference-protocol-types.js"
import type { AuthView } from "./auth-modal-options.js"

type ProviderSettingsView = Extract<AuthView, { readonly kind: "provider-settings" }>

interface ProviderModelControlsDeps {
  readonly view: () => AuthView
  readonly profileId: () => string | undefined
  readonly dispatch: RuntimeClient["dispatch"]
  readonly query: RuntimeClient["query"]
  readonly setView: (view: ProviderSettingsView) => void
  readonly closeConsent: () => void
  readonly loadModels: (target: ProviderModelTarget, title: string, originCursor: number) => Promise<void>
}

/** Owns provider-settings actions that read or replace account model policy. */
export function createAuthModalProviderModelControls(deps: ProviderModelControlsDeps) {
  function openModels(): void {
    const view = deps.view()
    if (view.kind !== "provider-settings" || !view.option.modelSelectionAvailable) return
    deps.closeConsent()
    void deps.loadModels(view.target.modelTarget, view.option.label, view.originCursor)
  }

  async function toggleFreeRoutes(): Promise<void> {
    const view = deps.view()
    const profileId = deps.profileId()
    if (view.kind !== "provider-settings" || view.freeRoutes === undefined || view.freeRoutes.changing || profileId === undefined) return
    const previous = view.freeRoutes
    deps.setView({ ...view, freeRoutes: { ...previous, changing: true } })
    try {
      const result = await deps.dispatch({ type: "provider_free_routes.set", queriedProfileId: profileId, queriedEligibilityRevision: previous.eligibilityRevision, target: view.target.modelTarget, enabled: !previous.enabled })
      const current = deps.view()
      if (current.kind !== "provider-settings" || current.option.id !== view.option.id) return
      if ("hidden" in result) {
        const { freeRoutes: _removed, ...withoutFreeRoutes } = current
        deps.setView(withoutFreeRoutes)
        return
      }
      if (result.freeRoutes === undefined) {
        const { freeRoutes: _removed, ...withoutFreeRoutes } = current
        deps.setView(withoutFreeRoutes)
        return
      }
      deps.setView({ ...current, freeRoutes: { enabled: result.freeRoutes.enabled, eligibilityRevision: result.eligibilityRevision, changing: false } })
    } catch {
      const current = deps.view()
      if (current.kind !== "provider-settings" || current.option.id !== view.option.id) return
      try {
        const refreshed = await deps.query({ type: "provider_models.query", profileId, target: view.target.modelTarget })
        if (refreshed.freeRoutes === undefined) {
          const { freeRoutes: _removed, ...withoutFreeRoutes } = current
          deps.setView(withoutFreeRoutes)
        } else {
          deps.setView({ ...current, freeRoutes: { enabled: refreshed.freeRoutes.enabled, eligibilityRevision: refreshed.eligibilityRevision, changing: false, feedback: "Free-route preference could not be saved" } })
        }
      } catch {
        deps.setView({ ...current, freeRoutes: { ...previous, changing: false, feedback: "Free-route preference could not be saved" } })
      }
    }
  }

  return { openModels, toggleFreeRoutes }
}
