import type { AuthProviderStatus, RuntimeAuthView } from "../../../src/protocol/auth-status-protocol-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"

export type Provider = AuthProviderStatus

/** One provider's auth status; the default is a model provider with a stored key. */
export function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    providerId: "anthropic_api", kind: "singleton", displayName: "Anthropic", group: "model", source: "stored_key", expired: false,
    loginMethod: "api-key", modelCapable: true, statusRank: 0, accounts: [], ...overrides,
  }
}

/** One model provider with a stored key: the auth view of a person who can chat. */
export const CONNECTED_PROVIDER: Provider = provider()

/** The auth view of the default profile with `providers` and nothing else to report. */
export function authView(providers: readonly Provider[]): RuntimeAuthView {
  return {
    providers, warnings: [],
    profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [] },
    subscriptionSpendConsent: { kind: "unavailable", profileId: "default", message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE },
  }
}

/** A runtime that answers the auth read with `providers`, or never. */
export function fakeConnection(
  providers: readonly Provider[] | "never-answers",
): RuntimeConnection & { readonly authReads: () => number } {
  let authReads = 0
  const connection = fakeRuntimeConnection({ queries: {
    authStatusSnapshot: () => {
      authReads += 1
      if (providers === "never-answers") return new Promise(() => {})
      return { snapshotPosition: 0, auth: authView(providers) }
    },
  } })
  return { ...connection, authReads: () => authReads }
}

export async function settle(): Promise<void> {
  // The session reads auth in the background rather than blocking construction.
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
