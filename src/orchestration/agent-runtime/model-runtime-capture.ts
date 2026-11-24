/**
 * The model-runtime capture contract: what a request captures of the model
 * runtime and of one account, and the client construction each capture
 * allows. The runtime factory implements it; the request owners below the
 * factory read it.
 */

import type { AccessProviderCandidate, AccessProviderModelEligibility, FailoverPlan } from "../../infra/llm/access/access-provider.js";
import type { RequestAdmission } from "./llm/provider-availability-types.js";
import type { ModelClient, ProviderSessionLifetime } from "./llm/types.js";
import type { EffectiveProviderConnection } from "./llm/client-factory.js";
import type { AccessProviderRegistry } from "./llm/access-provider-registry.js";
import type { AgentFactory } from "./types.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import type { RuntimeConfigRequestCapture } from "./request-config.js";
import type { SubscriptionAdmissionCapture } from "../subscription-spend-consent/admission-capture.js";

/** Builds a client of `model` whose provider resources `providerSessionLifetime` owns. An absent snapshot or
 *  configuration reads the runtime's current one. */
export type LLMClientFactory = (model: string, moduleSnapshot: FirstPartyModuleComposition | undefined, runtimeConfig: RuntimeConfigRequestCapture | undefined, providerSessionLifetime: ProviderSessionLifetime) => Promise<ModelClient>;

/** One request-time model runtime. Generation identity prevents a runner cache
 *  from reusing clients after the owning session publishes new model state. */
export interface ModelRuntimeCapture {
  readonly generation: WeakKey;
  readonly createLLMClient: LLMClientFactory;
  readonly captureProviderConnection?: CaptureProviderConnection;
}

export type CaptureModelRuntime = () => Promise<ModelRuntimeCapture>;

/** Runner and client construction bound to one admitted plan set: every client
 *  it builds comes from the plan its model was admitted with, and a model the
 *  set does not name is refused before any provider request. */
interface AdmittedRuntime {
  createAgent: AgentFactory;
  createLLMClient: LLMClientFactory;
}

/** One captured account plus the only construction that spends it. A child run
 *  plans its models against `connection` and admits those plans, so no step
 *  below the capture reads the credential store or the model cache again. */
export interface ProviderConnectionCapture {
  readonly connection: EffectiveProviderConnection;
  readonly providers: AccessProviderRegistry;
  readonly eligibility?: AccessProviderModelEligibility;
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  /** Plans keyed by the model id their caller will ask for. */
  admit(plans: ReadonlyMap<string, FailoverPlan>): AdmittedRuntime;
  /** This request's spend admission of `candidates`: allowance and consent, captured once per candidate list for the
   *  life of this capture, so every client that the capture admits reads the same evidence. */
  requestAdmission(candidates: readonly AccessProviderCandidate[]): Promise<RequestAdmission>;
}

export type CaptureProviderConnection = (runtimeConfig?: RuntimeConfigRequestCapture, moduleSnapshot?: FirstPartyModuleComposition) => Promise<ProviderConnectionCapture>;
/** Captures allowance and consent for one request: the candidates it plans, and the profile's authored provider settings every provider's allowance admission reads its own keys from. */
export type CaptureSubscriptionAdmission = (candidates: readonly AccessProviderCandidate[], providerSettings: RuntimeConfigRequestCapture["providerSettings"]) => Promise<SubscriptionAdmissionCapture>;
