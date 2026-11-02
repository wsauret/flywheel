import { createHash } from "node:crypto"
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../infra/notification-episode.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import type { FrontendEvent } from "../../protocol/app-service-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { paidModeAwaitsAnswer, type SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js"
type AvailableConsentView = Extract<SubscriptionSpendConsentView, { kind: "available" }>

interface SubscriptionSpendConsentNotificationMaterializerDeps {
  /** The notify seam (ARCH-STRUCTURE-034). Each publication states the episodes active
   *  under this source's prefix; the observer raises and resolves the rest. */
  readonly notify: (episode: NotificationEpisodeInput) => Promise<void>
}

export interface SubscriptionSpendConsentNotificationMaterializer {
  /** Settles once the view's episodes have been stated to the seam, or once a newer view made it stale. */
  materialize(consent: SubscriptionSpendConsentView): Promise<void>
  materializeAuth(auth: RuntimeAuthView): Promise<void>
  closeAdmission(): void
  settled(): Promise<void>
}

/** Materializes the consent view carried by an auth publication without consulting mutable defaults. */
export function materializeSubscriptionSpendConsentAuthChange(
  materializer: Pick<SubscriptionSpendConsentNotificationMaterializer, "materializeAuth">,
  event: FrontendEvent,
): Promise<void> | undefined {
  if (event.type !== "patch" || event.patch.payload.kind !== "auth.changed") return undefined
  return materializer.materializeAuth(event.patch.payload.auth)
}

function notificationProfileSourcePrefix(profileId: string): string {
  const digest = createHash("sha256").update(profileId, "utf8").digest("hex")
  return `${NOTIFICATION_SOURCE_PREFIX}${digest}:`
}

function notificationAuthoritySourcePrefix(profileId: string, authorityIncarnation: string): string {
  const digest = createHash("sha256").update(authorityIncarnation, "utf8").digest("hex")
  return `${notificationProfileSourcePrefix(profileId)}${digest}:`
}

function notificationSourceId(profileId: string, authorityIncarnation: string, accountCorrelationId: string, envelopeId: string): string {
  const digest = createHash("sha256").update(`${accountCorrelationId}\0${envelopeId}`, "utf8").digest("hex")
  return `${notificationAuthoritySourcePrefix(profileId, authorityIncarnation)}${digest}`
}

const NOTIFICATION_SOURCE_PREFIX = "subscription-spend-consent:"

/** Materializes transient consent views into project-local durable notification episodes through the notify seam. */
export function createSubscriptionSpendConsentNotificationMaterializer(
  deps: SubscriptionSpendConsentNotificationMaterializerDeps,
): SubscriptionSpendConsentNotificationMaterializer {
  let accepting = true
  const lane = createOrderedLane()

  const authorities = new Map<string, {
    incarnation: string
    revision: number
    usageGeneration: number
    readonly retiredIncarnations: Set<string>
  }>()

  const acceptCurrentView = (consent: SubscriptionSpendConsentView): boolean => {
    if (consent.kind !== "available") return false
    const { authorityIncarnation, authorityRevision, profileId, usageGeneration } = consent

    const current = authorities.get(profileId)
    if (current === undefined) {
      authorities.set(profileId, {
        incarnation: authorityIncarnation,
        revision: authorityRevision,
        retiredIncarnations: new Set(),
        usageGeneration,
      })
      return true
    }
    if (current.incarnation === authorityIncarnation) {
      if (authorityRevision < current.revision || usageGeneration < current.usageGeneration) return false
      current.revision = authorityRevision
      current.usageGeneration = usageGeneration
      return true
    }
    if (current.retiredIncarnations.has(authorityIncarnation)) return false

    current.retiredIncarnations.add(current.incarnation)
    current.incarnation = authorityIncarnation
    current.revision = authorityRevision
    current.usageGeneration = usageGeneration
    return true
  }

  const remainsCurrent = (consent: AvailableConsentView): boolean => {
    const current = authorities.get(consent.profileId)
    return current !== undefined
      && current.incarnation === consent.authorityIncarnation
      && current.revision === consent.authorityRevision
      && current.usageGeneration === consent.usageGeneration
  }

  const desiredEpisodes = (consent: AvailableConsentView): readonly NotificationOccurrence[] => consent.accounts.flatMap((account) => {
    const mode = account.modes.find(paidModeAwaitsAnswer)
    return mode === undefined ? [] : [{
      sourceId: notificationSourceId(consent.profileId, consent.authorityIncarnation, account.accountCorrelationId, mode.envelopeId),
      title: "Review paid subscription capacity",
      message: `Paid subscription capacity for ${account.providerDisplayName} is available but remains off until you review the account.`,
      severity: "warning",
      action: { kind: "open-auth", providerId: account.providerId, accountCorrelationId: account.accountCorrelationId, envelopeId: mode.envelopeId },
    }]
  })

  /** One publication states the episodes active for the current profile. With
   *  the catalog known it also retires every profile the catalog no longer
   *  lists: the other listed profiles are kept because their views were not
   *  read. Publications queue in order, and one a newer view overtook says
   *  nothing, so a stale view never raises an episode the newer one retires. */
  const enqueuePublication = (consent: AvailableConsentView | undefined, catalogProfileIds?: readonly string[]): Promise<void> =>
    lane.run(async () => {
      if (consent !== undefined && !remainsCurrent(consent)) return
      if (consent !== undefined) {
        await deps.notify({ type: "reconcile", prefix: notificationProfileSourcePrefix(consent.profileId), desired: desiredEpisodes(consent) })
      }
      if (catalogProfileIds === undefined) return
      const keep = catalogProfileIds.filter((profileId) => profileId !== consent?.profileId).map(notificationProfileSourcePrefix)
      await deps.notify({ type: "reconcile", prefix: NOTIFICATION_SOURCE_PREFIX, desired: consent === undefined ? [] : desiredEpisodes(consent), keep })
    })

  const materialize = (consent: SubscriptionSpendConsentView): Promise<void> => {
    if (!accepting || consent.kind !== "available") return Promise.resolve()
    if (!acceptCurrentView(consent)) return Promise.resolve()
    return enqueuePublication(consent)
  }

  const materializeAuth = (auth: RuntimeAuthView): Promise<void> => {
    if (!accepting) return Promise.resolve()
    const consent = auth.subscriptionSpendConsent.kind === "available" ? auth.subscriptionSpendConsent : undefined
    if (consent !== undefined && !acceptCurrentView(consent)) return Promise.resolve()
    return enqueuePublication(consent, [auth.profile.id, ...auth.profile.availableProfiles.map((profile) => profile.id)])
  }

  // After admission closes nothing joins the lane, so its settlement covers
  // every admitted publication.
  const closeAdmission = (): void => { accepting = false }

  return {
    materialize,
    materializeAuth,
    closeAdmission,
    settled: () => {
      closeAdmission()
      return lane.settled()
    },
  }
}
