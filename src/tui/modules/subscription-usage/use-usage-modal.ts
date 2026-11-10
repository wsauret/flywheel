import { createEffect, createSignal, on, onCleanup, type Accessor, type JSX } from "solid-js"
import { errorMessage } from "../../../infra/error-message.js"
import { explainedByConnection } from "../../../protocol/client/connection-failures.js"
import type { RuntimeAuthStatusScope, RuntimeAuthView } from "../../../protocol/auth-status-protocol-types.js"
import { type UsageMetadataResult, type UsageAccountsQuery, type UsageAccountsResult, type UsageHistoryQuery, type UsageHistoryRange, type UsageHistoryResult, type UsageApplyResetMutation, type UsageApplyResetResult, type UsageMutationResult, type UsageOpenMutation, type UsageReadFailure, type UsageSpendQuery, type UsageSpendResult, USAGE_HISTORY_RANGES } from "../../../protocol/modules/subscription-usage.js"

import type { ListModalKeyEvent } from "../../components/modal-list-keys.js"
import type { ModalContext, ModalHandle } from "../../components/modal-stack.js"
import { createModalScrollController, type ModalScrollController } from "../../components/modal-scroll-controller.js"

const USAGE_FRESHNESS_MS = 5 * 60_000
const USAGE_SUBMIT_KEYS = new Set(["enter", "return"])

export type UsageModalView = "accounts" | "spend" | "history"
/** The settled result of the last reset attempt, shown under the banked reset of the account it acted on. */
export interface UsageResetOutcome { readonly sourceId: string; readonly message: string; readonly applied: boolean }
export type UsageResetAttempt =
  | { readonly kind: "idle"; readonly outcome?: UsageResetOutcome }
  | { readonly kind: "reviewing" | "busy"; readonly sourceId: string; readonly authorityIncarnation: string; readonly revision: number; readonly scope: RuntimeAuthStatusScope; readonly profileId: string; readonly selected: NonNullable<Extract<import("../../../protocol/modules/subscription-usage.js").UsageAccountSource, { kind: "subscription" }>["bankedResets"]>["credits"][number]; readonly logicalKey: string; readonly modalGeneration: number; readonly message?: string }


type UsageModalQuery =
  | { readonly type: "usage.metadata"; readonly scope: RuntimeAuthStatusScope }
  | ({ readonly type: "usage.accounts" } & UsageAccountsQuery)
  | ({ readonly type: "usage.spend" } & UsageSpendQuery)
  | ({ readonly type: "usage.history" } & UsageHistoryQuery)
type UsageModalMutation = ({ readonly type: "usage.open" } & UsageOpenMutation) | { readonly type: "usage.refresh"; readonly scope: RuntimeAuthStatusScope } | ({ readonly type: "usage.apply_reset" } & UsageApplyResetMutation)

interface UsageModalService {
  query: (query: UsageModalQuery) => Promise<UsageAccountsResult | UsageSpendResult | UsageHistoryResult | UsageMetadataResult>
  dispatch: (mutation: UsageModalMutation) => Promise<UsageMutationResult | UsageApplyResetResult>
}

interface UsageModalDeps {
  initialView?: UsageModalView
  modal: Pick<ModalContext, "replace">
  renderModal: () => JSX.Element
  appService: UsageModalService
  foregroundId: Accessor<string | undefined>
  effectiveProfileId: Accessor<string | undefined>
  auth?: Accessor<RuntimeAuthView | undefined>
}

