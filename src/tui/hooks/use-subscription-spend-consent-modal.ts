import type { Accessor } from "solid-js"
import type { SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js"

export type AvailableConsentView = Extract<SubscriptionSpendConsentView, { readonly kind: "available" }>

/** Where the rows are shown. Only the question records an answer when it closes. */
export type ConsentSurface = "settings" | "question"

/** What the paid-use rows show and what their input reads. The write evidence
 *  that settles a decision stays private to the controller. */
export type SubscriptionSpendConsentControlState =
  | { readonly kind: "closed" }
  | {
    readonly kind: "detail"
    /** The one account the rows show. */
    readonly consent: AvailableConsentView
    readonly surface: ConsentSurface
    readonly cursor: number
    readonly savingEnvelopeIds: readonly string[]
    readonly feedback?: string
  }

/** The one stop outside the paid-mode rows: the Models button in Provider
 *  Settings, the Continue button on the paid-use question. */
export const CONSENT_ACTION_CURSOR = -1

interface SubscriptionSpendConsentInputDeps {
  readonly state: Accessor<SubscriptionSpendConsentControlState>
  readonly toggle: (envelopeId: string) => void
  readonly moveCursor: (offset: -1 | 1) => void
  readonly decline: () => Promise<void>
  readonly openBrowser: (url: string) => Promise<boolean>
}

/** Owns keyboard input for the paid-use rows in Provider Settings and on the
 *  paid-use question. Escape and q answer the question; Provider Settings
 *  leaves them to its own handler, which closes without writing. */
export function createSubscriptionSpendConsentInput(deps: SubscriptionSpendConsentInputDeps) {
  return function handleKey(event: { name: string; sequence?: string; preventDefault?: () => void }): boolean {
    const current = deps.state()
    if (current.kind === "closed") return false
    const key = event.name.toLowerCase()
    const question = current.surface === "question"
    const activate = key === "enter" || key === "return"
    if (question && (activate || key === "escape" || key === "q")) {
      event.preventDefault?.()
      void deps.decline()
      return true
    }
    if (current.savingEnvelopeIds.length > 0) {
      const rowKey = current.cursor !== CONSENT_ACTION_CURSOR && (key === "up" || key === "down" || activate || key === "space" || event.sequence === " ")
      if (question || rowKey) event.preventDefault?.()
      return question || rowKey
    }
    const modes = current.consent.accounts.flatMap((account) => account.modes)
    if (key === "up" || key === "down") {
      event.preventDefault?.()
      deps.moveCursor(key === "up" ? -1 : 1)
      return true
    }
    if ((activate || key === "space" || event.sequence === " ") && current.cursor !== CONSENT_ACTION_CURSOR) {
      event.preventDefault?.()
      const mode = modes[current.cursor]
      if (mode !== undefined) deps.toggle(mode.envelopeId)
      return true
    }
    if (key === "b") {
      const billingUrl = current.consent.accounts[0]?.billingUrl
      if (billingUrl !== undefined) {
        event.preventDefault?.()
        void deps.openBrowser(billingUrl)
      }
      return billingUrl !== undefined
    }
    return question
  }
}
