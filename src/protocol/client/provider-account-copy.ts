import type { AuthProviderAccountStatus, AuthProviderStatus, RuntimeAuthLoginQuestion } from "../auth-status-protocol-types.js"
import type { SubscriptionUsageSpendSource } from "../../infra/llm/subscription-usage.js"

/** What every client says about one provider login and one account, so the terminal, the web client, and the
 *  phone name a problem and its repair in the same words. */

export const PAID_USE_SETTINGS_LOAD_FAILURE = "Flywheel could not load paid-use settings. Your saved choices are unchanged."

/** Provider readings describe capacity, not the person's saved paid-use choice. Only exact values are displayed. */
export function paidUseEvidence(evidence: SubscriptionUsageSpendSource) {
  const status = evidence.kind === "automatic-billing"
    ? { enabled: "Provider billing: on", disabled: "Provider billing: off", unknown: "No reading yet" }[evidence.enablement]
    : {
      funded: "Funded",
      available: "Balance: not reported",
      unlimited: "Balance: unlimited",
      empty: "Balance: empty",
      "balance-unavailable": "Balance: not reported",
      unknown: "No reading yet",
    }[evidence.availability]
  if (evidence.kind === "prepaid" && evidence.availability !== "funded") return { status, details: [] }
  const values = [["Used", evidence.used], ["Limit", evidence.limit], ["Remaining", evidence.remaining]] as const
  const details = values.flatMap(([label, value]) => value?.precision === "exact" ? [`${label} ${formatEvidenceValue(value)}`] : [])
  return { status, details }
}

function formatEvidenceValue(value: NonNullable<Extract<SubscriptionUsageSpendSource, { readonly kind: "automatic-billing" }>["used"]>): string {
  if (value.kind === "money") return `${value.value} ${value.currency}`
  if (value.kind === "count") return `${value.value} ${value.unit}`
  return `${value.value * 100}%`
}

/** A browser login: the person signs in on the provider's page. A provider whose page shows a code, such as
 *  Claude, takes that code; a provider that sends the browser to a local address that the browser cannot reach
 *  takes that full address. Every client shows one field for either. The lead never says that the page is already
 *  open: a client opens it only when the person asks, and a terminal shows it as a link. */
export const BROWSER_LOGIN_COPY = {
  lead: (provider: string) => `Log in to ${provider} on its login page.`,
  open: "Open login page",
  paste: "If the page shows a code, paste it here. If the page opens a local address that cannot connect, paste that full address here.",
  placeholder: "Code or address",
  submitted: "Finishing login…",
} as const

/** Shared wording for the project-local account recovery question. */
export const LOGIN_QUESTION_COPY = {
  title: "Log in again?",
  confirm: "Log in again",
  decline: "End waiting runs",
  starting: "Starting login…",
  cancelHint: "esc end waiting runs",
  finishHint: "enter finish login  esc end waiting runs",
  lead: (question: RuntimeAuthLoginQuestion) => `Log in as ${question.accountDisplayName} in profile ${question.profileDisplayName}.`,
  detail: (question: RuntimeAuthLoginQuestion) => `${question.providerDisplayName} refused the login for ${question.accountDisplayName} in profile ${question.profileDisplayName}. Log in again to continue any waiting runs in this project. Choose "End waiting runs" to end them with the login error. Later runs on this account also end until a new login.`,
} as const

/** The account's name as a row shows it: its label, then its plan when the provider names one. */
export function accountTitle(account: Pick<AuthProviderAccountStatus, "displayLabel" | "plan">): string {
  return account.plan === undefined ? account.displayLabel : `${account.displayLabel} · ${account.plan}`
}

/** What a disconnect does, as its confirmation states it. A login that a program owns ends through that program's
 *  own logout, but the login belongs to this profile alone: the program's own login on the computer, and every other
 *  app's login, stay. `account` names the one account, and without it the disconnect logs out every account of the
 *  provider in this profile. A credential that Flywheel stores only leaves the profile. */
export function disconnectConsequence(provider: Pick<AuthProviderStatus, "loginProgram">, account?: Pick<AuthProviderAccountStatus, "identity">): string {
  const program = provider.loginProgram
  if (program === undefined) return "Its stored credential is removed from this profile. Sign in again to reconnect."
  return `This logs ${account?.identity ?? "every account"} out of this Flywheel profile. ${program} and other apps keep their own logins. Log in again to reconnect.`
}

/** The repair that an account's login needs before it serves again: "Log in again" for a login that the provider
 *  refused, else "Reconnect" for an expired credential, else nothing. */
export function accountRepairLabel(account: Pick<AuthProviderAccountStatus, "expired" | "attention">): "Log in again" | "Reconnect" | undefined {
  if (account.attention?.kind === "login-rejected") return "Log in again"
  return account.expired ? "Reconnect" : undefined
}