export interface UsageModalHook {
  openUsageModal: () => void
  loadUsage: () => void
  closeUsageModal: () => void
  refreshUsage: () => void
  setUsageView: (view: UsageModalView) => void
  setSelectedSourceId: (sourceId: string) => void
  setSpendRange: (range: UsageHistoryRange) => void
  setHistoryRange: (range: UsageHistoryRange) => void
  usageView: Accessor<UsageModalView>
  usageAccounts: Accessor<UsageAccountsResult | undefined>
  usageSpend: Accessor<UsageSpendResult | undefined>
  usageHistory: Accessor<UsageHistoryResult | undefined>
  usageLoading: Accessor<boolean>
  usageFailure: Accessor<UsageReadFailure | undefined>
  selectedSourceId: Accessor<string | undefined>
  usageSpendRange: Accessor<UsageHistoryRange>
  usageHistoryRange: Accessor<UsageHistoryRange>
  usageShowDetailMetrics: Accessor<boolean>
  resetAttempt: Accessor<UsageResetAttempt>
  beginApplyReset: () => void
  confirmApplyReset: () => void
  cancelApplyReset: () => void
  currentScroll: ModalScrollController
  spendScroll: ModalScrollController
}

function usageScope(sessionId: string | undefined): RuntimeAuthStatusScope {
  return sessionId === undefined ? { kind: "defaults" } : { kind: "session", sessionId }
}
function sameScope(left: RuntimeAuthStatusScope, right: RuntimeAuthStatusScope): boolean {
  return left.kind === "defaults" && right.kind === "defaults" || left.kind === "session" && right.kind === "session" && left.sessionId === right.sessionId
}
function invalidUsageFields(value: unknown): string {
  return typeof value === "object" && value !== null ? Object.keys(value).toSorted().join(", ") : typeof value
}
/** A failed read the person started: the connection explains it (`explainedByConnection`) and shows its own notice when it
 *  lasts, so the view only notes the delay; any other cause is the view's own failure. */
function readFailure(cause: unknown): UsageReadFailure {
  return explainedByConnection(cause) ? { kind: "delayed" } : { kind: "failed", cause: errorMessage(cause) }
}
function isKind<K extends UsageAccountsResult["kind"] | UsageSpendResult["kind"] | UsageHistoryResult["kind"]>(value: unknown, kind: K): value is Extract<UsageAccountsResult | UsageSpendResult | UsageHistoryResult, { kind: K }> {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind
}

