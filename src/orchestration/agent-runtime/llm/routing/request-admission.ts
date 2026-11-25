import type { ProviderConnection } from "../../../../infra/providers/auth/auth-context.js";
import type { SubscriptionSpendAuthorization } from "../../../../infra/providers/auth/subscription/subscription-spend-consent.js";
import { createSubscriptionAccountIdentity } from "../../../../infra/providers/auth/subscription/subscription-account-identity.js";
import type { AccessProviderCandidate } from "../../../../infra/providers/llm/access/access-provider.js";
import type { RequestAdmission, SubscriptionAdmissionCapture } from "./provider-availability-types.js";

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
