import type { SubscriptionSpendConsentView } from "../../../protocol/subscription-spend-consent-protocol-types.js"

export type AvailableConsentView = Extract<SubscriptionSpendConsentView, { readonly kind: "available" }>

/** Where the rows are shown. Only the question records an answer when it closes. */
export type ConsentSurface = "settings" | "question"

/** The one stop outside the paid-mode rows: the Models button in Provider
 *  Settings, the Continue button on the paid-use question. */
export const CONSENT_ACTION_CURSOR = -1

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
