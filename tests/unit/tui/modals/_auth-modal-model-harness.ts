import { LOCAL_SIGN_IN } from "./auth-modal-test-harness.js"
import { mock } from "bun:test"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { useAuthModal } from "../../../../src/tui/hooks/use-auth-modal.js"
import type { AuthModalDeps } from "../../../../src/tui/hooks/auth-modal-types.js"
import type { ProviderModelRow } from "../../../../src/protocol/provider-model-preference-protocol-types.js"
import type { FrontendEvent, FrontendMutation, RuntimeQuery, RuntimeQueryResult } from "../../../../src/protocol/app-service-types.js"
import { openRouterAuthView, providerModelView } from "./_auth-modal-model-fixtures.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery, type DispatchAnswer } from "../../../helpers/runtime-dispatch.js"

type ProviderModelsQuery = Extract<RuntimeQuery, { readonly type: "provider_models.query" }>

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

export function createModal(authOverride?: AuthModalDeps["auth"]) {
  const modals = createModalStack()
  let nextProviderModelErrorMessage: string | undefined
  let nextAutoEnableErrorMessage: string | undefined
  let providerModelQueryRevision: number = providerModelView.eligibilityRevision
  let providerModelQueryRows: readonly ProviderModelRow[] = providerModelView.rows
  let providerModelCatalog: typeof providerModelView.catalog | { readonly kind: "unavailable"; readonly reason: "discovery-failed"; readonly discoveryReason: "http" } = providerModelView.catalog
  let refreshRestoresCatalog = true
  let providerModelRecheckAvailable = false
  const listeners = new Set<(event: FrontendEvent) => void>()
  let position = 0
  const catalogRequests = mock<DispatchAnswer<"auth.catalog.refresh">>(async () => ({ ok: true }))
  let nextProviderModelGate: Promise<void> | undefined
  let nextProviderModelQueryGate: Promise<void> | undefined
  let freeRoutesEnabled = false
  let nextFreeRouteResult: "missing" | "error" | undefined
  // `dispatch` records every request but a catalog refresh, which
  // `catalogRequests` answers and records.
  const dispatch = mock((_request: FrontendMutation) => {})
  const answers = runtimeDispatch({
    "auth.catalog.refresh": catalogRequests,
    "auth.refresh": async () => {
      if (refreshRestoresCatalog) providerModelCatalog = providerModelView.catalog
      return { ok: true }
    },
    "auth.account.disconnect": async () => ({ ok: true }),
    // A paid-use answer is not under test here: the save fails, as a store that refuses it does.
    "subscription_spend_consent.save": async () => ({ kind: "storage-failure" }),
    "provider_free_routes.set": async (request) => {
      const result = nextFreeRouteResult
      nextFreeRouteResult = undefined
      if (result === "error") throw new Error("stale internal preference detail")
      if (result === "missing") return { ...providerModelView, eligibilityRevision: 8, target: request.target }
      freeRoutesEnabled = request.enabled
      return { ...providerModelView, eligibilityRevision: 8, target: request.target, freeRoutes: { enabled: freeRoutesEnabled } }
    },
    "provider_models.recheck": async (request) => ({ ...providerModelView, eligibilityRevision: 8, target: request.target, rows: providerModelQueryRows, recheckAvailable: true }),
    "provider_models.deselect_all": async (request) => ({ ...providerModelView, eligibilityRevision: 8, target: request.target, rows: providerModelQueryRows.map((row) => ({ ...row, checked: false })) }),
    "provider_models.set_auto_enable": async (request) => {
      if (nextAutoEnableErrorMessage !== undefined) {
        const message = nextAutoEnableErrorMessage
        nextAutoEnableErrorMessage = undefined
        throw new Error(message)
      }
      return { profileId: request.queriedProfileId, eligibilityRevision: request.queriedEligibilityRevision + 1, autoEnableNewModels: request.enabled }
    },
    "provider_model.set": async (request) => {
      if (nextProviderModelErrorMessage !== undefined) {
        const message = nextProviderModelErrorMessage
        nextProviderModelErrorMessage = undefined
        throw new Error(message)
      }
      const gate = nextProviderModelGate
      nextProviderModelGate = undefined
      if (gate !== undefined) await gate
      const row = providerModelQueryRows.find(({ modelId }) => modelId === request.modelId)
      if (row === undefined) throw new Error("missing provider model row")
      return { profileId: "default", eligibilityRevision: 8, target: request.target, row: { ...row, checked: request.checked } }
    },
  })
  const query = mock(async (request: ProviderModelsQuery): Promise<RuntimeQueryResult<ProviderModelsQuery>> => {
    const gate = nextProviderModelQueryGate
    nextProviderModelQueryGate = undefined
    if (gate !== undefined) await gate
    return {
      ...providerModelView,
      eligibilityRevision: providerModelQueryRevision,
      rows: providerModelQueryRows,
      catalog: providerModelCatalog,
      recheckAvailable: providerModelRecheckAvailable,
      target: request.target,
      ...(request.target.providerId === "openrouter" ? { freeRoutes: { enabled: freeRoutesEnabled } } : {}),
    }
  })
  const queryRuntime = runtimeQuery({
    authStatusSnapshot: async () => ({ snapshotPosition: position, auth: openRouterAuthView }),
    "provider_models.query": query,
  })
  const dispatchRuntime = recordedDispatch((request) => { if (request.type !== "auth.catalog.refresh") dispatch(request) }, answers)
  const modal = useAuthModal({
    auth: authOverride ?? (() => ({
      autoEnableNewModels: { enabled: true, eligibilityRevision: 7 },
      providers: [{ providerId: "anthropic_api", kind: "singleton", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic API Key", accounts: [] }],
      warnings: [],
      profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
      subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
    })),
    modal: modals,
    renderModal: () => "mock-auth-modal",
    showToast: mock(() => {}),
    appService: {
      dispatch: dispatchRuntime,
      query: queryRuntime,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      onLane: fakeLanes().onLane,
    },
    openBrowser: async () => true,
    signInPage: LOCAL_SIGN_IN,
    clipboard: { copy: async () => {}, readImage: async () => null },
  } satisfies AuthModalDeps)
  return {
    modal,
    modals,
    dispatch,
    query,
    catalogRequests,
    publishCatalog: async () => {
      const auth = { ...openRouterAuthView, autoEnableNewModels: { enabled: true, eligibilityRevision: providerModelQueryRevision } }
      const previous = position++
      for (const listener of listeners) listener({ type: "patch", patch: { cursor: { scope: "workspace", domain: "auth" }, prevPosition: previous, position, payload: { kind: "auth.changed", auth } } })
      await settle()
    },
    failNextProviderModelMutation: (message: string) => { nextProviderModelErrorMessage = message },
    failNextAutoEnableMutation: (message: string) => { nextAutoEnableErrorMessage = message },
    setNextFreeRouteResult: (result: "missing" | "error") => { nextFreeRouteResult = result },
    setProviderModelQueryRevision: (revision: number) => { providerModelQueryRevision = revision },
    setProviderModelQueryRows: (rows: readonly ProviderModelRow[]) => { providerModelQueryRows = rows },
    setProviderModelRecheckAvailable: (available: boolean) => { providerModelRecheckAvailable = available },
    failProviderCatalog: () => { providerModelCatalog = { kind: "unavailable", reason: "discovery-failed", discoveryReason: "http" }; providerModelQueryRows = [] },
    keepCatalogUnavailable: () => { refreshRestoresCatalog = false },
    holdNextProviderModelMutation: () => {
      const gate = Promise.withResolvers<void>()
      nextProviderModelGate = gate.promise
      return gate.resolve
    },
    holdNextProviderModelQuery: () => {
      const gate = Promise.withResolvers<void>()
      nextProviderModelQueryGate = gate.promise
      return gate.resolve
    },
  }
}
