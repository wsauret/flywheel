import type { AccessProviderCandidateAttribution } from "../../../infra/llm/access-provider.js";
import type { RequestAdmission } from "./provider-availability-types.js";
import type { PreparedServingRequest } from "./types.js";
import type { ProviderConnection } from "../../../infra/auth/auth-context.js";

export type ProviderAffordabilityDecision =
  | { readonly kind: "eligible" }
  | { readonly kind: "unaffordable"; readonly detail: string };

export interface ProviderAffordabilityEvaluation {
  readonly attribution: AccessProviderCandidateAttribution;
  readonly admission: RequestAdmission;
  readonly request: PreparedServingRequest;
  readonly signal?: AbortSignal;
}

/** Provider-owned request admission over the real prepared attempt. Missing capabilities admit. */
export interface ProviderAffordabilityCapability {
  evaluate(input: ProviderAffordabilityEvaluation): Promise<ProviderAffordabilityDecision>;
}

/** Creates a lazy capability owned by one immutable provider connection and profile. */
export type ProviderAffordabilityFactory = (
  connection: ProviderConnection & { readonly profileId: string },
) => ProviderAffordabilityCapability | undefined;
