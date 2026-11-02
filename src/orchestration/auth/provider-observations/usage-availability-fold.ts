import type { AccessProviderCandidate } from "../../../infra/llm/access-provider.js"
import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import type { ProviderAvailabilityOwner } from "../../agent-runtime/llm/provider-availability-types.js"
import type { SubscriptionUsagePublishedSnapshot } from "./subscription-usage-service.js"

const log = Log.create({ service: "usage-availability-fold" })

/**
 * Feeds each published ChatGPT Usage report to the availability owner as that
 * account's window observation. Applying a banked reset, a window rolling over,
 * or a reset redeemed in another ChatGPT client all surface here as fresh evidence
 * that reopens the account, so routing never waits on a suppression the provider
 * has already lifted. Best effort: a fold that cannot reach the authority leaves
 * the publication itself untouched.
 */
export function foldSubscriptionUsageIntoAvailability(owner: ProviderAvailabilityOwner, snapshot: SubscriptionUsagePublishedSnapshot): void {
  for (const state of snapshot.accounts) {
    if (state.kind !== "supported" || state.account.providerId !== "chatgpt") continue
    const candidate: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: state.account.instanceId, spendMode: "included" }
    try {
      owner.forCandidates(snapshot.profileId, [candidate]).observeChatGptUsage(candidate, state.snapshot.metrics, state.snapshot.observedAtMs)
    } catch (error) {
      log.warn("a ChatGPT usage report could not reach the availability authority", { instanceId: state.account.instanceId, error: errorMessage(error) })
    }
  }
}
