import type { AuthContext, ProviderConnection } from "../../infra/auth/auth-context.js";
import { accessProviderAccountKey, type AccessProviderCandidate, type AccessProviderModelEligibility, type AdmittedFailoverPlan, type FailoverPlan } from "../../infra/llm/access-provider.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { RequestAdmission } from "./llm/provider-availability-types.js";
import type { ModelClient, ProviderSessionLifetime } from "./llm/types.js";
import type { ModelsClient } from "../../infra/llm/models.js";
import { getSharedModelsClient } from "../config/llm-clients.js";
import { candidateCredentialLineage, captureAccountConnection, createAdmittedClient, createClient, type AdmittedClientOptions, type CreateClientOptions, type EffectiveProviderConnection } from "./llm/client-factory.js";
import { modelStanding, type ModelStanding } from "./llm/model-standing.js";
import { getSharedProviderAvailability } from "./llm/shared-provider-availability.js";
import { LiveAgent } from "./runner.js";
import { planCapabilitiesOfRun, prepareRunRequest, type CapabilityPlanner, type RequestPreparer } from "./request-preparation.js";
import type { AgentFactory, AgentOptions, RunnableAgentOptions, RuntimeToolSurfaces } from "./types.js";
import type { ModuleServices } from "../../infra/module-service.js";
import type { EnvCaptureResolver } from "../../infra/env-detection.js";
import type { LauncherScope } from "../../infra/process-supervisor.js";
import type { CommandHandoverAuthority } from "./command-handover.js";
import type { PersistentProcessClient } from "../../infra/persistent-process-manager.js";
import type { BridgedPersistentProcessClient } from "../../infra/persistent-process-bridge.js";
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js";
import { createBreadcrumbMaintenance } from "../session/session-artifacts.js";
import { createWebSearch } from "./web-search/select.js";
import type { WebSearchProviderId } from "./web-search/types.js";
import { createWebSearchProviderResolver, type FirstPartyModuleComposition, type FirstPartyModuleSnapshot } from "../modules.js";
import type { CaptureRuntimeConfig, RuntimeConfigRequestCapture } from "./request-config.js";
import type { StreamingEditValidationService } from "./tools/streaming-edit-validation.js";
import { requestAdmissionFromCaptures, type SubscriptionAdmissionCapture } from "../subscription-spend-consent/admission-capture.js";
import type { AuthConditionOwner } from "../auth/auth-condition-owner.js";
import type { UsageAuthorityGeneration } from "./usage-settlement.js";
import { accessProviderRegistry } from "./llm/access-provider-registry.js";

type ModulesInput = FirstPartyModuleComposition | FirstPartyModuleSnapshot;
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
  readonly providers: ReturnType<typeof accessProviderRegistry>;
  readonly eligibility?: AccessProviderModelEligibility;
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  /** Plans keyed by the model id their caller will ask for. */
  admit(plans: ReadonlyMap<string, FailoverPlan>): AdmittedRuntime;
  /** This request's spend admission of `candidates`: allowance and consent, captured once per candidate list for the
   *  life of this capture, so the role's standing and the selected client's admission read the same evidence. */
  requestAdmission(candidates: readonly AccessProviderCandidate[]): Promise<RequestAdmission>;
  /** Whether `plan`'s model can serve an agent's request now under `providerOptions`, read from the shared
   *  availability and this capture's spend admission by the walk's readiness rule. It claims no probe and builds no
   *  adapter (ARCH-PROVIDERS-080). */
  standing(plan: AdmittedFailoverPlan, providerOptions: ProviderRequestOptions | undefined): Promise<ModelStanding>;
}

export type CaptureProviderConnection = (runtimeConfig?: RuntimeConfigRequestCapture, moduleSnapshot?: FirstPartyModuleComposition) => Promise<ProviderConnectionCapture>;
/** Captures allowance and consent for one request: the candidates it plans, and the profile's authored provider settings every provider's allowance admission reads its own keys from. */
export type CaptureSubscriptionAdmission = (candidates: readonly AccessProviderCandidate[], providerSettings: RuntimeConfigRequestCapture["providerSettings"]) => Promise<SubscriptionAdmissionCapture>;


