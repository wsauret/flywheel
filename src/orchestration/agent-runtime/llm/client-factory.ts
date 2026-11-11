/**
 * LLM client factory.
 *
 * Routes to the exact access-provider adapter admitted by catalog eligibility.
 * Callers get an LLMClient without knowing whether the model is Anthropic,
 * OpenAI, or another supported family.
 *
 * Every client is a chain client from `failover-client.ts`: the
 * candidate order derives from the provider definitions, and the chain
 * resolves it against the account's quota state on every request.
 *
 * Account state is read once, at connection capture: the resolved AuthContext,
 * OAuth credentials, and each definition's opaque model context. Planning and
 * construction read only that capture, so a runner can hand its connection to
 * a child and have every client spend the same account without copying secrets.
 */

import { type AuthContext, captureProviderConnection, captureSubscriptionCredentials, type ProviderConnection, type RuntimeCredential } from "../../../infra/auth/auth-context.js";
import type { AuthStoreCondition } from "../../../infra/auth/auth-store.js";
import type { CredentialSlotClassifier } from "../../../infra/auth/auth-store-types.js";
import type { ProviderRequestOptions } from "../../../infra/llm/provider-options.js";
import type { ModelRefusal } from "../../../infra/auth/provider-model-catalog-store.js";
import type { NotificationEpisodeInput } from "../../../infra/notification-episode.js";
import { accessProviderCandidateKey, candidateProviderId, type AccessProviderCandidate, type AccessProviderCandidateAttribution, type AccessProviderId, type AccessProviderModelEligibility, type AdmittedFailoverPlan, type FailoverPlan, type LoginWaitAnswer } from "../../../infra/llm/access-provider.js";
import type { ModelFamily } from "../../../infra/llm/model-family.js";
import type { ProviderIdentity } from "../../../infra/llm/auth-error.js";
import type { ModelsClient } from "../../../infra/llm/models.js";
import { Log } from "../../../infra/log.js";
import { getSharedProviderAvailability } from "./shared-provider-availability.js";
import { createModelReminders } from "./runtime-reminders.js";
import type {
  ProviderAvailability,
  ProviderAvailabilityOwner,
  RequestAdmission,
} from "./provider-availability-types.js";
import { createFailoverClient, createRoutingDecisions } from "./failover-client.js";
import type { ProviderAffordabilityCapability } from "./provider-affordability.js";
import type { AdmittedModelRequest, AdmittedModelRequestPreparation, AdmittedModelRequestRun, LLMClient, ModelClient, PreparedCandidate, ProviderRequestAdmission, ProviderSessionLifetime, ServingAttempt, StagedProviderClient, StreamOptions } from "./types.js";
import { ApiError, fromStreamError, ModelUnavailable } from "../errors.js";

import type { AccessProviderRegistry } from "./access-provider-registry.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import { credentialSlotClassifier } from "../../auth/credential-slot-classifier.js";
const log = Log.create({ service: "llm-client-factory" });

export type EffectiveProviderConnection = ProviderConnection & { readonly profileId: string };



/** Everything a provider adapter is built from. The connection carries every
 *  credential and account directory the adapter needs, and the composition root
 *  selected the availability binding once, so no adapter resolves either for
 *  itself. */
