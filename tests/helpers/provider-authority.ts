import type { AccessProviderCandidate, AccessProviderCandidateAttribution, AccessProviderId, AccessProviderModelEligibility } from "../../src/infra/providers/llm/access/access-provider.js";
import { composeFirstPartyModules } from "../../src/orchestration/module-contract/module-composition.js";
import type { FirstPartyModuleComposition } from "../../src/orchestration/module-contract/module-catalog.js";
import { canonicalModelId } from "../../src/infra/providers/model-id.js";
import { fakeModelInfos } from "./model-tier-fixtures.js";
import { randomUUID } from "node:crypto";
import { Scope } from "effect";
import type { ProviderSessionLifetime } from "../../src/orchestration/agent-runtime/llm/types.js";

import { accessProviderRegistry, type AccessProviderRegistry } from "../../src/orchestration/config/models/access-provider-registry.js";
export function testCapabilityModules(): FirstPartyModuleComposition { return composeFirstPartyModules(); }

/** The lifetime of a client that a test builds and never ends: the clients of such tests make only fake network
 *  requests, so nothing that the scope would hold outlives them. Each call names its own provider session. */
export function testProviderSessionLifetime(): ProviderSessionLifetime {
  return { providerSessionKey: `test-${randomUUID()}`, scope: Scope.makeUnsafe() };
}
export function testProviderRegistry(): AccessProviderRegistry { return accessProviderRegistry(testCapabilityModules()); }
export function testProviderSelection(): AccessProviderRegistry["selection"] { return testProviderRegistry().selection; }
export function testProviderBilling(provider: AccessProviderId): ReturnType<AccessProviderRegistry["selection"]["billing"]> { return testProviderSelection().billing(provider); }

/** A complete eligibility from the fields a test states. An unstated field lists no model, refuses no provider or
 *  account, offers nothing, and has no pending access check. */
export function testEligibility(fields: Partial<AccessProviderModelEligibility>): AccessProviderModelEligibility {
  return {
    modelIds: new Set(),
    modelUnavailableReason: () => undefined,
    candidateModelUnavailableReason: () => undefined,
    candidateOfferings: () => [],
    accessPending: () => false,
    turnedOffProvider: () => undefined,
    ...fields,
  };
}

/** Exact offering evidence for tests whose subject is downstream of catalog discovery. */
export function testProviderEligibility(
  unavailable: ReadonlySet<AccessProviderId> = new Set(),
): AccessProviderModelEligibility {
  return testEligibility({
    modelIds: new Set(fakeModelInfos.keys()),
    profileId: "default",
    revision: 1,
    modelUnavailableReason: (provider) => unavailable.has(provider) ? `${provider} is unavailable.` : undefined,
    candidateOfferings: (candidate: AccessProviderCandidate, model: string): AccessProviderCandidateAttribution[] => {
      if (unavailable.has(candidate.providerId)) return [];
      const resolvedModelMetadata = fakeModelInfos.get(canonicalModelId(model));
      return [{
        candidate,
        wireModelId: model,
        dataUse: "standard",
        catalogProvenance: "static",
        ...(resolvedModelMetadata === undefined ? {} : { resolvedModelMetadata }),
        ...(candidate.providerId === "github_copilot"
          ? { transport: resolvedModelMetadata?.family === "anthropic" ? "anthropic-messages" : "openai-responses" }
          : {}),
      }];
    },
  });
}
