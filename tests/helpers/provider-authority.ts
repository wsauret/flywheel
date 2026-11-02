import type { AccessProviderCandidate, AccessProviderId, AccessProviderModelEligibility } from "../../src/infra/llm/access-provider.js";
import { composeFirstPartyModules, type FirstPartyModuleComposition } from "../../src/orchestration/modules.js";
import { canonicalModelId } from "../../src/infra/llm/model-id.js";
import { fakeModelInfos } from "./model-tier-fixtures.js";
import { randomUUID } from "node:crypto";
import { Scope } from "effect";
import type { ProviderSessionLifetime } from "../../src/orchestration/agent-runtime/llm/types.js";

import { accessProviderRegistry, type AccessProviderRegistry } from "../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
export function testCapabilityModules(): FirstPartyModuleComposition { return composeFirstPartyModules(); }

/** The lifetime of a client that a test builds and never ends: the clients of such tests make only fake network
 *  requests, so nothing that the scope would hold outlives them. Each call names its own provider session. */
export function testProviderSessionLifetime(): ProviderSessionLifetime {
  return { providerSessionKey: `test-${randomUUID()}`, scope: Scope.makeUnsafe() };
}
export function testProviderRegistry(): AccessProviderRegistry { return accessProviderRegistry(testCapabilityModules()); }
export function testProviderSelection(): AccessProviderRegistry["selection"] { return testProviderRegistry().selection; }
export function testProviderBilling(provider: AccessProviderId): ReturnType<AccessProviderRegistry["selection"]["billing"]> { return testProviderSelection().billing(provider); }

/** Exact offering evidence for tests whose subject is downstream of catalog discovery. */
export function testProviderEligibility(
  unavailable: ReadonlySet<AccessProviderId> = new Set(),
): AccessProviderModelEligibility {
  return {
    modelIds: new Set(fakeModelInfos.keys()),
    profileId: "default",
    revision: 1,
    modelUnavailableReason: (provider) => unavailable.has(provider) ? `${provider} is unavailable.` : undefined,
    candidateOffering: (candidate: AccessProviderCandidate, model: string) => {
      if (unavailable.has(candidate.providerId)) return undefined;
      const resolvedModelMetadata = fakeModelInfos.get(canonicalModelId(model));
      return {
        candidate,
        wireModelId: model,
        dataUse: "standard",
        catalogProvenance: "static",
        ...(resolvedModelMetadata === undefined ? {} : { resolvedModelMetadata }),
        ...(candidate.providerId === "github_copilot"
          ? { transport: resolvedModelMetadata?.family === "anthropic" ? "anthropic-messages" : "openai-responses" }
          : {}),
      };
    },
  };
}
