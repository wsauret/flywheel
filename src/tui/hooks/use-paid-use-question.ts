import { createEffect } from "solid-js"
import { paidModeAwaitsAnswer } from "../../protocol/subscription-spend-consent-protocol-types.js"
import type { ShellSignals } from "./shell-state.js"
import { automaticDialogsEnabled } from "./automatic-dialogs.js"

interface PaidUseQuestionDeps {
  readonly signals: Pick<ShellSignals, "auth" | "foregroundId" | "agentState">
  /** Whether a modal or overlay already owns the screen. */
  readonly overlayOpen: () => boolean
  /** Opens the review; answers whether it reached the screen. */
  readonly review: () => Promise<boolean>
}

/** The paid-use question (PI-MODEL-018) is asked once per waiting envelope at
 *  a safe moment: startup, or when provider evidence arrives later while
 *  nothing else is on screen. Closing it records an answer, so the same view
 *  never asks twice, and a failed write is not retried until the next start.
 *  An ask that never reached the screen, such as one that lost a startup
 *  scope race, is forgotten so the next safe moment asks again. */
export function usePaidUseQuestion(deps: PaidUseQuestionDeps): void {
  const asked = new Set<string>()
  createEffect(() => {
    if (!automaticDialogsEnabled()) return
    const auth = deps.signals.auth()
    if (deps.signals.foregroundId() === undefined || auth === undefined || deps.signals.agentState() === "active" || deps.overlayOpen()) return
    const consent = auth.subscriptionSpendConsent
    if (consent.kind !== "available") return
    const waiting = consent.accounts.flatMap((account) => account.modes.filter(paidModeAwaitsAnswer).map((mode) => mode.envelopeId)).filter((id) => !asked.has(id))
    if (waiting.length === 0) return
    for (const id of waiting) asked.add(id)
    void deps.review().then((shown) => { if (!shown) for (const id of waiting) asked.delete(id) })
  })
}
