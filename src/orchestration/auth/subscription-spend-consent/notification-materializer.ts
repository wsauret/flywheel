import { createHash } from "node:crypto"
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../../infra/substrate/events/notification-episode.js"
import { createOrderedLane } from "../../../infra/async/ordered-lane.js"
import type { FrontendEvent } from "../../../protocol/runtime/app-service-types.js"
import type { RuntimeAuthView } from "../../../protocol/auth/auth-status-protocol-types.js"
import type { SubscriptionUsageSpendSource } from "../../../infra/providers/llm/usage/subscription-usage.js"
import { paidModeAwaitsAnswer, type SubscriptionSpendConsentView } from "../../../protocol/auth/subscription-spend-consent-protocol-types.js"
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

function evidenceUnknown(evidence: SubscriptionUsageSpendSource): boolean {
  return evidence.kind === "prepaid" ? evidence.availability === "unknown" : evidence.enablement === "unknown"
}

/** Materializes transient consent views into durable profile notification episodes through the notify seam. */
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

  /** The source of each mode that may still await an answer but whose
   *  evidence the usage service has not read yet, as at an executor start.
   *  Its episode stays as it is: only evidence that the review no longer
   *  applies resolves it (PI-INTERACTION-072). */
  const unknownEvidenceSources = (consent: AvailableConsentView): readonly string[] => consent.accounts.flatMap((account) =>
    account.modes.flatMap((mode) => mode.decision === "unreviewed" && evidenceUnknown(mode.evidence)
      ? [notificationSourceId(consent.profileId, consent.authorityIncarnation, account.accountCorrelationId, mode.envelopeId)]
      : []))

  /** One publication states the episodes active for one profile, in that
   *  profile's journal, so every project that uses the profile shows them.
   *  Publications queue in order, and one a newer view overtook says
   *  nothing, so a stale view never raises an episode the newer one retires. */
  const enqueuePublication = (consent: AvailableConsentView): Promise<void> =>
    lane.run(async () => {
      if (!remainsCurrent(consent)) return
      const { profileId } = consent
      await deps.notify({ type: "reconcile", profileId, prefix: notificationProfileSourcePrefix(profileId), desired: desiredEpisodes(consent), keep: unknownEvidenceSources(consent) })
    })

  // An unavailable view proves nothing about a review, so it states nothing.
  const materialize = (consent: SubscriptionSpendConsentView): Promise<void> => {
    if (!accepting || consent.kind !== "available") return Promise.resolve()
    if (!acceptCurrentView(consent)) return Promise.resolve()
    return enqueuePublication(consent)
  }

  const materializeAuth = (auth: RuntimeAuthView): Promise<void> => materialize(auth.subscriptionSpendConsent)

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
