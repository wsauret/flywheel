import { errorMessage } from "../../infra/error-message.js"
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { providerCatalogNeedsRetry, type ProviderModelRow, type ProviderModelTarget, type ProviderModelView } from "../../protocol/provider-model-preference-protocol-types.js"
import type { RuntimeAuthStatusScope } from "../../protocol/auth-status-protocol-types.js"
import { observeModelCatalog } from "./observe-model-catalog.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import { createControlledTextEditor, SINGLE_LINE_TEXT_ENTRY_POLICY } from "../keymap/text-entry.js"
import { filterProviderModelRows, type AuthView } from "./auth-modal-options.js"
import { providerCatalogStatusText } from "../modals/provider-catalog-text.js"

interface AuthModalModelActionDeps {
  appService: Pick<AttachedRuntimeClient, "dispatch" | "query" | "subscribe" | "onLane">
  scope: () => RuntimeAuthStatusScope
  profileId: () => string | undefined
  view: () => AuthView
  setView: (view: Extract<AuthView, { kind: "provider-models" }>) => void
  restoreList: () => void
  nextRequest: () => number
  currentRequest: () => number
  profilePending: () => boolean
  closeAuthModal: () => void
}

interface ProviderModelToggleIntent extends ProviderModelAccountIntent {
  readonly modelId: string
  readonly checked: boolean
  readonly previous?: ProviderModelToggleIntent
  appliedChecked?: boolean
}

interface ProviderModelAccountIntent {
  readonly profileId: string
  readonly target: ProviderModelTarget
  readonly lifetime: number
}