export interface AccessProviderBuild {
  readonly candidate: AccessProviderCandidate;
  /** The candidate's provider as a person knows it, from its registered definition. */
  readonly providerIdentity: ProviderIdentity;
  readonly model: string;
  readonly wireModelId: string;
  readonly family: ModelFamily;
  readonly modelsClient: ModelsClient;
  readonly connection: ProviderConnection;
  readonly classifySlot: CredentialSlotClassifier;
  readonly availability: ProviderAvailability;
  readonly projectRoot: string;
  readonly attribution: AccessProviderCandidateAttribution;
  readonly tokenizerIdentity?: import("../../../infra/llm/model-id.js").ClaudeTokenizerIdentity;
  /** The owner of every resource that the client's connection holds beyond one request (`ProviderSessionLifetime`). */
  readonly providerSessionLifetime: ProviderSessionLifetime;
  /** Launch authority of the runtime generation the client serves. A provider
   *  that runs a local process launches it here, so the process ends with the
   *  generation; providers that make only network requests ignore it. */
  readonly launcher?: LauncherScope;
  /** Records a refusal of `wireModelId` by the candidate's account that the adapter answered itself, so the walk
   *  never saw it: the Agent SDK bridge resends a request whose extended window the account refused, and a shared
   *  agent host's coordinator finds a model that the account does not offer. It returns at once and never fails. */
  readonly recordModelRefusal: (wireModelId: string, refusal: ModelRefusal) => void;
  /** The offerings of every model that the request's eligibility admits for the candidate's account: the account's
   *  lineup without the models that it refused. Empty when the request captured no eligibility. It reads only the
   *  captured eligibility. */
  readonly accountOfferings: () => readonly AccessProviderCandidateAttribution[];
  /** The notify seam of the composition that the client serves (ARCH-STRUCTURE-034): a provider states here a
   *  condition of its account that the person must see, whichever request of the composition found it. It returns at
   *  once and never fails. */
  readonly notify: (episode: NotificationEpisodeInput) => void;
}

/** One refusal that a request proved: the account of `candidate`, on the credentials that `connection` captured,
 *  does not grant `wireModelId`, or grants it only within a narrower window. */
export interface ModelRefusalRecord {
  readonly connection: EffectiveProviderConnection;
  readonly candidate: AccessProviderCandidate;
  readonly wireModelId: string;
  readonly refusal: ModelRefusal;
}

/** Saves a refusal for the exact account generation and brings it to the model listing and to later requests.
 *  It returns at once and never fails; the owner contains a failed save. */
export type RecordModelRefusal = (record: ModelRefusalRecord) => void;

export type AccessProviderFactory = (build: AccessProviderBuild) => Promise<StagedProviderClient>;

/** Adds immutable request attribution to an adapter description and memoizes its connection. Concurrent and later
 *  connects share one construction and its client. A construction that fails is forgotten, so the next connect
 *  builds again on the state that the failure named (ARCH-PROVIDERS-036). */
export function stagedProviderClient(
  build: AccessProviderBuild,
  described: ServingAttempt,
  create: () => Promise<LLMClient>,
): StagedProviderClient {
  const attempt = Object.freeze({
    accessProvider: described.accessProvider,
    providerIdentity: build.providerIdentity,
    candidateAttribution: build.attribution,
    accessProviderCandidate: build.candidate,
    ...(build.attribution.catalogProvenance === undefined ? {} : { catalogProvenance: build.attribution.catalogProvenance }),
    credentialLineage: candidateCredentialLineage(build.connection, build.candidate),
    modelFamily: described.modelFamily,
    model: build.model,
    ...(build.tokenizerIdentity === undefined ? {} : { tokenizerIdentity: build.tokenizerIdentity }),
    toolPresentation: described.toolPresentation,
    // Every route states its model, the local date, and the environment; a Claude route words its model as the engine.
    // The model reminder names the wire model, as the adapter of a route names it in its history target, so a request
    // to the route reads it (`provider-history.ts`). A route whose adapter names another model states its own.
    messagesToAppend: described.messagesToAppend?.bind(described)
      ?? createModelReminders(build.wireModelId, described.totalContextLimit ?? described.contextLimit, build.attribution.resolvedModelMetadata),
    ...(described.requestEntries === undefined ? {} : { requestEntries: described.requestEntries.bind(described) }),
    contextLimit: described.contextLimit,
    ...(described.totalContextLimit === undefined ? {} : { totalContextLimit: described.totalContextLimit }),
    outputLimit: described.outputLimit,
    supportsReasoning: described.supportsReasoning,
    ...(described.sharedPromptPrefix === undefined ? {} : { sharedPromptPrefix: described.sharedPromptPrefix }),
    ...(described.anticipatesRequests === undefined ? {} : { anticipatesRequests: described.anticipatesRequests }),
    ...(described.availableModels === undefined ? {} : { availableModels: described.availableModels }),
    priceFor: described.priceFor.bind(described),
  } satisfies ServingAttempt);
  let connected: Promise<LLMClient> | undefined;
  return Object.freeze({
    attempt,
    connect() {
      if (connected !== undefined) return connected;
      const construction = create().then((client) => Object.freeze({
        ...attempt,
        streamWithTools: (options: StreamOptions) => client.streamWithTools(options),
        historyTarget: (options: StreamOptions) => client.historyTarget(options),
        ...(client.anticipate === undefined ? {} : { anticipate: client.anticipate.bind(client) }),
      }));
      connected = construction;
      void construction.catch(() => { if (connected === construction) connected = undefined; });
      return construction;
    },
  });
}