interface GenerationRuntimeToolSurfaces {
  moduleServices?: ModuleServices;
  webSearch?: RuntimeToolSurfaces["webSearch"];
  launcher?: LauncherScope;
  commandHandover?: CommandHandoverAuthority;
  persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient;
  allowPersistentProcesses?: () => boolean | Promise<boolean>;
  enforcedShellWriteGuard?: RuntimeToolSurfaces["enforcedShellWriteGuard"];
  gitAiAttribution?: RuntimeToolSurfaces["gitAiAttribution"];
  streamingEditValidation?: StreamingEditValidationService;
  /** Runtime authority for current auth storage conditions and settled mutation refusals. */
  authConditions?: Pick<AuthConditionOwner, "snapshot" | "observeMutation">;
  headless?: true;
}

/** Completes runner-local surfaces with the authorities pinned to one runtime
 *  generation. Every runner-local surface passes through as the host set it,
 *  so a surface added later, such as a workflow attempt's child-skill grant,
 *  cannot be lost here; a generation authority replaces a local one. */
export function completeRuntimeToolSurfaces(
  local: RuntimeToolSurfaces,
  generation: GenerationRuntimeToolSurfaces,
): RuntimeToolSurfaces {
  return {
    ...local,
    ...(generation.moduleServices ? { moduleServices: generation.moduleServices } : {}),
    ...(generation.webSearch ? { webSearch: generation.webSearch } : {}),
    ...(generation.launcher ? { launcher: generation.launcher } : {}),
    ...(generation.commandHandover ? { commandHandover: generation.commandHandover } : {}),
    ...(generation.persistentProcesses ? { persistentProcesses: generation.persistentProcesses } : {}),
    ...(generation.allowPersistentProcesses ? { allowPersistentProcesses: generation.allowPersistentProcesses } : {}),
    ...(generation.enforcedShellWriteGuard ? { enforcedShellWriteGuard: generation.enforcedShellWriteGuard } : {}),
    ...(generation.gitAiAttribution ? { gitAiAttribution: generation.gitAiAttribution } : {}),
    ...(generation.streamingEditValidation ? { streamingEditValidation: generation.streamingEditValidation } : {}),
    ...(generation.headless ? { headless: true } : {}),
  };
}

/** Shared dependencies for runner construction. The runner factory and the
 *  standalone client factory close over the same auth + modelsClient so that
 *  callers outside the agent loop (e.g. manual compaction) hit the same
 *  models cache and credential surface. */