export function createAuthModalModelActions(deps: AuthModalModelActionDeps) {
  let pendingMutation: Promise<void> | undefined
  let activeRead: Promise<void> | undefined
  const pendingToggles = new Set<ProviderModelToggleIntent>()
  let lifetime = 0
  let stopCatalog: (() => void) | undefined
  let backgroundRead = 0
  const [catalogRevision, setCatalogRevision] = createSignal(0)
  let loadedRevision = 0
  function stopObserving(): void {
    lifetime++
    stopCatalog?.()
    stopCatalog = undefined
    deps.nextRequest()
  }
  onCleanup(stopObserving)
  createEffect(() => {
    const revision = catalogRevision()
    const view = deps.view()
    const loading = view.kind === "provider-models" && view.loading
    untrack(() => {
      if (view.kind !== "provider-models") { stopObserving(); return }
      if (loading || revision === loadedRevision) return
      loadedRevision = revision
      void refreshProviderModels()
    })
  })
  const searchEditor = createControlledTextEditor({
    value: () => {
      const view = deps.view()
      return view.kind === "provider-models" ? view.query : ""
    },
    setValue: (query) => {
      const view = deps.view()
      if (view.kind !== "provider-models") return
      const highlighted = filterProviderModelRows(view.rows, view.query)[view.cursor]
      const rows = filterProviderModelRows(view.rows, query)
      const kept = highlighted === undefined ? -1 : rows.findIndex((row) => row.modelId === highlighted.modelId)
      deps.setView({ ...view, query, cursor: kept >= 0 ? kept : Math.max(0, rows.findIndex((row) => row.optInAvailable)) })
    },
    policy: SINGLE_LINE_TEXT_ENTRY_POLICY,
  })
  const visibleRows = (): readonly ProviderModelRow[] => {
    const view = deps.view()
    return view.kind === "provider-models" ? filterProviderModelRows(view.rows, view.query) : []
  }
  async function loadProviderModels(target: ProviderModelTarget, providerTitle: string, originCursor: number, focus?: { readonly modelId: string; readonly fallbackCursor: number; readonly query: string; readonly notice?: string }): Promise<void> {
    if (focus === undefined) lifetime++
    const request = deps.nextRequest()
    const profileId = deps.profileId()
    if (profileId === undefined) return
    const query = focus?.query ?? ""
    const previous = deps.view()
    if (focus === undefined || previous.kind !== "provider-models") {
      searchEditor.resetEphemeralState({ cursor: query.length })
      deps.setView({ kind: "provider-models", profileId, target, providerTitle, rows: [], query, loading: true, cursor: focus?.fallbackCursor ?? 0, originCursor })
    }
    try {
      if (focus === undefined) {
        stopCatalog?.()
        const observer = observeModelCatalog(deps.appService, deps.scope(), (auth) => {
          if (auth.profile.id === profileId) setCatalogRevision((revision) => revision + 1)
        })
        stopCatalog = observer.dispose
        void deps.appService.dispatch({ type: "auth.catalog.refresh", scope: { kind: "profile", profileId } }).catch(() => {})
        await observer.ready
        if (request !== deps.currentRequest()) return
      }
      loadedRevision = catalogRevision()
      const result = await deps.appService.query({ type: "provider_models.query", profileId, target })
      const current = deps.view()
      if (request !== deps.currentRequest() || current.kind !== "provider-models" || !sameTarget(current.target, target)) return
      if (deps.profileId() !== profileId) {
        deps.restoreList()
        return
      }
      const activeQuery = current.query
      const rows = filterProviderModelRows(result.rows, activeQuery)
      const focusedCursor = focus === undefined ? 0 : rows.findIndex((row) => row.modelId === focus.modelId)
      const cursor = focusedCursor >= 0 ? focusedCursor : Math.min(focus?.fallbackCursor ?? 0, Math.max(0, rows.length - 1))
      const accessRefused = result.catalog.kind === "unavailable" && result.catalog.reason === "unusable" && (result.audit?.refused ?? 0) > 0
      deps.setView({ kind: "provider-models", profileId: result.profileId, eligibilityRevision: result.eligibilityRevision, target: result.target, providerTitle: result.providerDisplayName, catalog: result.catalog, rows: result.rows, preferenceAvailable: result.preferenceAvailable, recheckAvailable: result.recheckAvailable, audit: result.audit, notice: focus?.notice, query: activeQuery, loading: false, cursor, originCursor, error: result.rows.length === 0 && !accessRefused && providerCatalogNeedsRetry(result.catalog) ? providerCatalogStatusText(result.catalog) : undefined })
    } catch (err) {
      const current = deps.view()
      if (request !== deps.currentRequest() || current.kind !== "provider-models" || !sameTarget(current.target, target)) return
      if (deps.profileId() !== profileId) {
        deps.restoreList()
        return
      }
      deps.setView({ ...current, loading: false, error: errorMessage(err) })
    }
  }

  async function refreshProviderModels(): Promise<void> {
    await pendingMutation
    // Only the boundary read is a mutation dependency, never this queue wait.
    const operation = readProviderModels()
    activeRead = operation
    await operation
    if (activeRead === operation) activeRead = undefined
  }

  async function readProviderModels(): Promise<void> {
    const view = deps.view()
    if (view.kind !== "provider-models" || view.profileId === undefined) return
    const request = deps.currentRequest()
    const read = ++backgroundRead
    try {
      const result = await deps.appService.query({ type: "provider_models.query", profileId: view.profileId, target: view.target })
      const current = deps.view()
      if (request !== deps.currentRequest() || read !== backgroundRead || current.kind !== "provider-models" || current.profileId !== view.profileId || !sameTarget(current.target, view.target)) return
      deps.setView(adoptServerView(current, result))
    } catch {
      // Saved rows and the editor remain usable when a background read fails.
    }
  }

  async function applyProviderModelToggle(intent: ProviderModelToggleIntent): Promise<void> {
    if (deps.profilePending() || deps.profileId() !== intent.profileId || intent.lifetime !== lifetime) return
    const view = deps.view()
    if (view.kind !== "provider-models" || view.loading || view.profileId !== intent.profileId || view.eligibilityRevision === undefined || !sameTarget(view.target, intent.target)) return
    const row = view.rows.find((candidate) => candidate.modelId === intent.modelId)
    if (!row?.optInAvailable) return
    deps.nextRequest()
    const visibleIndex = filterProviderModelRows(view.rows, view.query).findIndex((candidate) => candidate.modelId === intent.modelId)
    deps.setView({ ...view, notice: undefined, cursor: visibleIndex >= 0 ? visibleIndex : view.cursor })
    try {
      // A successful earlier keypress changes toggle parity; a catalog publication does not.
      const checked = intent.previous?.appliedChecked === undefined ? intent.checked : !intent.previous.appliedChecked
      const result = await deps.appService.dispatch({ type: "provider_model.set", queriedProfileId: view.profileId, queriedEligibilityRevision: view.eligibilityRevision, target: view.target, modelId: row.modelId, checked })
      const current = deps.view()
      if (current.kind !== "provider-models" || !sameTarget(current.target, view.target) || current.profileId !== view.profileId || current.eligibilityRevision !== view.eligibilityRevision) return
      if ("hidden" in result) { deps.restoreList(); return }
      intent.appliedChecked = result.row.checked
      const rowIndex = current.rows.findIndex((candidate) => candidate.modelId === result.row.modelId)
      if (rowIndex < 0) return
      deps.setView({ ...current, profileId: result.profileId, eligibilityRevision: result.eligibilityRevision, target: result.target, rows: current.rows.map((candidate, candidateIndex) => candidateIndex === rowIndex ? result.row : candidate) })
    } catch (err) {
      const current = deps.view()
      if (current.kind !== "provider-models" || !sameTarget(current.target, view.target) || current.profileId !== view.profileId || current.eligibilityRevision !== view.eligibilityRevision) return
      const message = errorMessage(err)
      if (message.includes("stale provider-model preference mutation") || message.includes("auth profile inputs changed during provider-model preference mutation")) await loadProviderModels(view.target, view.providerTitle, view.originCursor, { modelId: row.modelId, fallbackCursor: view.cursor, query: view.query, notice: STALE_PREFERENCE_NOTICE })
      else deps.setView({ ...current, error: message })
    }
  }

  function toggleProviderModel(index: number): Promise<void> {
    const view = deps.view()
    if (view.kind !== "provider-models" || view.profileId === undefined) return Promise.resolve()
    const row = filterProviderModelRows(view.rows, view.query)[index]
    if (!row?.optInAvailable) return Promise.resolve()
    const previous = [...pendingToggles].findLast((intent) => intent.lifetime === lifetime && intent.profileId === view.profileId && sameTarget(intent.target, view.target) && intent.modelId === row.modelId)
    const intent: ProviderModelToggleIntent = { profileId: view.profileId, target: view.target, modelId: row.modelId, checked: !row.checked, lifetime, previous }
    pendingToggles.add(intent)
    // eslint-disable-next-line solid/reactivity -- the queued command reads the latest view once, not as a reactive subscription
    return enqueueMutation(() => applyProviderModelToggle(intent)).finally(() => { pendingToggles.delete(intent) })
  }

  function enqueueMutation(run: () => Promise<void>): Promise<void> {
    const apply = async () => {
      for (let read = activeRead; read !== undefined; read = activeRead) await read
      await run()
    }
    const operation = pendingMutation === undefined ? apply() : pendingMutation.then(apply)
    const settled = operation.then(() => {}, () => {})
    pendingMutation = settled
    void settled.then(() => { if (pendingMutation === settled) pendingMutation = undefined })
    return operation
  }

  async function deselectAllProviderModels(intent: ProviderModelAccountIntent): Promise<void> {
    if (deps.profilePending() || deps.profileId() !== intent.profileId || intent.lifetime !== lifetime) return
    const view = deps.view()
    if (view.kind !== "provider-models" || view.loading || view.profileId !== intent.profileId || view.eligibilityRevision === undefined || !sameTarget(view.target, intent.target) || !providerModelsCanDeselect(view)) return
    deps.nextRequest()
    try {
      const result = await deps.appService.dispatch({ type: "provider_models.deselect_all", queriedProfileId: view.profileId, queriedEligibilityRevision: view.eligibilityRevision, target: view.target })
      const current = deps.view()
      if (current.kind !== "provider-models" || current.profileId !== view.profileId || current.eligibilityRevision !== view.eligibilityRevision || !sameTarget(current.target, view.target)) return
      if ("hidden" in result) { deps.restoreList(); return }
      const rows = filterProviderModelRows(result.rows, current.query)
      deps.setView({ ...current, profileId: result.profileId, eligibilityRevision: result.eligibilityRevision, target: result.target, providerTitle: result.providerDisplayName, rows: result.rows, recheckAvailable: result.recheckAvailable, cursor: Math.min(current.cursor, Math.max(0, rows.length - 1)) })
    } catch (err) {
      const current = deps.view()
      if (current.kind !== "provider-models" || current.profileId !== view.profileId || current.eligibilityRevision !== view.eligibilityRevision || !sameTarget(current.target, view.target)) return
      const message = errorMessage(err)
      if (message.includes("stale provider-model preference mutation") || message.includes("auth profile inputs changed during provider-model preference mutation")) {
        const focused = visibleRows()[current.cursor]
        await loadProviderModels(view.target, view.providerTitle, view.originCursor, { modelId: focused?.modelId ?? "", fallbackCursor: current.cursor, query: current.query, notice: STALE_PREFERENCE_NOTICE })
      } else deps.setView({ ...current, error: message })
    }
  }

  /** Probes every candidate of the exact account again, even when all are refused. The server owns which rows survive. */
  async function recheckProviderModels(intent: ProviderModelAccountIntent): Promise<void> {
    if (deps.profilePending() || deps.profileId() !== intent.profileId || intent.lifetime !== lifetime) return
    const view = deps.view()
    if (view.kind !== "provider-models" || view.loading || view.recheckAvailable !== true || view.profileId !== intent.profileId || view.eligibilityRevision === undefined || !sameTarget(view.target, intent.target)) return
    deps.nextRequest()
    deps.setView({ ...view, rechecking: true, notice: undefined, error: undefined })
    try {
      const result = await deps.appService.dispatch({ type: "provider_models.recheck", queriedProfileId: view.profileId, queriedEligibilityRevision: view.eligibilityRevision, target: view.target })
      const current = deps.view()
      if (current.kind !== "provider-models" || current.profileId !== view.profileId || !sameTarget(current.target, view.target)) return
      if ("hidden" in result) { deps.restoreList(); return }
      deps.setView({ ...adoptServerView(current, result), rechecking: false })
    } catch (err) {
      const current = deps.view()
      if (current.kind !== "provider-models" || current.profileId !== view.profileId || !sameTarget(current.target, view.target)) return
      const message = errorMessage(err)
      if (message.includes("stale provider-model preference mutation") || message.includes("auth profile inputs changed during provider-model preference mutation")) {
        const focused = visibleRows()[current.cursor]
        await loadProviderModels(view.target, view.providerTitle, view.originCursor, { modelId: focused?.modelId ?? "", fallbackCursor: current.cursor, query: current.query, notice: STALE_PREFERENCE_NOTICE })
      } else deps.setView({ ...current, rechecking: false, error: message })
    }
  }

  function requestRecheck(): void {
    const view = deps.view()
    if (view.kind !== "provider-models" || view.profileId === undefined || view.recheckAvailable !== true || view.rechecking === true) return
    const intent: ProviderModelAccountIntent = { profileId: view.profileId, target: view.target, lifetime }
    // eslint-disable-next-line solid/reactivity -- the queued command reads the latest view once, not as a reactive subscription
    void enqueueMutation(() => recheckProviderModels(intent))
  }

  const handleKey = createListModalKeys<ProviderModelRow>({
    rows: visibleRows,
    cursor: () => {
      const view = deps.view()
      return view.kind === "provider-models" ? view.cursor : 0
    },
    setCursor: (index) => { const view = deps.view(); if (view.kind === "provider-models") deps.setView({ ...view, cursor: index }) },
    onSelect: (index) => { void toggleProviderModel(index) },
    onClose: deps.closeAuthModal,
    selectable: () => true,
    extra: (event) => {
      if (event.ctrl && event.name.toLowerCase() === "d" && providerModelsCanDeselect(deps.view())) {
        event.preventDefault?.()
        const view = deps.view()
        if (view.kind === "provider-models" && view.profileId !== undefined) {
          const intent: ProviderModelAccountIntent = { profileId: view.profileId, target: view.target, lifetime }
          // eslint-disable-next-line solid/reactivity -- the queued command reads the latest view once, not as a reactive subscription
          void enqueueMutation(() => deselectAllProviderModels(intent))
        }
        return true
      }
      if (event.ctrl && event.name.toLowerCase() === "r") {
        event.preventDefault?.()
        requestRecheck()
        return true
      }
      if (event.name !== "space" && event.sequence !== " ") return false
      event.preventDefault?.()
      const view = deps.view()
      if (view.kind === "provider-models") void toggleProviderModel(view.cursor)
      return true
    },
    textInput: (event) => { searchEditor.handleKey(event) },
  })

  return {
    stopObserving,
    loadProviderModels,
    toggleProviderModel,
    selectProviderModel: (index: number) => { void toggleProviderModel(index) },
    recheckProviderModels: requestRecheck,
    handleKey,
    handlePaste: (text: string) => searchEditor.handlePaste(text),
    presentation: () => searchEditor.presentation(),
  }
}