export interface AdmittedClientOptions {
  /** Enabled provider definitions and factories captured for this client. */
  providers: AccessProviderRegistry;
  /** The owner of the provider resources that the client's connections hold. A client can serve, so its creator
   *  owns them, also when it only plans. */
  providerSessionLifetime: ProviderSessionLifetime;
  /** Launch authority every provider build receives. */
  launcher?: LauncherScope;
  /** Eligibility captured before this client was admitted. */
  eligibility?: CapturedProviderModelEligibility;
  /** Captures eligibility when the caller has not supplied it explicitly. */
  getProviderModelEligibility?: () => CapturedProviderModelEligibility | undefined;
  /** Immutable profile policy captured for this provider request. */
  allowTrainingRoutes: boolean;
  /** Startup-selected project root (ARCH-DIRECTORIES-003). The ChatGPT transport writes its
   *  opted-in failed-request dump under it, so no adapter resolves a directory
   *  of its own. */
  projectRoot: string;
  /** Captures all profile-bound spend evidence once before lazy chain construction. */
  requestAdmission: (candidates: readonly AccessProviderCandidate[]) => Promise<RequestAdmission>;
  /** Overrides the process-local availability owner. Tests only. */
  availability?: ProviderAvailabilityOwner;
  /** Overrides the wait between the walk's in-place retries. Tests only. */
  retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Publishes strict credential-store refusals after their attempts settle. */
  observeAuthConditions?: (conditions: readonly AuthStoreCondition[]) => void;
  /** Receives every refusal of a model that a request of this client proved. */
  recordModelRefusal?: RecordModelRefusal;
  /** Interactive clients can wait for an external account's login before resending its request. */
  waitForLogin?: true;
  /** The composition's notify seam, which every provider build receives (`AccessProviderBuild.notify`). */
  notify: (episode: NotificationEpisodeInput) => void;
}

export interface CreateClientOptions extends AdmittedClientOptions {
  /** Effective credential directory for the active profile. */
  authDir: string;
  /** Stable identity of the profile that owns this capture. */
  profileId: string;
  /** Optional immutable account capture, used when consent and credentials must share one boundary. */
  connection?: EffectiveProviderConnection;
}

interface CapturedProviderModelEligibility extends AccessProviderModelEligibility {
  readonly profileId?: string;
  readonly revision?: number;
}

interface AdmittedRequestProfile {
  readonly candidateAttributions: readonly AccessProviderCandidateAttribution[];
}

/** Builds the client one plan admits. Errors keep the provider taxonomy
 *  (LlmStreamError kinds, ContextLengthExceededError, OutputLengthExceededError,
 *  ThinkingStallError) behind the AgentRuntimeError boundary for callers.
 *
 *  The plan and the connection are the whole input: membership was decided at
 *  planning, and every credential and compatibility fact was captured at
 *  connection capture, so nothing below reads a credential file or a model
 *  cache. A plan from another capture is refused rather than served on this
 *  account's credentials. A later run captures the connection, eligibility,
 *  and plan again, so each refusal here states the recovery `retry`. */
export async function createAdmittedClient(
  plan: FailoverPlan,
  modelsClient: ModelsClient,
  connection: EffectiveProviderConnection,
  options: AdmittedClientOptions,
): Promise<ModelClient> {
  if (plan.connectionId !== connection.id) {
    throw new ApiError({ message: `Provider chain plan for "${plan.model}" was planned against a different provider connection`, recovery: { kind: "retry" } });
  }
  if (plan.kind === "unavailable") throw new ModelUnavailable({ message: plan.reason, missing: plan.missing });
  validateConnectionBinding(plan, connection, options);
  return withRuntimeErrorBoundary(buildChainClient(plan, modelsClient, connection, options));
}

