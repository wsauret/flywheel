import { errorMessage } from "../../infra/error-message.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import type { FrontendEvent } from "../../protocol/app-service-types.js"
import type { RuntimeOwnership } from "../app-service/runtime-ownership.js"
import { createSubscriptionSpendConsentNotificationMaterializer, materializeSubscriptionSpendConsentAuthChange } from "../subscription-spend-consent/notification-materializer.js"
import type { AuthRuntime } from "../app-service/auth-runtime.js"

/** The notifications subscription usage raises: threshold crossings as
 *  provider readings publish, and paid-use consent review as the auth view
 *  changes. Composed apart from the runtime root because the three pieces
 *  share one notify seam and one failure shape and nothing else needs them. */
export interface SubscriptionNotificationInput {
  readonly authRuntime: AuthRuntime
  readonly notify: (episode: NotificationEpisodeInput) => Promise<void>
  readonly projectRoot: string
  readonly providerName: (providerId: string) => string
  readonly bus: { addListener(listener: (event: FrontendEvent) => void): void; removeListener(listener: (event: FrontendEvent) => void): void }
  readonly log: { warn(message: string, fields: { readonly error: string }): void }
}

/** The two materializers the app service reports through. */
export interface SubscriptionNotificationMaterializers {
  readonly subscriptionSpendConsentMaterializer: ReturnType<typeof createSubscriptionSpendConsentNotificationMaterializer>
}

export function composeSubscriptionNotifications(scope: RuntimeOwnership, input: SubscriptionNotificationInput): SubscriptionNotificationMaterializers {
  const { authRuntime, notify, bus, log } = input
const subscriptionUsage = authRuntime.subscriptionUsage
scope.own("subscription-usage-publication-subscription", subscriptionUsage.subscribePublications((_profile, scopes, service) => {
  const authScope = scopes[0]
  if (authScope === undefined) return
  void (async () => {
    await authRuntime.refreshSubscriptionSpendConsent(authScope, service)
  })().catch((error: unknown) => {
    log.warn("subscription usage publication materialization failed", { error: errorMessage(error) })
  })
}), (unsubscribe) => { unsubscribe() })
const subscriptionSpendConsentMaterializer = scope.own("subscription-spend-consent-notification-materializer", createSubscriptionSpendConsentNotificationMaterializer({ notify }), (materializer) => { materializer.closeAdmission(); return materializer.settled() })
const materializeSubscriptionSpendConsent = (event: FrontendEvent): void => { void materializeSubscriptionSpendConsentAuthChange(subscriptionSpendConsentMaterializer, event) }
scope.own("subscription-spend-consent-materialization-listener", materializeSubscriptionSpendConsent, (listener) => { bus.removeListener(listener) })
bus.addListener(materializeSubscriptionSpendConsent)
void authRuntime.authStatusProjection.snapshot({ kind: "defaults" })
  .then((auth) => subscriptionSpendConsentMaterializer.materializeAuth(auth))
  .catch((error: unknown) => { log.warn("subscription consent materialization failed", { error: errorMessage(error) }) })
  return { subscriptionSpendConsentMaterializer }
}