export function useUsageModal(deps: UsageModalDeps): UsageModalHook {
  const [view, setView] = createSignal<UsageModalView>("accounts")
  const [accounts, setAccounts] = createSignal<UsageAccountsResult>()
  const [spend, setSpend] = createSignal<UsageSpendResult>()
  const [history, setHistory] = createSignal<UsageHistoryResult>()
  const [loading, setLoading] = createSignal(false)
  const [failure, setFailure] = createSignal<UsageReadFailure>()
  const [selectedSourceId, setSelectedSourceIdSignal] = createSignal<string>()
  const [historyRange, setHistoryRangeSignal] = createSignal<UsageHistoryRange>("24h")
  const [spendRange, setSpendRangeSignal] = createSignal<UsageHistoryRange>("Month")
  const [showDetailMetrics, setShowDetailMetrics] = createSignal(false)
  const [resetAttempt, setResetAttempt] = createSignal<UsageResetAttempt>({ kind: "idle" })
  const currentScroll = createModalScrollController()
  const spendScroll = createModalScrollController()
  let entry: ModalHandle | undefined
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let refreshing = false
  let requestId = 0
  let modalGeneration = 0
  let activeScope = usageScope(deps.foregroundId())
  let activeProfileId = deps.effectiveProfileId()

  const sourceIds = (): readonly string[] => view() === "spend" ? spend()?.sources.map((source) => source.sourceId) ?? [] : view() === "history" ? history()?.sources.map((source) => source.sourceId) ?? [] : accounts()?.sources.map((source) => source.sourceId) ?? []
  const isCurrent = (scope: RuntimeAuthStatusScope, profileId: string | undefined): boolean => sameScope(activeScope, scope) && profileId === activeProfileId && profileId === deps.effectiveProfileId()
  const isLive = (id: number, scope: RuntimeAuthStatusScope, profileId: string | undefined): boolean => requestId === id && isCurrent(scope, profileId)
  const fail = (id: number, scope: RuntimeAuthStatusScope, profileId: string | undefined, next: UsageReadFailure): void => {
    if (!isLive(id, scope, profileId)) return
    setLoading(false); setFailure(next)
  }
  /** A background check never reports a failure of its own: a failed check only says the reading can be behind, and a
   *  failed refresh that the person started stays until they act again. */
  const settleCheck = (id: number, scope: RuntimeAuthStatusScope, profileId: string | undefined, delayed: boolean): void => {
    if (!isLive(id, scope, profileId) || failure()?.kind === "failed") return
    setFailure(delayed ? { kind: "delayed" } : undefined)
  }
  const reset = (): void => {
    currentScroll.reset(); spendScroll.reset()
    setAccounts(undefined); setSpend(undefined); setHistory(undefined)
    setSelectedSourceIdSignal(undefined); setShowDetailMetrics(false); setFailure(undefined); setResetAttempt({ kind: "idle" })
  }
  const selectAvailable = (ids: readonly string[], preferred = selectedSourceId()): void => {
    setSelectedSourceIdSignal(preferred && ids.includes(preferred) ? preferred : ids[0])
  }

  /** Shows the view's recorded result. A preview only displays it: the request that started it still owns `loading` and the
   *  failure. A background check settles as a check (`settleCheck`). */
  async function queryView(next: UsageModalView, id: number, scope: RuntimeAuthStatusScope, profileId: string | undefined, { preserveScroll = false, preview = false, background = false } = {}): Promise<void> {
    let failed: UsageReadFailure | undefined
    try {
      const result = next === "accounts"
        ? await deps.appService.query({ type: "usage.accounts", scope, freshnessMs: USAGE_FRESHNESS_MS })
        : next === "spend"
          ? await deps.appService.query({ type: "usage.spend", scope, range: spendRange() })
          : await deps.appService.query({ type: "usage.history", scope, range: historyRange() })
      if (!isLive(id, scope, profileId)) return
      if (result.profileId !== profileId) { if (!preview) setLoading(false); return }
      if (next === "accounts" && isKind(result, "usage.accounts")) { setAccounts(result); selectAvailable(result.sources.map((source) => source.sourceId)) }
      else if (next === "spend" && isKind(result, "usage.spend")) { setSpend(result); selectAvailable(result.sources.map((source) => source.sourceId)); if (!preserveScroll) spendScroll.reset() }
      else if (next === "history" && isKind(result, "usage.history")) { setHistory(result); selectAvailable(result.sources.map((source) => source.sourceId)) }
      else failed = readFailure(`Invalid usage ${next} response fields: ${invalidUsageFields(result)}`)
    } catch (cause) { failed = readFailure(cause) }
    if (preview) return
    if (background) settleCheck(id, scope, profileId, failed !== undefined)
    else if (failed === undefined) { setFailure(undefined); setLoading(false) } else fail(id, scope, profileId, failed)
  }
  function loadUsage(): void {
    const scope = usageScope(deps.foregroundId())
    const profileId = deps.effectiveProfileId()
    if (!sameScope(scope, activeScope) || profileId !== activeProfileId) reset()
    activeScope = scope; activeProfileId = profileId
    const id = ++requestId; const generation = modalGeneration
    setLoading(true); setFailure(undefined)
    // The provider check in usage.open can take seconds, so the recorded reading shows first.
    void queryView(view(), id, scope, profileId, { preview: true })
    void (async () => {
      let failed: UsageReadFailure | undefined
      try {
        const opened = await deps.appService.dispatch({ type: "usage.open", scope, freshnessMs: USAGE_FRESHNESS_MS })
        if (!("ok" in opened) || !opened.ok) failed = readFailure("error" in opened ? opened.error : "Invalid usage response")
      } catch (cause) { failed = readFailure(cause) }
      // A view switch replaces the request id while the check runs, so the open outlives it and shows the view selected now.
      if (modalGeneration !== generation || !isCurrent(scope, profileId)) return
      if (failed !== undefined) { setLoading(false); setFailure(failed); return }
      // A new request id retires the preview, so a late recorded reading never replaces the checked one.
      const checked = ++requestId
      setLoading(true)
      await queryView(view(), checked, scope, profileId, { preserveScroll: true })
    })()
  }
  function closeUsageModal(): void { if (resetAttempt().kind === "busy") return; entry?.close(); currentScroll.reset(); spendScroll.reset() }
  async function refreshRecordedUsage(): Promise<void> {
    if (entry?.isOpen() !== true || loading() || refreshing || resetAttempt().kind === "busy") return
    const id = ++requestId; const scope = activeScope; const profileId = activeProfileId
    refreshing = true
    try {
      const metadata = await deps.appService.query({ type: "usage.metadata", scope })
      if (!isLive(id, scope, profileId) || metadata.profileId !== profileId) return
      const displayed = view() === "accounts" ? accounts() : view() === "spend" ? spend() : history()
      if (displayed?.revision === metadata.revision && displayed.authorityIncarnation === metadata.authorityIncarnation && displayed.generation === metadata.generation) { settleCheck(id, scope, profileId, false); return }
      await queryView(view(), id, scope, profileId, { preserveScroll: true, background: true })
    } catch { settleCheck(id, scope, profileId, true) }
    finally { refreshing = false }
  }
  function refreshUsage(): void {
    if (entry?.isOpen() !== true || loading() || resetAttempt().kind === "busy") return
    const id = ++requestId; const scope = activeScope; const profileId = activeProfileId
    setLoading(true); setFailure(undefined)
    void (async () => {
      try {
        const refreshed = await deps.appService.dispatch({ type: "usage.refresh", scope })
        if (!isLive(id, scope, profileId)) return
        if (!("ok" in refreshed) || !refreshed.ok) { fail(id, scope, profileId, readFailure("error" in refreshed ? refreshed.error : "Invalid usage response")); return }
        await queryView(view(), id, scope, profileId)
      } catch (cause) { fail(id, scope, profileId, readFailure(cause)) }
    })()
  }
  function setUsageView(next: UsageModalView): void {
    if (next === view() || resetAttempt().kind === "busy") return
    setView(next); currentScroll.reset(); spendScroll.reset()
    const id = ++requestId; const scope = activeScope; const profileId = activeProfileId
    setLoading(true); setFailure(undefined); void queryView(next, id, scope, profileId)
  }
  function setSelectedSourceId(sourceId: string): void {
    if (!sourceIds().includes(sourceId) || sourceId === selectedSourceId() || resetAttempt().kind === "busy") return
    currentScroll.reset()
    setSelectedSourceIdSignal(sourceId)
  }
  function moveSelection(delta: -1 | 1): void {
    const ids = sourceIds(); const index = selectedSourceId() ? ids.indexOf(selectedSourceId() ?? "") : -1
    const next = Math.max(0, Math.min(ids.length - 1, index < 0 ? 0 : index + delta))
    if (ids[next]) setSelectedSourceId(ids[next])
  }
  function setSpendRange(range: UsageHistoryRange): void {
    setSpendRangeSignal(range)
    if (view() === "spend") { const id = ++requestId; setLoading(true); void queryView("spend", id, activeScope, activeProfileId) }
  }
  function setHistoryRange(range: UsageHistoryRange): void {
    setHistoryRangeSignal(range)
    if (view() === "history") { const id = ++requestId; setLoading(true); void queryView("history", id, activeScope, activeProfileId) }
  }
  function selectedResetReview() {
    const source = accounts()?.sources.find((candidate) => candidate.sourceId === selectedSourceId())
    if (source?.kind !== "subscription") return undefined
    const selected = source.bankedResets?.credits[0]
    if (selected === undefined) return undefined
    return { source, selected }
  }
  function beginApplyReset(): void {
    const review = selectedResetReview(); const reviewed = accounts(); const profileId = activeProfileId
    if (view() !== "accounts" || resetAttempt().kind !== "idle" || review === undefined || !reviewed || profileId === undefined) return
    setResetAttempt({ kind: "reviewing", sourceId: review.source.sourceId, authorityIncarnation: reviewed.authorityIncarnation, revision: reviewed.revision, scope: activeScope, profileId, selected: review.selected, logicalKey: crypto.randomUUID(), modalGeneration })
  }
  function cancelApplyReset(): void { if (resetAttempt().kind === "reviewing") setResetAttempt({ kind: "idle" }) }
  function confirmApplyReset(): void {
    const attempt = resetAttempt()
    if (attempt.kind !== "reviewing") return
    setResetAttempt({ ...attempt, kind: "busy", message: undefined })
    void (async () => {
      let result: UsageApplyResetResult | undefined
      let problem: string | undefined
      try {
        const raw = await deps.appService.dispatch({ type: "usage.apply_reset", scope: attempt.scope, sourceId: attempt.sourceId, authorityIncarnation: attempt.authorityIncarnation, revision: attempt.revision, redeemRequestId: attempt.logicalKey })
        if (!("kind" in raw) || !["reset", "nothingToReset", "noCredit", "alreadyRedeemed", "uncertain", "stale"].includes(raw.kind)) throw new Error("Invalid apply reset response")
        result = raw
      } catch (cause) { problem = errorMessage(cause) }
      const live = () => entry?.isOpen() === true && modalGeneration === attempt.modalGeneration && sameScope(activeScope, attempt.scope) && activeProfileId === attempt.profileId && deps.effectiveProfileId() === attempt.profileId
      try {
        const refreshed = await deps.appService.dispatch({ type: "usage.refresh", scope: attempt.scope })
        if (!("ok" in refreshed) || !refreshed.ok) throw new Error("error" in refreshed ? refreshed.error : "Invalid usage response")
        const updated = await deps.appService.query({ type: "usage.accounts", scope: attempt.scope, freshnessMs: USAGE_FRESHNESS_MS })
        if (!isKind(updated, "usage.accounts") || updated.profileId !== attempt.profileId) throw new Error("Invalid refreshed usage response")
        if (live()) { setAccounts(updated); selectAvailable(updated.sources.map((source) => source.sourceId), attempt.sourceId); setFailure(undefined) }
      } catch (cause) { problem ??= `Usage refresh failed: ${errorMessage(cause)}` }
      if (!live()) return
      if (problem !== undefined) { setResetAttempt({ ...attempt, kind: "reviewing", message: problem }); return }
      if (result?.kind === "uncertain") { setResetAttempt({ ...attempt, kind: "reviewing", message: "The reset result could not be confirmed. Retry uses the same request." }); return }
      const applied = result?.kind === "reset" || result?.kind === "alreadyRedeemed"
      const message = applied ? "Banked reset applied · usage refreshed" : result?.kind === "nothingToReset" ? "Nothing to reset · banked reset kept" : result?.kind === "noCredit" ? "That reset is no longer available" : "Usage changed underneath · review again"
      setResetAttempt({ kind: "idle", outcome: { sourceId: attempt.sourceId, message, applied } })
    })()
  }
  function moveRange(range: UsageHistoryRange, delta: -1 | 1): UsageHistoryRange {
    const index = USAGE_HISTORY_RANGES.indexOf(range)
    return USAGE_HISTORY_RANGES[(index + delta + USAGE_HISTORY_RANGES.length) % USAGE_HISTORY_RANGES.length] ?? "24h"
  }
  function handleAccountsKey(key: string): boolean {
    if (key === "c") { setShowDetailMetrics((visible) => !visible); currentScroll.reset(); return true }
    if (key === "pageup" || key === "pagedown") { currentScroll.pageBy(key === "pageup" ? -1 : 1); return true }
    if (key === "up" || key === "down" || key === "k" || key === "j") { moveSelection(key === "up" || key === "k" ? -1 : 1); return true }
    if (USAGE_SUBMIT_KEYS.has(key)) { beginApplyReset(); return true }
    return false
  }
  function handleSpendKey(key: string): boolean {
    if (key === "up" || key === "down" || key === "k" || key === "j") { moveSelection(key === "up" || key === "k" ? -1 : 1); return true }
    if (USAGE_SUBMIT_KEYS.has(key)) {
      if (spend()?.sources.find((source) => source.sourceId === selectedSourceId())?.active) setUsageView("accounts")
      return true
    }
    if (key === "left" || key === "right") { setSpendRange(moveRange(spendRange(), key === "left" ? -1 : 1)); return true }
    return false
  }
  function handleHistoryKey(key: string): boolean {
    if (key === "up" || key === "down" || key === "k" || key === "j") { moveSelection(key === "up" || key === "k" ? -1 : 1); return true }
    if (key === "left" || key === "right") { setHistoryRange(moveRange(historyRange(), key === "left" ? -1 : 1)); return true }
    return false
  }
  function handleKey(event: ListModalKeyEvent): void {
    const key = event.name.toLowerCase()
    if (key === "escape") { event.preventDefault?.(); if (resetAttempt().kind === "reviewing") cancelApplyReset(); else if (resetAttempt().kind !== "busy") closeUsageModal(); return }
    if (resetAttempt().kind === "busy") { event.preventDefault?.(); return }
    if (resetAttempt().kind === "reviewing") { event.preventDefault?.(); if (USAGE_SUBMIT_KEYS.has(key)) confirmApplyReset(); return }
    if (key === "a" || key === "s" || key === "h") { event.preventDefault?.(); setUsageView(key === "a" ? "accounts" : key === "s" ? "spend" : "history"); return }
    if (key === "tab") { event.preventDefault?.(); setUsageView(view() === "accounts" ? "spend" : view() === "spend" ? "history" : "accounts"); return }
    if (key === "r") { event.preventDefault?.(); refreshUsage(); return }
    const handled = view() === "accounts" ? handleAccountsKey(key) : view() === "spend" ? handleSpendKey(key) : handleHistoryKey(key)
    if (handled) event.preventDefault?.()
  }
  function openUsageModal(): void {
    entry?.close(); modalGeneration += 1; activeScope = usageScope(deps.foregroundId()); activeProfileId = deps.effectiveProfileId()
    setView(deps.initialView ?? "accounts"); setSpendRangeSignal("Month"); setHistoryRangeSignal("24h"); reset(); setLoading(true)
    const handle = deps.modal.replace(deps.renderModal, { onKey: handleKey, onClose: () => { if (entry === handle) { clearInterval(refreshTimer); refreshTimer = undefined; entry = undefined; modalGeneration += 1; requestId += 1; currentScroll.reset(); spendScroll.reset() } } })
    entry = handle; loadUsage()
    refreshTimer = setInterval(() => { void refreshRecordedUsage() }, 2_000)
  }
  createEffect(on([deps.foregroundId, deps.effectiveProfileId], ([sessionId, profileId]) => {
    const scope = usageScope(sessionId)
    if (sameScope(scope, activeScope) && profileId === activeProfileId) return
    activeScope = scope; activeProfileId = profileId; requestId += 1; reset(); setLoading(false)
    if (entry?.isOpen() === true) loadUsage()
  }))
  onCleanup(() => { entry?.close(); requestId += 1; currentScroll.detach(); spendScroll.detach() })
  return {
    openUsageModal, loadUsage, closeUsageModal, refreshUsage, setUsageView,
    setSelectedSourceId, setSpendRange, setHistoryRange, beginApplyReset, confirmApplyReset, cancelApplyReset,
    usageView: view, usageAccounts: accounts, usageSpend: spend, usageHistory: history,
    usageLoading: loading, usageFailure: failure, selectedSourceId,
    usageSpendRange: spendRange, usageHistoryRange: historyRange, usageShowDetailMetrics: showDetailMetrics,
    resetAttempt, currentScroll, spendScroll,
  }
}
