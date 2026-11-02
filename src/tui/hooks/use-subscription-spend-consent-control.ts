import { createSignal, type Accessor } from "solid-js"
import type { FrontendMutation, MutationResult } from "../../protocol/app-service-types.js"
import type { RuntimePosition } from "../../protocol/runtime-ui-protocol-types.js"
import { subscriptionSpendConsentEnvelopeIds, type SubscriptionSpendConsentMutation, type SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js"
import type { ModalHandle } from "../components/modal-stack.js"
import { SUBSCRIPTION_SPEND_CONSENT_COPY } from "../components/modal-copy.js"
import { CONSENT_ACTION_CURSOR, createSubscriptionSpendConsentInput } from "./use-subscription-spend-consent-modal.js"

type AvailableConsentView = Extract<SubscriptionSpendConsentView, { readonly kind: "available" }>
type ConsentMode = AvailableConsentView["accounts"][number]["modes"][number]

function modeAwaitsAnswer(mode: ConsentMode): boolean {
  return mode.decision === "unreviewed"
}

/** Cursor stops in travel order. Provider Settings puts its action first
 *  because the Models button sits above the rows; the question puts Continue
 *  last because it sits below them. */
function cursorPositions(modeList: readonly ConsentMode[], surface: ConsentSurface): number[] {
  const paidModes = modeList.map((_, index) => index)
  return surface === "settings" ? [CONSENT_ACTION_CURSOR, ...paidModes] : [...paidModes, CONSENT_ACTION_CURSOR]
}

function normalizeCursor(modeList: readonly ConsentMode[], surface: ConsentSurface, requested: number): number {
  const positions = cursorPositions(modeList, surface)
  return positions.includes(requested) ? requested : positions[0] ?? CONSENT_ACTION_CURSOR
}

/** Where the rows are shown. Only the question records an answer when it closes. */
type ConsentSurface = "settings" | "question"

interface ReviewContext {
  readonly consent: AvailableConsentView
  readonly canonicalConsent: AvailableConsentView
  readonly snapshotPosition: RuntimePosition
  readonly envelopeIds: readonly string[]
  readonly surface: ConsentSurface
}

export type SubscriptionSpendConsentControlState =
  | { readonly kind: "closed" }
  | ({ readonly kind: "detail"; readonly cursor: number; readonly savingEnvelopeIds: readonly string[]; readonly feedback?: string } & ReviewContext)

type DetailState = Extract<SubscriptionSpendConsentControlState, { kind: "detail" }>

interface SubscriptionSpendConsentControlDeps {
  dispatch: (mutation: Extract<FrontendMutation, SubscriptionSpendConsentMutation>) => Promise<MutationResult<SubscriptionSpendConsentMutation>>
  refresh: (profileId: string) => Promise<{ consent: SubscriptionSpendConsentView; snapshotPosition: RuntimePosition } | undefined>
  /** A question was answered and committed; the caller decides what follows. */
  onAnswered: (consent: SubscriptionSpendConsentView, snapshotPosition: RuntimePosition) => void
  /** The question closed without a recorded answer because the write failed. */
  onAnswerFailed: () => void
  /** A checkbox write failed after its view was dismissed. Report without reopening it. */
  onDismissedTickFailed: (feedback: string) => void
  openBrowser: (url: string) => Promise<boolean>
}

export interface SubscriptionSpendConsentControl {
  state: Accessor<SubscriptionSpendConsentControlState>
  /** Provider Settings rows for one account. Each toggle writes at once; closing writes nothing. */
  openProviderSettings: (consent: SubscriptionSpendConsentView, snapshotPosition: RuntimePosition, accountCorrelationId: string, owner: ModalHandle, focusEnvelopeId?: string) => void
  /** The paid-use question for one account: closing records "not allowed" for its unanswered modes. */
  openQuestion: (consent: SubscriptionSpendConsentView, snapshotPosition: RuntimePosition, accountCorrelationId: string, owner: ModalHandle) => void
  close: () => void
  toggle: (envelopeId: string) => Promise<void>
  /** Continue, Escape, the frame's close affordance, or q on the question. */
  decline: () => Promise<void>
  handleKey: (event: { name: string; sequence?: string; preventDefault?: () => void }) => boolean
}

export function useSubscriptionSpendConsentControl(deps: SubscriptionSpendConsentControlDeps): SubscriptionSpendConsentControl {
  const [state, setState] = createSignal<SubscriptionSpendConsentControlState>({ kind: "closed" })
  let owner: ModalHandle | undefined
  let closeRequested = false

  function open(consent: SubscriptionSpendConsentView, snapshotPosition: RuntimePosition, accountCorrelationId: string, nextOwner: ModalHandle, surface: ConsentSurface, focusEnvelopeId?: string): void {
    if (consent.kind !== "available" || !nextOwner.isOpen()) return
    const account = consent.accounts.find((candidate) => candidate.accountCorrelationId === accountCorrelationId)
    if (!account) return
    closeRequested = false
    // The question opens on the first mode it asks about; Provider Settings opens on its Models button.
    const requested = focusEnvelopeId !== undefined
      ? account.modes.findIndex((mode) => mode.envelopeId === focusEnvelopeId)
      : surface === "question" ? account.modes.findIndex(modeAwaitsAnswer) : CONSENT_ACTION_CURSOR
    setState({
      kind: "detail",
      cursor: normalizeCursor(account.modes, surface, requested),
      savingEnvelopeIds: [],
      consent: { ...consent, accounts: [account] },
      canonicalConsent: consent,
      snapshotPosition,
      envelopeIds: subscriptionSpendConsentEnvelopeIds(consent),
      surface,
    })
    owner = nextOwner
  }

  function close(): void {
    closeRequested = false
    owner = undefined
    setState({ kind: "closed" })
  }

  function modes(current: DetailState) {
    return current.consent.accounts.flatMap((account) => account.modes)
  }

  function moveCursor(offset: -1 | 1): void {
    const current = state()
    if (current.kind !== "detail" || current.savingEnvelopeIds.length > 0) return
    const positions = cursorPositions(modes(current), current.surface)
    const position = positions.indexOf(current.cursor)
    const next = Math.max(0, Math.min(positions.length - 1, position + offset))
    setState({ ...current, cursor: positions[next] ?? current.cursor })
  }

  async function toggle(envelopeId: string): Promise<void> {
    const current = state()
    if (current.kind !== "detail" || current.savingEnvelopeIds.length > 0) return
    const mode = modes(current).find((candidate) => candidate.envelopeId === envelopeId)
    if (!mode) return
    const checked = mode.decision === "accepted"
    const tickOwner = owner
    await commit(current, [envelopeId], checked ? [] : [envelopeId])
    if (closeRequested && owner === tickOwner && tickOwner?.isOpen()) {
      closeRequested = false
      await decline()
    }
  }

  function mutationBase(current: ReviewContext) {
    return { profileId: current.canonicalConsent.profileId, usageGeneration: current.canonicalConsent.usageGeneration, authorityIncarnation: current.canonicalConsent.authorityIncarnation, authorityRevision: current.canonicalConsent.authorityRevision, clientSnapshotPosition: current.snapshotPosition, envelopeIds: current.envelopeIds }
  }

  function mutationIsCurrent(pending: DetailState, pendingOwner: ModalHandle | undefined): boolean {
    return state() === pending && owner === pendingOwner && pendingOwner?.isOpen() === true
  }

  async function refreshStale(pending: DetailState, pendingOwner: ModalHandle | undefined): Promise<void> {
    const refreshed = await deps.refresh(pending.canonicalConsent.profileId)
    if (!mutationIsCurrent(pending, pendingOwner)) {
      deps.onDismissedTickFailed(SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.stale)
      return
    }
    if (!refreshed || refreshed.consent.kind !== "available") {
      setState({ ...pending, savingEnvelopeIds: [], feedback: SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.staleUnavailable })
      return
    }
    const accountId = pending.consent.accounts[0]?.accountCorrelationId
    const account = refreshed.consent.accounts.find((candidate) => candidate.accountCorrelationId === accountId)
    if (!account) {
      setState({ ...pending, savingEnvelopeIds: [], feedback: SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.staleUnavailable })
      return
    }
    setState({
      ...pending,
      consent: { ...refreshed.consent, accounts: [account] },
      canonicalConsent: refreshed.consent,
      snapshotPosition: refreshed.snapshotPosition,
      envelopeIds: subscriptionSpendConsentEnvelopeIds(refreshed.consent),
      cursor: normalizeCursor(account.modes, pending.surface, pending.cursor),
      savingEnvelopeIds: [],
      feedback: SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.stale,
    })
  }

  function feedbackFor(result: MutationResult<SubscriptionSpendConsentMutation>): string {
    return result.kind === "stale"
      ? SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.stale
      : result.kind === "contention"
        ? SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.contention
        : result.kind === "invalid-envelope"
          ? SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.invalidEnvelope
          : SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.storageFailure
  }

  /** Writes one decision set. `reviewed` names the envelopes this write decides;
   *  every reviewed envelope not in `accepted` becomes declined. */
  async function commit(current: DetailState, reviewed: readonly string[], accepted: readonly string[], closing = false): Promise<void> {
    const pending = { ...current, savingEnvelopeIds: reviewed, feedback: undefined }
    const pendingOwner = owner
    setState(pending)
    const failed = (feedback: string): void => {
      if (!mutationIsCurrent(pending, pendingOwner)) {
        if (!closing) deps.onDismissedTickFailed(feedback)
        return
      }
      if (closing) { close(); deps.onAnswerFailed() }
      else setState({ ...pending, savingEnvelopeIds: [], feedback })
    }
    try {
      const result = reviewed.length === 0
        ? { kind: "committed" as const, consent: current.canonicalConsent }
        : await deps.dispatch({ type: "subscription_spend_consent.save", ...mutationBase(current), reviewedEnvelopeIds: reviewed, acceptedEnvelopeIds: accepted })
      if (result.kind === "committed") {
        if (!mutationIsCurrent(pending, pendingOwner)) return
        if (closing) { close(); deps.onAnswered(result.consent, pending.snapshotPosition) }
        else settle(pending, result.consent)
        return
      }
      if (!closing && result.kind === "stale" && mutationIsCurrent(pending, pendingOwner)) { await refreshStale(pending, pendingOwner); return }
      failed(feedbackFor(result))
    } catch {
      failed(SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback.dispatchFailure)
    }
  }

  function settle(pending: DetailState, consent: SubscriptionSpendConsentView): void {
    const accountCorrelationId = pending.consent.accounts[0]?.accountCorrelationId
    const account = consent.kind === "available" ? consent.accounts.find((candidate) => candidate.accountCorrelationId === accountCorrelationId) : undefined
    if (consent.kind !== "available" || account === undefined) { close(); return }
    setState({
      ...pending,
      consent: { ...consent, accounts: [account] },
      canonicalConsent: consent,
      envelopeIds: subscriptionSpendConsentEnvelopeIds(consent),
      cursor: normalizeCursor(account.modes, pending.surface, pending.cursor),
      savingEnvelopeIds: [],
    })
  }

  /** Closing the question is an answer: the modes still waiting for one become
   *  declined, and earlier acceptances are left alone. A write that fails still
   *  closes, because an unanswered mode is already off and the question returns
   *  at the next boundary. */
  async function decline(): Promise<void> {
    const current = state()
    if (current.kind !== "detail" || current.surface !== "question") return
    if (current.savingEnvelopeIds.length > 0) { closeRequested = true; return }
    const reviewed = modes(current).filter(modeAwaitsAnswer).map((mode) => mode.envelopeId)
    await commit(current, reviewed, [], true)
  }

  const handleKey = createSubscriptionSpendConsentInput({ state, toggle, moveCursor, decline, openBrowser: deps.openBrowser })

  return {
    state,
    openProviderSettings: (consent, snapshotPosition, accountCorrelationId, nextOwner, focusEnvelopeId) => open(consent, snapshotPosition, accountCorrelationId, nextOwner, "settings", focusEnvelopeId),
    openQuestion: (consent, snapshotPosition, accountCorrelationId, nextOwner) => open(consent, snapshotPosition, accountCorrelationId, nextOwner, "question"),
    close,
    toggle,
    decline,
    handleKey,
  }
}