export function createAgentRuntime(deps: {
  getAuth: () => AuthContext;
  /** The project's definition owner. Every runner this factory builds composes
   *  its briefs, workflow summaries, and skill revisions from it. */
  definitions: ProjectDefinitionRegistry;
  /** Live realm composition, or one immutable composition for an admitted realm. */
  moduleSelection: ModulesInput;
  /** Returns the current effective credential directory without I/O. */
  authDirectory: () => string;
  /** Stable profile identity captured with this runtime's credential directory. */
  profileId: string;
  /** Complete in-memory account capture. Absence selects the active profile. */
  connection?: EffectiveProviderConnection;
  /** Startup-selected user data root (ARCH-DIRECTORIES-002), the models.dev snapshot's home. */
  userDataRoot: string;
  modelsClient?: ModelsClient;
  moduleServices?: ModuleServices;
  /** Launch authority of the runtime generation this factory serves. Every
   *  runner it builds hands it to its tools, so a tool's process ends with the
   *  generation rather than with the process. */
  launcher?: LauncherScope;
  /** The executor's command handover, which every child a runner of this
   *  factory dispatches inherits for its own background owner. */
  commandHandover?: CommandHandoverAuthority;
  persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient;
  allowPersistentProcesses?: () => boolean | Promise<boolean>;
  enforcedShellWriteGuard?: RuntimeToolSurfaces["enforcedShellWriteGuard"];
  /** Resolves the `<env>` block every runner this factory builds carries, so
   *  one generation probes its environment once. */
  resolveEnvSnapshot?: EnvCaptureResolver;
  /** Current immutable profile-bound provider-model eligibility. */
  getProviderModelEligibility?: AdmittedClientOptions["getProviderModelEligibility"];
  captureModelAccess?: () => Promise<{ readonly worker: AccessProviderModelEligibility; readonly auth?: AuthContext }>;
  /** Synchronous immutable policy capture used at each request admission. */
  captureRuntimeConfig: CaptureRuntimeConfig;
  /** Captures allowance and profile-bound consent together for each provider request. */
  captureSubscriptionAdmission?: CaptureSubscriptionAdmission;
  acquireUsageSettlementAuthority?: (profile: { readonly profileDir: string; readonly profileId: string }) => Promise<import("./usage-settlement.js").UsageSettlementAuthorityLease>;
  usageAuthority?: UsageAuthorityGeneration;
  gitAiAttribution?: RuntimeToolSurfaces["gitAiAttribution"];
  streamingEditValidation?: StreamingEditValidationService;
  authConditions?: Pick<AuthConditionOwner, "snapshot" | "observeMutation">;
  /** Receives every refusal of a model that a request of this runtime proved. */
  recordModelRefusal?: AdmittedClientOptions["recordModelRefusal"];
  /** The composition's notify seam, which every provider client of this runtime receives (`AccessProviderBuild.notify`). */
  notify: AdmittedClientOptions["notify"];
  /** Enables account login waiting only for an interactive executor. */
  waitForLogin?: true;
  /** No client reviews this runtime's file changes (`RuntimeToolSurfaces.headless`). */
  headless?: true;
  /** The profile's wait for its model discovery to settle, which every runner this factory builds carries. */
  awaitModelAccessSettled: (signal: AbortSignal) => Promise<void>;
}) {
  const modelsClient = deps.modelsClient ?? getSharedModelsClient(deps.userDataRoot);
  const breadcrumbMaintenance = createBreadcrumbMaintenance(deps.definitions.projectRoot);
  const moduleSelection: FirstPartyModuleSnapshot = typeof deps.moduleSelection === "function"
    ? deps.moduleSelection
    : (() => {
        const composition = deps.moduleSelection;
        return () => composition;
      })();
  const accountAuth = (): AuthContext => deps.connection?.auth ?? deps.getAuth();
  const webSearchFor = (connection?: ProviderConnection) => {
    const resolveWebSearchProviders = createWebSearchProviderResolver({
      authDir: connection?.authDir ?? deps.authDirectory(),
      getAuth: accountAuth,
      ...(connection ? { connection } : {}),
    });
    return (moduleSnapshot: FirstPartyModuleComposition, preference: WebSearchProviderId) => createWebSearch({
      providers: resolveWebSearchProviders(moduleSnapshot),
      preference,
    });
  };
  const webSearch = webSearchFor(deps.connection);
  const generationSurfaces: GenerationRuntimeToolSurfaces = {
    ...(deps.moduleServices ? { moduleServices: deps.moduleServices } : {}),
    webSearch,
    ...(deps.launcher ? { launcher: deps.launcher } : {}),
    ...(deps.commandHandover ? { commandHandover: deps.commandHandover } : {}),
    ...(deps.persistentProcesses ? { persistentProcesses: deps.persistentProcesses } : {}),
    ...(deps.allowPersistentProcesses ? { allowPersistentProcesses: deps.allowPersistentProcesses } : {}),
    ...(deps.enforcedShellWriteGuard ? { enforcedShellWriteGuard: deps.enforcedShellWriteGuard } : {}),
    ...(deps.gitAiAttribution ? { gitAiAttribution: deps.gitAiAttribution } : {}),
    ...(deps.streamingEditValidation ? { streamingEditValidation: deps.streamingEditValidation } : {}),
    ...(deps.headless ? { headless: true } : {}),
  };
  const requestAdmission = (connection: EffectiveProviderConnection, runtimeConfig: RuntimeConfigRequestCapture): AdmittedClientOptions["requestAdmission"] => {
    return async (candidates) => {
      const capture = await deps.captureSubscriptionAdmission?.(candidates, runtimeConfig.providerSettings);
      return requestAdmissionFromCaptures(capture, connection);
    };
  };
  // The definition owner names the project this runtime serves, so every client
  // it builds writes provider diagnostics under that root and never resolves one.
  const admittedClientOptions = (providers: ReturnType<typeof accessProviderRegistry>, connection: EffectiveProviderConnection, runtimeConfig: RuntimeConfigRequestCapture, eligibility: AdmittedClientOptions["eligibility"], providerSessionLifetime: AdmittedClientOptions["providerSessionLifetime"]): AdmittedClientOptions => {
    const admission = requestAdmission(connection, runtimeConfig);
    return {
      providers,
      projectRoot: deps.definitions.projectRoot,
      requestAdmission: admission,
      allowTrainingRoutes: runtimeConfig.allowTrainingRoutes,
      providerSessionLifetime,
      notify: deps.notify,
      ...(deps.launcher === undefined ? {} : { launcher: deps.launcher }),
      ...(deps.authConditions === undefined ? {} : { observeAuthConditions: deps.authConditions.observeMutation }),
      ...(deps.recordModelRefusal === undefined ? {} : { recordModelRefusal: deps.recordModelRefusal }),
      ...(deps.waitForLogin === undefined ? {} : { waitForLogin: deps.waitForLogin }),
      ...(eligibility === undefined ? {} : { eligibility }),
    };
  };
  const clientOptions = (moduleSnapshot: FirstPartyModuleComposition, runtimeConfig: RuntimeConfigRequestCapture, connection: EffectiveProviderConnection, providerSessionLifetime: AdmittedClientOptions["providerSessionLifetime"]): CreateClientOptions => ({
    ...admittedClientOptions(accessProviderRegistry(moduleSnapshot), connection, runtimeConfig, undefined, providerSessionLifetime),
    authDir: connection.authDir,
    profileId: connection.profileId,
    getProviderModelEligibility: deps.getProviderModelEligibility,
  });
  const usageAuthority = deps.usageAuthority
  const profileId = usageAuthority?.profileId
  const acquireUsageSettlementAuthority = deps.acquireUsageSettlementAuthority
  const usageProfile: AgentOptions["usageProfile"] = usageAuthority === undefined || profileId === undefined || acquireUsageSettlementAuthority === undefined ? undefined : {
        profileId,
        authorityIncarnation: usageAuthority.authorityIncarnation,
        acquireAuthority: async (requestedProfileId: string) => {
          if (requestedProfileId !== profileId) throw new Error(`Usage settlement profile mismatch: expected ${profileId}, received ${requestedProfileId}`)
          const lease = await acquireUsageSettlementAuthority({ profileDir: deps.authDirectory(), profileId: requestedProfileId })
          if (lease.profileId !== profileId) {
            await lease.release()
            throw new Error(`Usage authority profile mismatch: expected ${profileId}, received ${lease.profileId}`)
          }
          if (lease.authorityIncarnation !== usageAuthority.authorityIncarnation) {
            await lease.release()
            throw new Error(`Usage authority incarnation changed for profile ${profileId}`)
          }
          return lease
        },
      }
  /** A caller's own module selection wins; `fallbackSelection` serves a caller
   *  that names none. */
  const hostedOptions = (
    options: AgentOptions,
    auth: AuthContext,
    surfaces: GenerationRuntimeToolSurfaces = generationSurfaces,
    fallbackSelection: FirstPartyModuleSnapshot = moduleSelection,
  ): RunnableAgentOptions => {
    return {
      ...options,
      auth,
      runtimeSurfaces: completeRuntimeToolSurfaces(options.runtimeSurfaces ?? {}, surfaces),
      resolveEnvSnapshot: options.resolveEnvSnapshot ?? deps.resolveEnvSnapshot,
      moduleSelection: options.moduleSelection ?? fallbackSelection,
      captureRuntimeConfig: deps.captureRuntimeConfig,
      awaitModelAccessSettled: deps.awaitModelAccessSettled,
      ...(usageProfile ? { usageProfile } : {}),
    }
  }
  const createLLMClient: LLMClientFactory = async (model, requestedSnapshot, requestedConfig, providerSessionLifetime) => {
    const moduleSnapshot = requestedSnapshot ?? moduleSelection();
    const runtimeConfig = requestedConfig ?? deps.captureRuntimeConfig();
    const auth = deps.connection?.auth ?? accountAuth();
    const providers = accessProviderRegistry(moduleSnapshot);
    const connection = deps.connection ?? captureAccountConnection(auth, deps.authDirectory(), providers, deps.profileId);
    if (!deps.connection) return createClient(model, modelsClient, auth, {
      ...clientOptions(moduleSnapshot, runtimeConfig, connection, providerSessionLifetime),
      connection,
      eligibility: deps.getProviderModelEligibility?.(),
    });
    const eligibility = deps.getProviderModelEligibility?.();
    const plan = providers.selection.plan(model, connection, eligibility, runtimeConfig.allowTrainingRoutes);
    return createAdmittedClient(plan, modelsClient, connection, admittedClientOptions(providers, connection, runtimeConfig, eligibility, providerSessionLifetime));
  };
  const captureProviderConnection: CaptureProviderConnection = async (requestedConfig, moduleSnapshot = moduleSelection()) => {
    const access = await deps.captureModelAccess?.();
    const runtimeConfig = requestedConfig?.profileId === deps.profileId ? requestedConfig : deps.captureRuntimeConfig();
    const providers = accessProviderRegistry(moduleSnapshot);
    const connection = deps.connection ?? captureAccountConnection(access?.auth ?? accountAuth(), deps.authDirectory(), providers, deps.profileId);
    const eligibility = access?.worker ?? deps.getProviderModelEligibility?.();
    const admissions = new Map<string, Promise<RequestAdmission>>();
    const capturedAdmission = (candidates: readonly AccessProviderCandidate[]): Promise<RequestAdmission> => {
      const key = JSON.stringify(candidates.map((candidate) => [accessProviderAccountKey(candidate), candidate.spendMode]));
      let admission = admissions.get(key);
      if (admission === undefined) {
        admission = requestAdmission(connection, runtimeConfig)(candidates);
        admissions.set(key, admission);
      }
      return admission;
    };
    return {
      connection,
      providers,
      eligibility,
      runtimeConfig,
      requestAdmission: capturedAdmission,
      async standing(plan, providerOptions) {
        const candidates = plan.candidateAttributions.map(({ candidate }) => candidate);
        const admission = await capturedAdmission(candidates);
        const availability = getSharedProviderAvailability().forCandidates(connection.profileId, candidates);
        availability.refreshProjection();
        return modelStanding(plan, {
          availability,
          ...(providerOptions === undefined ? {} : { providerOptions }),
          conditions: connection.auth.conditions ?? [],
          credentialLineage: (candidate) => candidateCredentialLineage(connection, candidate),
          subscriptionSpendAuthorizationFor: admission.subscriptionSpendAuthorizationFor,
          ...(admission.subscriptionAllowanceFor === undefined ? {} : { subscriptionAllowanceFor: admission.subscriptionAllowanceFor }),
        }, providers.selection.shortName);
      },
      admit(plans) {
        const createAdmittedLLMClient: LLMClientFactory = (model, _moduleSnapshot, requestConfig, providerSessionLifetime) => {
          const requestRuntimeConfig = requestConfig ?? runtimeConfig;
          const plan = plans.get(model);
          if (!plan) throw new Error(`Model "${model}" was not admitted for this run`);
          return createAdmittedClient(plan, modelsClient, connection, admittedClientOptions(providers, connection, requestRuntimeConfig, eligibility, providerSessionLifetime));
        };
        return {
          createLLMClient: createAdmittedLLMClient,
          createAgent: (options) => new LiveAgent(
            hostedOptions(
              options,
              connection.auth,
              { ...generationSurfaces, webSearch: webSearchFor(connection) },
              () => providers.composition,
            ),
            createAdmittedLLMClient,
            deps.definitions,
            breadcrumbMaintenance,
            undefined,
            options.captureModelRuntime ?? (async () => ({
              generation: deps,
              createLLMClient: createAdmittedLLMClient,
              captureProviderConnection: options.captureProviderConnection,
            })),
          ),
        };
      },
    };
  };
  /** The options, the client factory, and the model runtime of one agent that `options` describe, on `auth`. */
  const agentParts = (options: AgentOptions) => {
    const auth = deps.connection?.auth ?? options.auth ?? deps.getAuth();
    const agentClient: LLMClientFactory = async (model, requestedSnapshot, requestedConfig, providerSessionLifetime) => {
      const moduleSnapshot = requestedSnapshot ?? moduleSelection();
      const runtimeConfig = requestedConfig ?? deps.captureRuntimeConfig();
      const providers = accessProviderRegistry(moduleSnapshot);
      const connection = deps.connection ?? captureAccountConnection(auth, deps.authDirectory(), providers, deps.profileId);
      if (!deps.connection) return createClient(model, modelsClient, auth, {
        ...clientOptions(moduleSnapshot, runtimeConfig, connection, providerSessionLifetime),
        connection,
        eligibility: deps.getProviderModelEligibility?.(),
      });
      const eligibility = deps.getProviderModelEligibility?.();
      const plan = providers.selection.plan(model, connection, eligibility, runtimeConfig.allowTrainingRoutes);
      return createAdmittedClient(plan, modelsClient, connection, admittedClientOptions(providers, connection, runtimeConfig, eligibility, providerSessionLifetime));
    };
    return {
      runnable: { ...hostedOptions(options, auth), captureProviderConnection: options.captureProviderConnection ?? captureProviderConnection },
      agentClient,
      captureModelRuntime: options.captureModelRuntime ?? (async () => ({ generation: deps, createLLMClient, captureProviderConnection })),
    };
  };
  const createAgent: AgentFactory = (options) => {
    const { runnable, agentClient, captureModelRuntime } = agentParts(options);
    return new LiveAgent(runnable, agentClient, deps.definitions, breadcrumbMaintenance, undefined, captureModelRuntime);
  };
  /** The authorities that build the requests of the session run that `options` describe, without its Agent. */
  const runSource = (options: AgentOptions) => {
    const { runnable, agentClient, captureModelRuntime } = agentParts(options);
    return {
      options: runnable,
      definitions: deps.definitions,
      captureModelRuntime,
      createRunner: (childOptions: RunnableAgentOptions) => new LiveAgent(childOptions, agentClient, deps.definitions, breadcrumbMaintenance, undefined, captureModelRuntime),
    };
  };
  const prepareRequest: RequestPreparer = (options, preparation) => {
    const source = runSource(options);
    return prepareRunRequest({ ...preparation, ...source, options: { ...source.options, providerSession: options.providerSession } });
  };
  const planCapabilities: CapabilityPlanner = (options) => planCapabilitiesOfRun(runSource(options));
  return { moduleSelection, createAgent, prepareRequest, planCapabilities, createLLMClient, captureProviderConnection, usageProfile };
}
