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
import type { AdmittedModelRequest, AdmittedModelRequestPreparation, AdmittedModelRequestRun, AdapterAdmission, LLMClient, ModelClient, ModelRequestCapture, PreparedCandidate, ProviderAdapter, ProviderRequestAdmission, ProviderSessionLifetime, ServingAttempt, StagedProviderClient, StreamOptions } from "./types.js";
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
  /** The candidate's attribution in the admission that built the adapter. The transport reads its wire facts and the
   *  model metadata that it opens with; each request stages and binds its own attribution (`ProviderAdapter.stage`). */
  readonly attribution: AccessProviderCandidateAttribution;
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

export type AccessProviderFactory = (build: AccessProviderBuild) => Promise<ProviderAdapter>;

/** The adapter of a provider whose transport `open` opens, such as an SDK client and its sockets or a Claude engine
 *  and its host. A provider states its protocol mapping in two parts, both read from one request's admission:
 *  `describe` states the request's attempt from the candidate's attribution under the request's eligibility, so its
 *  model metadata and limits are the request's own, and the adapter adds the request's attribution and tokenizer;
 *  `bind` returns the client that lowers the request on the open transport with the same admission, so what the
 *  request sends on the wire, its limits, capabilities, and headers, follows its own eligibility too
 *  (ARCH-PROVIDERS-023). The first connect of any request opens the transport, and every later connect shares it and
 *  never changes it. A construction that fails is forgotten, so the next connect builds again on the state that the
 *  failure named (ARCH-PROVIDERS-036). */