/** Confirms that a run plan can spend only the account and profile that admitted it. */
function validateConnectionBinding(
  plan: AdmittedFailoverPlan,
  connection: EffectiveProviderConnection,
  options: AdmittedClientOptions,
): void {
  if (plan.connectionId !== connection.id) {
    throw new ApiError({ message: `Provider chain plan for "${plan.model}" was planned against a different provider connection`, recovery: { kind: "retry" } });
  }
  const eligibility = options.eligibility;
  if (eligibility?.profileId !== undefined && eligibility.profileId !== connection.profileId) {
    throw new ApiError({ message: `Provider request profile "${eligibility.profileId}" does not match connection profile "${connection.profileId}"`, recovery: { kind: "retry" } });
  }
}

/** Applies current eligibility beneath the immutable candidate ceiling admitted for the run. */
function captureProviderRequestProfile(
  ceiling: AdmittedFailoverPlan,
  connection: EffectiveProviderConnection,
  options: AdmittedClientOptions,
  eligibility: CapturedProviderModelEligibility | undefined,
): AdmittedRequestProfile {
  if (eligibility?.profileId !== undefined && eligibility.profileId !== connection.profileId) {
    throw new ApiError({ message: `Provider request profile "${eligibility.profileId}" does not match connection profile "${connection.profileId}"`, recovery: { kind: "retry" } });
  }
  const planned = options.providers.selection.plan(ceiling.model, connection, eligibility, options.allowTrainingRoutes);
  if (planned.kind === "unavailable") throw new ModelUnavailable({ message: planned.reason, missing: planned.missing });
  const admittedKeys = new Set(ceiling.candidates.map(accessProviderCandidateKey));
  const candidateAttributions = planned.candidateAttributions.filter(({ candidate }) => admittedKeys.has(accessProviderCandidateKey(candidate)));
  if (candidateAttributions.length === 0) {
    throw new ApiError({ message: `No provider admitted for "${ceiling.model}" remains eligible for this request`, recovery: { kind: "retry" } });
  }
  return Object.freeze({
    candidateAttributions: Object.freeze(candidateAttributions),
  });
}

