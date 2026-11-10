import { captureSubscriptionCredentials } from "../../../infra/auth/auth-context.js"
import { loadAuthStoreWithDiagnostics, storedApiKeyHint } from "../../../infra/auth/auth-store.js"
import { subscriptionSpendAccountCorrelationId } from "../../../protocol/subscription-spend-consent-protocol-types.js"
import type { MeteredUsageSource } from "./usage-projection.js"
import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import type { FirstPartyModuleComposition } from "../../modules.js"

import { accessProviderRegistry } from "../../agent-runtime/llm/access-provider-registry.js"
import { isUsageAttemptLive, USAGE_SETTLEMENT_IN_FLIGHT_KIND } from "../../agent-runtime/usage-settlement.js"
import { credentialSlotClassifier } from "../../auth/credential-slot-classifier.js"
interface RuntimeUsageDepsOptions {
  readonly moduleSelection: () => FirstPartyModuleComposition
  readonly eventReader: Pick<AsyncEventStateReadSurface, "inFlightProfileKeys">
}

/** Derives the unified Usage service's provider and unsettled-session views from their owning runtime projections. */
export function createRuntimeUsageDeps(options: RuntimeUsageDepsOptions) {
  return {
    /** Every source that bills per request: each metered provider's key, and each subscription account whose own
     *  billing is metered, such as a Claude usage-only enterprise account, which has no provider allowance to read. */
    meteredUsageSources: (profile: { readonly id: string; readonly directory: string }): readonly MeteredUsageSource[] => {
      const composition = options.moduleSelection()
      const definitions = accessProviderRegistry(composition).selection.definitions
      const { store, credentialLineages } = loadAuthStoreWithDiagnostics(profile.directory, undefined, credentialSlotClassifier(composition))
      const keys = definitions.flatMap((definition): MeteredUsageSource[] => {
        if (definition.billing !== "metered") return []
        const sourceId = credentialLineages[definition.id]
        const identity = storedApiKeyHint(store, definition.id)
        return sourceId === undefined ? [] : [{ kind: "metered", sourceId, providerId: definition.id, label: definition.shortName, spendMode: definition.spendMode, ...(identity === undefined ? {} : { identity }) }]
      })
      const accounts = [...captureSubscriptionCredentials(definitions, { kind: "decoded", store, authDir: profile.directory })].flatMap(([providerId, captured]) => captured.flatMap((account): MeteredUsageSource[] => account.billing !== "metered" ? [] : [{
        kind: "metered", sourceId: subscriptionSpendAccountCorrelationId(profile.id, providerId, account.instanceId), providerId,
        label: account.label || (definitions.find(({ id }) => id === providerId)?.shortName ?? providerId), spendMode: "direct_api",
        ...(account.identity === undefined ? {} : { identity: account.identity }),
      }]))
      return [...keys, ...accounts]
    },
    usageProviderDisplayName: (providerId: string) => accessProviderRegistry(options.moduleSelection()).selection.definitions.find(({ id }) => id === providerId)?.shortName ?? providerId,
    providerDefinitions: () => accessProviderRegistry(options.moduleSelection()).selection.definitions,
    /** A cell of a live attempt is a request still in progress; only a cell no live attempt owns is an ended request
     *  whose usage the ledger lacks. */
    usageIncomplete: async (profileId: string) =>
      (await options.eventReader.inFlightProfileKeys(USAGE_SETTLEMENT_IN_FLIGHT_KIND, profileId)).some((attemptId) => !isUsageAttemptLive(attemptId)),
  }
}