export function providerAdapter<Transport>(
  build: AccessProviderBuild,
  describe: (attribution: AccessProviderCandidateAttribution) => ServingAttempt | Promise<ServingAttempt>,
  open: () => Promise<Transport>,
  bind: (transport: Transport, admission: AdapterAdmission) => LLMClient | Promise<LLMClient>,
): ProviderAdapter {
  let transport: Promise<Transport> | undefined;
  const connect = (): Promise<Transport> => {
    if (transport !== undefined) return transport;
    const construction = open();
    transport = construction;
    void construction.catch(() => { if (transport === construction) transport = undefined; });
    return construction;
  };
  return Object.freeze({
    async stage(admission: AdapterAdmission): Promise<StagedProviderClient> {
      const { attribution, tokenizerIdentity } = admission;
      const described = await describe(attribution);
      const attempt = Object.freeze({
        accessProvider: described.accessProvider,
        providerIdentity: build.providerIdentity,
        candidateAttribution: attribution,
        accessProviderCandidate: build.candidate,
        ...(attribution.catalogProvenance === undefined ? {} : { catalogProvenance: attribution.catalogProvenance }),
        credentialLineage: candidateCredentialLineage(build.connection, build.candidate),
        modelFamily: described.modelFamily,
        model: build.model,
        ...(tokenizerIdentity === undefined ? {} : { tokenizerIdentity }),
        toolPresentation: described.toolPresentation,
        // Every route states its model, the local date, and the environment; a Claude route words its model as the engine.
        // The model reminder names the wire model, as the adapter of a route names it in its history target, so a request
        // to the route reads it (`provider-history.ts`). A route whose adapter names another model states its own.
        messagesToAppend: described.messagesToAppend?.bind(described)
          ?? createModelReminders(build.wireModelId, described.totalContextLimit ?? described.contextLimit, attribution.resolvedModelMetadata),
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
      return Object.freeze({
        attempt,
        async connect() {
          const client = await bind(await connect(), admission);
          return Object.freeze({
            ...attempt,
            streamWithTools: (options: StreamOptions) => client.streamWithTools(options),
            historyTarget: (options: StreamOptions) => client.historyTarget(options),
            ...(client.anticipate === undefined ? {} : { anticipate: client.anticipate.bind(client) }),
          });
        },
      });
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
  /** The training-route permission that a request reads when it states no capture of its own
   *  (`ModelRequestCapture`). */
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

/** The routing policy of one request (`ModelRequestCapture`), with its eligibility resolved. */
interface RequestCapture {
  readonly eligibility: CapturedProviderModelEligibility | undefined;
  readonly allowTrainingRoutes: boolean;
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

/** Plans the candidates of one request for `model` on the client's connection under the request's own eligibility and
 *  training-route permission. The plan that built the client bounds nothing: the client outlives a publication that
 *  adds or removes a candidate (ARCH-PROVIDERS-070), and each request's capture alone governs its candidates
 *  (ARCH-PROVIDERS-023). */
function captureProviderRequestProfile(
  model: string,
  connection: EffectiveProviderConnection,
  options: AdmittedClientOptions,
  { eligibility, allowTrainingRoutes }: RequestCapture,
): AdmittedRequestProfile {
  if (eligibility?.profileId !== undefined && eligibility.profileId !== connection.profileId) {
    throw new ApiError({ message: `Provider request profile "${eligibility.profileId}" does not match connection profile "${connection.profileId}"`, recovery: { kind: "retry" } });
  }
  const planned = options.providers.selection.plan(model, connection, eligibility, allowTrainingRoutes);
  if (planned.kind === "unavailable") throw new ModelUnavailable({ message: planned.reason, missing: planned.missing });
  return Object.freeze({ candidateAttributions: planned.candidateAttributions });
}

function buildChainClient(
  plan: AdmittedFailoverPlan,
  modelsClient: ModelsClient,
  connection: EffectiveProviderConnection,
  options: AdmittedClientOptions,
): ModelClient {
  const owner = options.availability ?? getSharedProviderAvailability();
  // Adapters live with this client, not with one admission: the client is held per composition, serving selection,
  // and credentials, and every credential an adapter reads comes from the connection captured here, so a later
  // admission of the same wire reuses the adapter's transport, such as an SDK client and its sockets or a hosted
  // Claude agent. The key is the candidate's wire alone. A publication of eligibility, such as a move of the catalog
  // from cached to live rows, a narrowed context window, or a fallback that leaves the plan, keeps each transport
  // serving (ARCH-PROVIDERS-070): an adapter of a candidate that no request plans stays unused. Each request stages
  // and binds its attempt from its own admission (ARCH-PROVIDERS-023).
  const adapters = new Map<string, Promise<ProviderAdapter>>();
  const routing = createRoutingDecisions();
  const treeLogin = options.providerSessionLifetime.treeLogin;
  const record = options.recordModelRefusal;
  const recordRefusal = (attribution: AccessProviderCandidateAttribution, refusal: ModelRefusal): void => {
    record?.({ connection, candidate: attribution.candidate, wireModelId: attribution.wireModelId, refusal });
  };
  const adapterFor = (attribution: AccessProviderCandidateAttribution): Promise<ProviderAdapter> => {
    const candidate = attribution.candidate;
    const provider = candidateProviderId(candidate);
    const key = [accessProviderCandidateKey(candidate), attribution.wireModelId, attribution.transport ?? ""].join("\0");
    const existing = adapters.get(key);
    if (existing) return existing;
    const factory = options.providers.factories.get(provider);
    const definition = options.providers.selection.definitions.find((entry) => entry.id === provider);
    const built = factory && definition
      ? factory({
          candidate,
          attribution,
          providerIdentity: { name: definition.shortName, credential: definition.auth.kind === "api_key" ? "api_key" : "oauth" },
          model: plan.model,
          wireModelId: attribution.wireModelId,
          family: plan.family,
          modelsClient,
          connection,
          classifySlot: credentialSlotClassifier(options.providers.composition),
          availability: owner.forCandidates(connection.profileId, [candidate]),
          projectRoot: options.projectRoot,
          providerSessionLifetime: options.providerSessionLifetime,
          ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
          recordModelRefusal: (wireModelId, refusal) => { record?.({ connection, candidate, wireModelId, refusal }); },
          notify: options.notify,
        })
      : Promise.reject(new Error(`Provider ${provider} is not enabled`));
    adapters.set(key, built);
    void built.catch(() => { if (adapters.get(key) === built) adapters.delete(key); });
    return built;
  };
  const chain = (admission: ProviderRequestAdmission, { eligibility, allowTrainingRoutes }: RequestCapture): ModelClient => {
    const availability = owner.forCandidates(connection.profileId, admission.candidateAttributions.map(({ candidate }) => candidate));
    const affordability = new Map<AccessProviderId, ProviderAffordabilityCapability>();
    for (const [provider, create] of options.providers.affordability) {
      const capability = create(connection);
      if (capability !== undefined) affordability.set(provider, capability);
    }
    const build = async (attribution: AccessProviderCandidateAttribution): Promise<StagedProviderClient> => (await adapterFor(attribution)).stage({
      attribution,
      ...(admission.tokenizerIdentity === undefined ? {} : { tokenizerIdentity: admission.tokenizerIdentity }),
      // The account's lineup under this request's eligibility and permission, without the models that it refused.
      accountOfferings: [...eligibility?.modelIds ?? []].flatMap((offered) => eligibility?.candidateOfferings?.(attribution.candidate, offered, allowTrainingRoutes) ?? []),
    });
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
  const admitRequest = async (capture: RequestCapture): Promise<ProviderRequestAdmission> => {
    const profile = captureProviderRequestProfile(plan.model, connection, options, capture);
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
  const admittedRequest = async (diagnostic: boolean, requested: ModelRequestCapture | undefined): Promise<AdmittedModelRequest> => {
    const capture: RequestCapture = {
      eligibility: requested?.eligibility ?? options.eligibility ?? options.getProviderModelEligibility?.(),
      allowTrainingRoutes: requested?.allowTrainingRoutes ?? options.allowTrainingRoutes,
    };
    const admission = await admitRequest(capture);
    const admitted = await chain(admission, capture).admitRequest();
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
    admitRequest(capture) {
      return admittedRequest(true, capture);
    },
    async plannedAttempt(providerOptions, capture) {
      return (await admittedRequest(false, capture)).plannedAttempt(providerOptions);
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
    async admitRequest(capture?: ModelRequestCapture) {
      const admitted = await client.admitRequest(capture);
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
    plannedAttempt(providerOptions?: ProviderRequestOptions, capture?: ModelRequestCapture): ReturnType<ModelClient["plannedAttempt"]> { return client.plannedAttempt(providerOptions, capture); },
  };
}