function buildChainClient(
  plan: AdmittedFailoverPlan,
  modelsClient: ModelsClient,
  connection: EffectiveProviderConnection,
  options: AdmittedClientOptions,
): ModelClient {
  const owner = options.availability ?? getSharedProviderAvailability();
  const adapterAvailability = owner.forCandidates(connection.profileId, plan.candidates);
  // Staged adapters live with this client, not with one admission: the client
  // is already held per composition, account generation, and routing key, and
  // every credential an adapter reads comes from the connection captured here,
  // so a later admission of the same exact wire reuses the SDK client and its
  // sockets. The key carries everything an admission bakes into the adapter.
  const adapters = new Map<string, Promise<StagedProviderClient>>();
  const routing = createRoutingDecisions();
  const treeLogin = options.providerSessionLifetime.treeLogin;
  const record = options.recordModelRefusal;
  const recordRefusal = (attribution: AccessProviderCandidateAttribution, refusal: ModelRefusal): void => {
    record?.({ connection, candidate: attribution.candidate, wireModelId: attribution.wireModelId, refusal });
  };
  const chain = (admission: ProviderRequestAdmission, eligibility: CapturedProviderModelEligibility | undefined): ModelClient => {
    const availability = owner.forCandidates(connection.profileId, plan.candidates);
    const affordability = new Map<AccessProviderId, ProviderAffordabilityCapability>();
    for (const [provider, create] of options.providers.affordability) {
      const capability = create(connection);
      if (capability !== undefined) affordability.set(provider, capability);
    }
    const build = (attribution: AccessProviderCandidateAttribution): Promise<StagedProviderClient> => {
      const candidate = attribution.candidate;
      const provider = candidateProviderId(candidate);
      const key = [
        accessProviderCandidateKey(candidate), attribution.wireModelId, attribution.transport ?? "", admission.tokenizerIdentity ?? "",
        attribution.catalogProvenance ?? "", attribution.eligibilityProfileId ?? "", String(attribution.eligibilityRevision ?? ""),
      ].join("\0");
      const existing = adapters.get(key);
      if (existing) return existing;
      const factory = options.providers.factories.get(provider);
      const definition = options.providers.selection.definitions.find((entry) => entry.id === provider);
      const built = factory && definition
        ? factory({
            candidate,
            attribution,
            providerIdentity: { name: definition.shortName, credential: definition.auth.kind === "api_key" ? "api_key" : "oauth" },
            ...(admission.tokenizerIdentity === undefined ? {} : { tokenizerIdentity: admission.tokenizerIdentity }),
            model: plan.model,
            wireModelId: attribution.wireModelId,
            family: plan.family,
            modelsClient,
            connection,
            classifySlot: credentialSlotClassifier(options.providers.composition),
            availability: adapterAvailability,
            projectRoot: options.projectRoot,
            providerSessionLifetime: options.providerSessionLifetime,
            ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
            recordModelRefusal: (wireModelId, refusal) => { record?.({ connection, candidate, wireModelId, refusal }); },
            accountOfferings: () => [...eligibility?.modelIds ?? []].flatMap((offered) => eligibility?.candidateOfferings?.(candidate, offered, options.allowTrainingRoutes) ?? []),
            notify: options.notify,
          })
        : Promise.reject(new Error(`Provider ${provider} is not enabled`));
      adapters.set(key, built);
      void built.catch(() => { if (adapters.get(key) === built) adapters.delete(key); });
      return built;
    };
    return createFailoverClient({
      model: plan.model,
      family: plan.family,
      candidateAttributions: admission.candidateAttributions,
      ...(treeLogin === undefined ? {} : { preferredAccount: treeLogin }),
      shortName: options.providers.selection.shortName,
      build,
      affordability,
      requestAdmission: admission,
      availability,
      credentialLineage: (candidate) => candidateCredentialLineage(connection, candidate),
      conditions: connection.auth.conditions,
      ...(options.observeAuthConditions === undefined ? {} : { observeAuthConditions: options.observeAuthConditions }),
      recordModelRefusal: recordRefusal,
      ...(options.waitForLogin === true ? {
        awaitLogin: async (candidate: AccessProviderCandidate, signal: AbortSignal): Promise<LoginWaitAnswer> => {
          const definition = options.providers.selection.definitions.find((entry) => entry.id === candidate.providerId);
          return candidate.kind === "subscription" && definition?.auth.kind === "external"
            ? definition.auth.awaitLogin(connection.authDir, candidate.instanceId, signal)
            : "declined";
        },
      } : {}),
      ...(options.retrySleep === undefined ? {} : { sleep: options.retrySleep }),
      ...(admission.subscriptionAllowanceFor === undefined ? {} : { subscriptionAllowanceFor: admission.subscriptionAllowanceFor }),
      subscriptionSpendAuthorizationFor: admission.subscriptionSpendAuthorizationFor,
      routing,
    });
  };
  const admitRequest = async (eligibility: CapturedProviderModelEligibility | undefined): Promise<ProviderRequestAdmission> => {
    const profile = captureProviderRequestProfile(plan, connection, options, eligibility);
    const policy = await options.requestAdmission(profile.candidateAttributions.map((attribution) => attribution.candidate));
    const tokenizerIdentity = modelsClient.getTokenizerIdentity(plan.model);
    return Object.freeze({
      candidateAttributions: profile.candidateAttributions,
      ...(tokenizerIdentity === undefined ? {} : { tokenizerIdentity }),
      subscriptionSpendAuthorizationFor: policy.subscriptionSpendAuthorizationFor,
      ...(policy.subscriptionAllowanceFor === undefined ? {} : { subscriptionAllowanceFor: policy.subscriptionAllowanceFor }),
      ...(policy.bankedResetFor === undefined ? {} : { bankedResetFor: policy.bankedResetFor }),
      ...(policy.expiringResetFor === undefined ? {} : { expiringResetFor: policy.expiringResetFor }),
    });
  };
  const admittedRequest = async (diagnostic: boolean): Promise<AdmittedModelRequest> => {
    const eligibility = options.eligibility ?? options.getProviderModelEligibility?.();
    const admission = await admitRequest(eligibility);
    const admitted = await chain(admission, eligibility).admitRequest();
    if (diagnostic) {
      // Per request, so DEBUG: model.requested names the provider and model,
      // and the chain records a reroute or a refusal on its own.
      log.debug("provider request admitted", {
        model: plan.model,
        family: plan.family,
        candidates: admitted.candidateAttributions.map(({ candidate }) => candidateProviderId(candidate)),
      });
    }
    return admitted;
  };
  return {
    model: plan.model,
    modelFamily: plan.family,
    admitRequest() {
      return admittedRequest(true);
    },
    async plannedAttempt(providerOptions) {
      return (await admittedRequest(false)).plannedAttempt(providerOptions);
    },
  };
}



