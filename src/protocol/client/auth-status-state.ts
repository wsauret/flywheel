import type { AuthAccountAttention, AuthProviderAccountStatus, AuthProviderAttention, AuthProviderSource, AuthProviderStatus, RuntimeAuthLoginQuestion, RuntimeAuthView } from "../auth-status-protocol-types.js"
import type { ProviderCatalogDiscovery } from "../provider-model-preference-protocol-types.js"

/** What the auth view states about one provider or one account. */
export interface AuthStatusInput {
  readonly source: AuthProviderSource
  readonly expired: boolean
  readonly attention?: AuthProviderAttention | AuthAccountAttention
  readonly catalog?: ProviderCatalogDiscovery
}

/** The state of one provider or one account, which every client shows in its own words. `needs-attention` holds a
 *  problem that the view names, or a model catalog that the provider refused for the login. */
export type AuthStatusState = "needs-attention" | "invalid" | "unconfigured" | "misconfigured" | "expired" | "stored" | "connected"

/** Returns the project's asking episodes in provider-owner order, independent of foreground auth scope. */
export function loginQuestions(view: Pick<RuntimeAuthView, "loginQuestions"> | undefined): readonly RuntimeAuthLoginQuestion[] {
  return view?.loginQuestions ?? []
}

export function authStatusState(status: AuthStatusInput): AuthStatusState {
  const catalogRefused = status.catalog?.kind === "unavailable"
    ? status.catalog.reason === "authentication-invalid"
    : status.catalog?.liveOutcome === "authentication-invalid"
  if (status.attention !== undefined || catalogRefused) return "needs-attention"
  if (status.source === "invalid") return "invalid"
  if (status.source === "unconfigured") return "unconfigured"
  if (status.source === "misconfigured") return "misconfigured"
  if (status.expired) return "expired"
  return status.source === "stored_key" ? "stored" : "connected"
}

/** The status input of one account: the account's own problem, else its provider's, such as a program that the
 *  provider cannot find, because no account of that provider can serve then. */
export function accountStatusInput(provider: Pick<AuthProviderStatus, "attention">, account: AuthProviderAccountStatus): AuthStatusInput {
  const attention = account.attention ?? provider.attention
  return { source: account.source, expired: account.expired, ...(attention === undefined ? {} : { attention }), ...(account.catalog === undefined ? {} : { catalog: account.catalog }) }
}
