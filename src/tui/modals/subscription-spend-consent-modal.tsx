import type { AuthView } from "../hooks/auth-modal-options.js"
import type { SubscriptionSpendConsentControlState } from "../hooks/use-subscription-spend-consent-control.js"
import { AUTH_CONTROL_COPY, SUBSCRIPTION_SPEND_CONSENT_COPY } from "../components/modal-copy.js"
import { paidModeAwaitsAnswer } from "../../protocol/subscription-spend-consent-protocol-types.js"

type Capability = NonNullable<Extract<Extract<AuthView, { kind: "provider-settings" }>["target"], { kind: "account" }>["capability"]>
type CapabilityMode = Capability["modes"][number]
type Detail = Extract<SubscriptionSpendConsentControlState, { kind: "detail" }>

export function subscriptionSpendConsentDetail(control: SubscriptionSpendConsentControlState | undefined, capability: Capability): Detail | undefined {
  return control?.kind === "detail" && control.consent.accounts[0]?.accountCorrelationId === capability.accountCorrelationId ? control : undefined
}

export function subscriptionSpendFooterRows(detail: Pick<Detail, "cursor"> | undefined, billingAvailable: boolean): readonly string[] {
  const actions = AUTH_CONTROL_COPY.providerSettingsActions
  if (detail !== undefined && detail.cursor >= 0) {
    return [`↑↓ choose · space/enter toggle${billingAvailable ? " · b billing" : ""}`, actions]
  }
  return [[billingAvailable ? "b billing" : undefined, actions].filter((value): value is string => value !== undefined).join(" · ")]
}

export function paidUseQuestionFooterRows(billingAvailable: boolean): readonly string[] {
  return [SUBSCRIPTION_SPEND_CONSENT_COPY.questionControls, `${SUBSCRIPTION_SPEND_CONSENT_COPY.questionClose}${billingAvailable ? " · b billing" : ""}`]
}

function paidModeNoun(mode: CapabilityMode): string {
  return mode.mode === "prepaid" ? "prepaid credits" : "automatic billing"
}

/** The sentences above the paid-mode rows: what was connected, what the
 *  provider reports, and what closing the question means. */
export function paidUseQuestionLines(providerLabel: string, identity: string, capability: Capability): readonly string[] {
  const asked = capability.modes.filter(paidModeAwaitsAnswer)
  const nouns = asked.map(paidModeNoun)
  const capacity = nouns.length === 0 ? "paid use" : nouns.join(" and ")
  return [
    `${providerLabel} is connected as ${identity}.`,
    `${capability.providerDisplayName} reports that this account can also pay for use beyond its plan: ${capacity}.`,
    SUBSCRIPTION_SPEND_CONSENT_COPY.questionRule,
  ]
}

export function subscriptionSpendWarnsPrepaid(detail: Detail | undefined, capability: Capability): boolean {
  return detail !== undefined && capability.modes.some((mode) => mode.mode === "prepaid")
}

