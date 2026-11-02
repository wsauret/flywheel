import { openExistingAuthProfileDirectory, type AuthProfileAccess } from "../../infra/auth/auth-profile-store.js"
import { heldDirectoryDerivation } from "../../infra/watched-directory-values.js"
import { SUBSCRIPTION_SPEND_CONSENT_FILE, subscriptionSpendConsentRevision, type SubscriptionSpendConsentRevision } from "../../infra/auth/subscription-spend-consent-store.js"
import { accessProviderAccountKey, type AccessProviderCandidate, type AccessProviderDefinition } from "../../infra/llm/access-provider.js"
import { providerSettingValues, type AccessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { availableSubscriptionUsageResetCredits } from "../../infra/llm/subscription-usage.js"
import { metricUsedFraction } from "../../infra/llm/subscription-usage-store-codec.js"
import type { RequestAdmission, SubscriptionAllowanceAdmission, SubscriptionAllowanceResolver, SubscriptionBankedResetResolver, SubscriptionExpiringResetResolver } from "../agent-runtime/llm/provider-availability-types.js"
import type { RuntimeConfigRequestCapture } from "../agent-runtime/request-config.js"
import type { SubscriptionUsageProfile } from "../auth/provider-observations/subscription-usage-service.js"
import type { SubscriptionUsageServiceLease, SubscriptionUsageServicePool } from "../auth/provider-observations/subscription-usage-service-pool.js"
import type { SubscriptionSpendConsentCaptureCache } from "./capture-cache.js"
import { createSubscriptionSpendConsentRuntime } from "./runtime-composition.js"
import type { SubscriptionSpendAuthorization, SubscriptionSpendConsentCapture } from "./subscription-spend-consent-service.js"
import type { ProviderConnection } from "../../infra/auth/auth-context.js"
import { createSubscriptionAccountIdentity } from "../../infra/llm/subscription-account-identity.js"

export interface SubscriptionAdmissionCapture {
  readonly consent: SubscriptionSpendConsentCapture
  readonly subscriptionAllowanceFor: SubscriptionAllowanceResolver
  readonly bankedResetFor: SubscriptionBankedResetResolver
  readonly expiringResetFor: SubscriptionExpiringResetResolver
}

const CONSENT_REVISION = heldDirectoryDerivation<SubscriptionSpendConsentRevision>([SUBSCRIPTION_SPEND_CONSENT_FILE])
const UNKNOWN_ALLOWANCE: SubscriptionAllowanceAdmission = Object.freeze({ allowance: "unknown" })

/** Folds every enabled provider's allowance admission into one resolver: a
 *  provider that declares none, or that the request plans no candidate for,
 *  answers unknown, which the walk does not gate on. */
async function captureAllowance(registry: Pick<AccessProviderRegistry, "allowance" | "settings">, candidates: readonly AccessProviderCandidate[], providerSettings: RuntimeConfigRequestCapture["providerSettings"], usage: Pick<SubscriptionUsageServiceLease["service"], "metric" | "checkAccounts">): Promise<SubscriptionAllowanceResolver> {
  const planned = new Set(candidates.map((candidate) => candidate.providerId))
  const resolvers = new Map<string, SubscriptionAllowanceResolver>()
  for (const [providerId, factory] of registry.allowance) {
    if (!planned.has(providerId)) continue
    resolvers.set(providerId, await factory({ candidates, usage, settings: providerSettingValues(registry.settings, providerId, providerSettings) }))
  }
  return Object.freeze((candidate: AccessProviderCandidate): SubscriptionAllowanceAdmission => resolvers.get(candidate.providerId)?.(candidate) ?? UNKNOWN_ALLOWANCE)
}

/** Holds the usage publication already in memory, the one Usage shows, and
 *  reads it only when a refusal asks. A runtime that has not read an account,
 *  such as a headless run, names no banked reset for it, and a request makes
 *  no durable read. */
function captureBankedResets(usage: SubscriptionUsageServiceLease["service"]): SubscriptionBankedResetResolver {
  const accounts = usage.snapshot()?.accounts ?? []
  return Object.freeze((candidate: AccessProviderCandidate) => {
    if (candidate.kind !== "subscription") return false
    const state = accounts.find((entry) => entry.account.providerId === candidate.providerId && entry.account.instanceId === candidate.instanceId)
    return state !== undefined && "snapshot" in state && state.snapshot !== undefined && availableSubscriptionUsageResetCredits(state.snapshot.resetCredits).length > 0
  })
}

/** Holds, from the usage publication already in memory, when each account
 *  resets the expiring window its provider declares. The moments are fixed
 *  at admission: a reset at or before it is a reading the next poll has not
 *  replaced yet, so it counts as unknown, as no reading does. A window that
 *  reads fully used has no quota left to expire, so its reset is unknown too;
 *  the account stays a candidate and only the provider's refusal ends it. */
function captureExpiringResets(definitions: readonly AccessProviderDefinition[], usage: SubscriptionUsageServiceLease["service"]): SubscriptionExpiringResetResolver {
  const windows = new Map(definitions.flatMap((definition) => definition.usage?.expiringWindow === undefined ? [] : [[definition.id, definition.usage.expiringWindow] as const]))
  const admittedAtMs = Date.now()
  const resets = new Map<string, number>()
  for (const state of usage.snapshot()?.accounts ?? []) {
    const window = windows.get(state.account.providerId)
    if (window === undefined || !("snapshot" in state) || state.snapshot === undefined) continue
    const metric = state.snapshot.metrics.find((entry) => entry.metricKey === window)
    if (metric === undefined || (metricUsedFraction(metric) ?? 0) >= 1) continue
    const resetAtMs = metric.timing.kind === "exact" ? metric.timing.endMs : metric.timing.resetAtMs
    if (resetAtMs !== undefined && resetAtMs > admittedAtMs) resets.set(accessProviderAccountKey({ kind: "subscription", providerId: state.account.providerId, instanceId: state.account.instanceId }), resetAtMs)
  }
  return Object.freeze((candidate: AccessProviderCandidate) => resets.get(accessProviderAccountKey(candidate)))
}

/** Captures included-allowance policy and saved paid permissions. Releases an acquired lease on success or failure; the capture owns no service. */
export async function captureSubscriptionAdmission(input: {
  readonly candidates: readonly AccessProviderCandidate[]
  readonly providerSettings: RuntimeConfigRequestCapture["providerSettings"]
  readonly registry: Pick<AccessProviderRegistry, "allowance" | "settings" | "selection">
  readonly profile: SubscriptionUsageProfile
  readonly residentLease?: SubscriptionUsageServiceLease
  readonly pool: Pick<SubscriptionUsageServicePool, "acquire">
  readonly consentCache: SubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>
  /** A read-only view, such as the model picker, reads an account's usage again only when the evidence in memory is
   *  out of date. A request forces the reads its provider asks for; a view that a person opens must not wait on them. */
  readonly view?: true
}): Promise<SubscriptionAdmissionCapture> {
  const lease = input.residentLease ?? await input.pool.acquire(input.profile)
  try {
    const usage = input.view === true
      ? { metric: lease.service.metric, checkAccounts: (accounts: Parameters<typeof lease.service.checkAccounts>[0]) => lease.service.checkAccounts(accounts) }
      : lease.service
    const subscriptionAllowanceFor = await captureAllowance(input.registry, input.candidates, input.providerSettings, usage)
    // A held consent revision and a cached capture answer the request without
    // the profile directory, so it opens only for a read that needs it.
    let access: AuthProfileAccess | undefined
    const opened = (): AuthProfileAccess => {
      access ??= openExistingAuthProfileDirectory(input.profile.directory)
      return access
    }
    try {
      const consent = await input.consentCache.capture({
        profileDirectory: input.profile.directory,
        accountGeneration: lease.service.generation,
        readRevision: () => CONSENT_REVISION.read(input.profile.directory, () => subscriptionSpendConsentRevision(opened())),
        lockedCapture: () => createSubscriptionSpendConsentRuntime({ profileId: input.profile.id, access: opened(), usage: lease.service, providers: input.registry.selection.definitions }).capture(),
      })
      return Object.freeze({ consent, subscriptionAllowanceFor, bankedResetFor: captureBankedResets(lease.service), expiringResetFor: captureExpiringResets(input.registry.selection.definitions, lease.service) })
    } finally { access?.close() }
  } finally {
    if (input.residentLease === undefined) await lease.release()
  }
}

/** Builds the request admission that one subscription capture states for `connection`: only a paid-use authorization that names one of its accounts admits a paid spend mode. */
export async function requestAdmissionFromCaptures(capture: SubscriptionAdmissionCapture | undefined, connection: ProviderConnection | undefined): Promise<RequestAdmission> {
  const authorizations = new Map<string, SubscriptionSpendAuthorization>()
  const consent = capture?.consent
  if (consent !== undefined) {
    const accountMatches = (providerId: string, instanceId: string, subjectDigest: string): boolean => {
      if (connection?.profileId === undefined || connection.profileId !== consent.profileId) return false
      const account = connection.subscriptionCredentials.get(providerId)?.find((candidate) => candidate.instanceId === instanceId)
      return account?.identity !== undefined
        && createSubscriptionAccountIdentity(providerId, instanceId, account.identity).subjectDigest === subjectDigest
    }
    for (const authorization of consent.authorizations.values()) {
      const envelope = authorization.envelope
      if (authorization.profileId !== consent.profileId
        || authorization.account.providerId !== envelope.providerId
        || authorization.account.instanceId !== envelope.instanceId
        || authorization.account.subjectDigest !== envelope.subjectDigest
        || !accountMatches(envelope.providerId, envelope.instanceId, envelope.subjectDigest)) continue
      authorizations.set(`${envelope.providerId}\0${envelope.instanceId}\0${envelope.mode}`, authorization)
    }
  }
  return Object.freeze({
    subscriptionSpendAuthorizationFor: (candidate: AccessProviderCandidate) => candidate.kind === "subscription"
      ? authorizations.get(`${candidate.providerId}\0${candidate.instanceId}\0${candidate.spendMode}`)
      : undefined,
    ...(capture === undefined ? {} : { subscriptionAllowanceFor: capture.subscriptionAllowanceFor, bankedResetFor: capture.bankedResetFor, expiringResetFor: capture.expiringResetFor }),
  })
}
