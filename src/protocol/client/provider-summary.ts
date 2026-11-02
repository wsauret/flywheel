import type { RuntimeAuthView } from "../auth-status-protocol-types.js"

/** One model provider, as the panel needs to show it. */
export interface ProviderSummary {
  readonly id: string
  readonly displayName: string
  readonly connected: boolean
  readonly expired: boolean
  /** Carried through so the panel can say what is actually wrong. A key the
   *  provider rejected and a config file that failed to load both look like
   *  "not connected" from here, and each needs a different thing done about it. */
  readonly source: "stored_key" | "oauth" | "invalid" | "unconfigured" | "misconfigured"
  readonly detail?: string
  readonly loginMethod: "api-key" | "browser-auth" | "device-code"
}

/** The model providers of an auth view, in display order. Non-model providers
 *  (search, tooling) never reach the panel: they are not something a person
 *  connects to get a turn. */
export function summarizeProviders(auth: RuntimeAuthView): readonly ProviderSummary[] {
  return auth.providers
    .filter((provider) => provider.group === "model")
    .map((provider) => ({
      id: provider.providerId,
      displayName: provider.displayName,
      connected: provider.source === "stored_key" || provider.source === "oauth",
      expired: provider.expired,
      source: provider.source,
      ...(provider.detail === undefined ? {} : { detail: provider.detail }),
      loginMethod: provider.loginMethod,
    }))
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName))
}