/** The credential lineage that `candidate` spends on `connection`: a subscription account's instance, or the lineage of the stored provider key. */
export function candidateCredentialLineage(connection: ProviderConnection, candidate: AccessProviderCandidate): string | undefined {
  return candidate.kind === "subscription" ? candidate.instanceId : connection.auth.credentialLineages?.[candidate.providerId];
}

export function credentialForCandidate(connection: ProviderConnection, candidate: AccessProviderCandidate): RuntimeCredential | undefined {
  if (candidate.kind !== "subscription") return undefined;
  return connection.subscriptionCredentials.get(candidate.providerId)?.find((entry) => entry.instanceId === candidate.instanceId)?.credential;
}


/** Captures the account credentials used by planning and client construction. */
export function captureAccountConnection(
  profileAuth: AuthContext,
  authDir: string,
  providers: AccessProviderRegistry,
  profileId: string,
): EffectiveProviderConnection {
  // Subscription credentials are captured for every installed definition, not
  // just configured ones: an API-key subscription plan (opencode_go) has no
  // singleton key, so its stored instances are the only sign it is
  // connected. Provider-chain planning admits it from this capture.
  const subscriptionCredentials = profileAuth.subscriptionCredentials ?? captureSubscriptionCredentials(providers.selection.definitions, { kind: "persisted", authDir, classifySlot: credentialSlotClassifier(providers.composition) });
  const auth = Object.freeze({ ...profileAuth, conditions: Object.freeze([...(profileAuth.conditions ?? [])]) });
  return captureProviderConnection({ profileId, authDir, auth, subscriptionCredentials });
}

/** Captures the account, then plans and builds one client on it. This is the
 *  ordinary entry point for a caller that holds no capture of its own. */
export async function createClient(
  model: string,
  modelsClient: ModelsClient,
  auth: AuthContext,
  options: CreateClientOptions,
): Promise<ModelClient> {
  const connection = options.connection ?? captureAccountConnection(auth, options.authDir, options.providers, options.profileId);
  const eligibility = options.eligibility ?? options.getProviderModelEligibility?.();
  const basePlan = options.providers.selection.plan(model, connection, eligibility, options.allowTrainingRoutes);
  if (basePlan.kind === "unavailable") throw new ModelUnavailable({ message: basePlan.reason, missing: basePlan.missing });
  return withRuntimeErrorBoundary(buildChainClient(basePlan, modelsClient, connection, options));
}

function withRuntimeErrorBoundary(client: ModelClient): ModelClient {
  return {
    get model() { return client.model; },
    get modelFamily() { return client.modelFamily; },
    async admitRequest() {
      const admitted = await client.admitRequest();
      return Object.freeze({
        candidateAttributions: admitted.candidateAttributions,
        async run<T>(request: AdmittedModelRequestRun<T>): Promise<T> {
          try {
            return await admitted.run<T>(request);
          } catch (error) {
            throw fromStreamError(error);
          }
        },
        async prepare(request: AdmittedModelRequestPreparation): Promise<PreparedCandidate> {
          try {
            return await admitted.prepare(request);
          } catch (error) {
            throw fromStreamError(error);
          }
        },
        plannedAttempt: admitted.plannedAttempt,
      });
    },
    plannedAttempt(providerOptions?: ProviderRequestOptions): ReturnType<ModelClient["plannedAttempt"]> { return client.plannedAttempt(providerOptions); },
  };
}