const STALE_PREFERENCE_NOTICE = "Model access changed. The list was refreshed; review it and try again."

/** Adopts a server view while keeping the selected model under the cursor. When that row is gone the cursor stays at the same position, which is the next surviving row. */
function adoptServerView(current: Extract<AuthView, { kind: "provider-models" }>, result: ProviderModelView): Extract<AuthView, { kind: "provider-models" }> {
  const selected = filterProviderModelRows(current.rows, current.query)[current.cursor]?.modelId
  const rows = filterProviderModelRows(result.rows, current.query)
  const kept = rows.findIndex((row) => row.modelId === selected)
  return { ...current, profileId: result.profileId, target: result.target, providerTitle: result.providerDisplayName, rows: result.rows, eligibilityRevision: result.eligibilityRevision, catalog: result.catalog, preferenceAvailable: result.preferenceAvailable, recheckAvailable: result.recheckAvailable, audit: result.audit, error: undefined, cursor: kept < 0 ? Math.min(current.cursor, Math.max(0, rows.length - 1)) : kept }
}

function providerModelsCanDeselect(view: AuthView): boolean {
  return view.kind === "provider-models"
    && view.catalog?.kind === "available"
    && view.catalog.liveOutcome !== "authentication-invalid"
    && view.rows.length > 0
}

function sameTarget(left: ProviderModelTarget, right: ProviderModelTarget): boolean {
  return left.kind === right.kind && left.providerId === right.providerId && (left.kind === "singleton" || (right.kind === "subscription" && left.accountCorrelationId === right.accountCorrelationId))
}
