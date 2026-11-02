/**
 * Shared harness for live provider tests.
 *
 * Every live test runs a model, `LIVE_MODEL` unless its route names another,
 * on the `LIVE_AUTH_PROFILE` auth profile, and the harness resolves the
 * serving route the way a headless run on that profile does. It composes the realm's first-party modules from the user's
 * module policy, captures the profile's account connection and provider-model
 * eligibility, and builds the client through the production runtime factory.
 * The production planner and failover walk then choose the account that
 * serves each request: a subscription or an API key. Subscription spend is
 * admitted through the production consent and allowance capture, so a route
 * the profile has not consented to is skipped exactly as production skips it.
 *
 * The harness records the account that served each provider attempt and
 * prints it, so a run shows whether a subscription or an API key paid.
 */
import { LIVE_AUTH_PROFILE_UNSET, liveAuthProfile } from "../../../scripts/claude-engine-release.js";
import { authProfileEligibilityInputRevision, createEligibilityPreparation } from "../../../src/orchestration/app-service/eligibility-preparation.js";
import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js";
import { normalizeAuthProfile } from "../../../src/infra/auth/auth-profile-normalization.js";
import { resolveAuthContext } from "../../../src/infra/auth/auth-context.js";
import { createKeyResolver, createOwnedCredentialCommandRunner } from "../../../src/infra/auth/resolve-key.js";
import { selectStartupDirectories } from "../../../src/infra/directory-authorities.js";
import { createLauncherScope, createProcessSupervisor, type LauncherScope } from "../../../src/infra/process-supervisor.js";
import { createAgentRuntime } from "../../../src/orchestration/agent-runtime/factory.js";
import { AuthProfileManager } from "../../../src/orchestration/auth/auth-profile-manager.js";
import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { captureAccountConnection } from "../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { acquireSharedProviderAvailability, disposeSharedProviderAvailability } from "../../../src/orchestration/agent-runtime/llm/shared-provider-availability.js";
import type { ModelClient, ProviderSessionLifetime, ServingAttempt } from "../../../src/orchestration/agent-runtime/llm/types.js";
import { randomUUID } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import { captureRuntimeConfigRequest } from "../../../src/orchestration/agent-runtime/request-config.js";
import { createProviderModelPreferenceService } from "../../../src/orchestration/app-service/provider-model-preference-service.js";
import { providerModelPreferencePersistence } from "../../../src/orchestration/app-service/provider-model-preference-persistence.js";
import { createSubscriptionUsageService } from "../../../src/orchestration/auth/provider-observations/subscription-usage-service.js";
import { createSubscriptionUsageServicePool } from "../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js";
import { credentialSlotClassifier } from "../../../src/orchestration/auth/credential-slot-classifier.js";
import { getSharedModelsClient } from "../../../src/orchestration/config/llm-clients.js";
import { startModulePolicy } from "../../../src/orchestration/config/module-policy.js";
import { createRuntimeConfigOwner } from "../../../src/orchestration/config/runtime-config-owner.js";
import { installedDefinitionBundles } from "../../../src/orchestration/module-catalog.js";
import { composeRealmModuleSnapshot, type FirstPartyModule } from "../../../src/orchestration/modules.js";
import { installedAccessProviderDefinitions, installedAccessProviderIds, installedCredentialProviderIds } from "../../../src/orchestration/credential-provider-modules.js";
import { captureSubscriptionAdmission } from "../../../src/orchestration/subscription-spend-consent/admission-capture.js";
import { createSubscriptionSpendConsentCaptureCache } from "../../../src/orchestration/subscription-spend-consent/capture-cache.js";
import type { SubscriptionSpendConsentCapture } from "../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js";
import { installedPersonaToolEntries } from "../../../src/orchestration/tool-catalog.js";
import { createProjectDefinitionRegistry } from "../../../src/workflows/definition-registry.js";

/** The auth profile every live test resolves its routes from: the one that
 *  `LIVE_AUTH_PROFILE_SETTING` names. The active profile is never consulted,
 *  and an unset setting fails the suite at load. */
export const LIVE_AUTH_PROFILE = requireLiveAuthProfile();
/** The one model every live test runs, on whichever account the production
 *  walk admits for it in `LIVE_AUTH_PROFILE`. */
export const LIVE_MODEL = "gpt-6-luna";

/** The directory authorities a CLI start in this checkout would publish. */
export const liveDirectories = selectStartupDirectories({ cwd: process.cwd(), env: process.env });

function requireLiveAuthProfile(): string {
  const named = liveAuthProfile(process.env);
  if (named === undefined) throw new Error(`Live provider tests: ${LIVE_AUTH_PROFILE_UNSET}.`);
  return named;
}

/** Resolves `LIVE_AUTH_PROFILE` as `FLYWHEEL_AUTH_PROFILE` resolves it, by id
 *  or by display name, without creating anything: a renamed profile keeps the
 *  directory of its original id. A missing profile fails the suite at load: a
 *  live run never falls back to another profile. */
function requireLiveProfile() {
  const stored = new AuthProfileStore(liveDirectories.userDataRoot).inspect().profiles;
  const { id, directory } = new AuthProfileManager({ userDataRoot: liveDirectories.userDataRoot, projectRoot: process.cwd(), env: { FLYWHEEL_AUTH_PROFILE: LIVE_AUTH_PROFILE } }).inspect();
  if (!stored.some((profile) => profile.id === id)) {
    const names = stored.map((profile) => profile.displayName).join(", ") || "none";
    throw new Error(`Live provider tests need the auth profile "${LIVE_AUTH_PROFILE}" under ${liveDirectories.userDataRoot}; stored profiles: ${names}.`);
  }
  return { id, directory };
}

const profile = requireLiveProfile();

/** What one live run holds: the resolved client and the launch authority its
 *  credential commands and tools spawn through. `createClient` resolves one
 *  more client of the same route whose provider session lives in `lifetime`,
 *  as the runner of a chat resolves the client of its conversation. */
export interface LiveRun {
  readonly client: ModelClient;
  readonly launcher: LauncherScope;
  readonly createClient: (lifetime: ProviderSessionLifetime) => Promise<ModelClient>;
}

/** What a live run resolves. */
export interface LiveRoute {
  readonly model: string;
  /** The module catalog to compose from, when a test gives a module its test seams. Default: the installed catalog. */
  readonly modules?: readonly FirstPartyModule[];
  /** The reason to refuse a provider attempt that the walk selected, or undefined to let it run. A refusal fails the
   *  request before the attempt sends anything, so a tier that qualifies one provider never passes on another. */
  readonly refuse?: (attempt: ServingAttempt) => string | undefined;
}

/** Runs `use` with a real client of `route` resolved as a headless run on
 *  `LIVE_AUTH_PROFILE` resolves it, then releases every owner the resolution
 *  opened. It throws with the eligibility detail when no account in the
 *  profile can serve the model. `label` names the test in the printed
 *  serving-account line. */
export async function withLiveClient<T>(label: string, use: (run: LiveRun) => Promise<T>, route: LiveRoute = { model: LIVE_MODEL }): Promise<T> {
  // Owners are released in reverse order of acquisition, whatever fails.
  const releases: Array<() => void | Promise<void>> = [];
  const served: string[] = [];
  try {
    const supervisor = createProcessSupervisor();
    releases.push(() => supervisor.dispose());
    const launcher = createLauncherScope(supervisor);
    releases.push(async () => { await launcher.close(); });
    const resolveKey = createKeyResolver(createOwnedCredentialCommandRunner(launcher));
    const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: liveDirectories.userDataRoot, watch: false });
    releases.push(() => runtimeConfig.dispose());
    const requestConfig = captureRuntimeConfigRequest(runtimeConfig.snapshot(), profile.id);
    const modulePolicy = await startModulePolicy({ userDataRoot: liveDirectories.userDataRoot }, runtimeConfig);
    releases.push(() => modulePolicy.dispose());
    const composition = route.modules === undefined ? composeRealmModuleSnapshot(modulePolicy.policy.state()) : composeRealmModuleSnapshot(modulePolicy.policy.state(), route.modules);
    const providers = accessProviderRegistry(composition);
    const classifySlot = credentialSlotClassifier(composition);
    acquireSharedProviderAvailability(liveDirectories.userDataRoot, installedAccessProviderIds());
    releases.push(() => disposeSharedProviderAvailability());

    const providerModels = createProviderModelPreferenceService({
      displayName: (providerId) => providers.selection.displayName(providerId),
      allowTrainingRoutes: () => requestConfig.allowTrainingRoutes,
      ...providerModelPreferencePersistence(() => profile.directory),
    });
    releases.push(() => providerModels.dispose());
    const prepareEligibility = createEligibilityPreparation({
      allowTrainingRoutes: () => requestConfig.allowTrainingRoutes,
      userDataRoot: liveDirectories.userDataRoot,
      resolveKey,
      moduleSelection: () => composition,
      prepare: providerModels.prepare,
      publish: providerModels.publish,
      current: providerModels.state,
      inputRevision: authProfileEligibilityInputRevision,
      normalizeProfile: async (target) => { await normalizeAuthProfile(target.directory, classifySlot, installedCredentialProviderIds(), installedAccessProviderDefinitions()); },
      refreshMetadata: (signal) => getSharedModelsClient(liveDirectories.userDataRoot).refresh(signal),
    });
    releases.push(() => prepareEligibility.dispose());
    const eligibility = await prepareEligibility(profile, { settled: true });

    const auth = await resolveAuthContext({
      authDir: profile.directory,
      resolveKey,
      credentialProviderIds: installedCredentialProviderIds(),
      credentialSlotClassifier: classifySlot,
    });
    const plan = providers.selection.plan(route.model, captureAccountConnection(auth, profile.directory, providers, profile.id), eligibility.worker, requestConfig.allowTrainingRoutes);
    if (plan.kind === "unavailable") {
      const eligible = [...eligibility.picker.keys()].join(", ") || "none";
      throw new Error(`No account in auth profile "${profile.id}" can serve ${route.model}: ${plan.reason} Models the profile can serve: ${eligible}.`);
    }

    const usagePool = createSubscriptionUsageServicePool({
      create: (usageProfile, thresholds) => createSubscriptionUsageService({
        profile: () => usageProfile,
        registry: () => providers,
        thresholds: () => thresholds,
        monitor: false,
      }),
    });
    const consentCache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>();
    releases.push(() => {
      usagePool.closeAdmission();
      consentCache.clear();
      return usagePool.settled();
    });
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      getAuth: () => auth,
      definitions: createProjectDefinitionRegistry({
        ...liveDirectories,
        bundles: installedDefinitionBundles(),
        personaToolEntries: installedPersonaToolEntries(),
      }),
      moduleSelection: () => composition,
      authDirectory: () => profile.directory,
      profileId: profile.id,
      userDataRoot: liveDirectories.userDataRoot,
      launcher,
      getProviderModelEligibility: () => eligibility.worker,
      captureRuntimeConfig: () => requestConfig,
      captureSubscriptionAdmission: (candidates, providerSettings) => captureSubscriptionAdmission({
        profile,
        candidates,
        providerSettings,
        registry: providers,
        pool: usagePool,
        consentCache,
      }),
    });
    const createClient = async (lifetime: ProviderSessionLifetime) => recordServingAccounts(await runtime.createLLMClient(route.model, composition, requestConfig, lifetime), served, route.refuse);
    const scope = Effect.runSync(Scope.make());
    releases.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    return await use({ client: await createClient({ providerSessionKey: `live-${randomUUID()}`, scope }), launcher, createClient });
  } finally {
    process.stdout.write(`[live] ${label}: ${route.model} on profile ${profile.id} served by ${served.length === 0 ? "no provider attempt" : [...new Set(served)].join("; ")}\n`);
    for (const release of releases.toReversed()) await release();
  }
}

/** Names the account one provider attempt spends. */
function servingAccount(attempt: ServingAttempt): string {
  const candidate = attempt.accessProviderCandidate;
  if (candidate === undefined) return attempt.accessProvider;
  const account = candidate.kind === "subscription" ? `subscription ${candidate.instanceId}` : "API key";
  return `${candidate.providerId} ${account} (${candidate.spendMode})`;
}

/** The same client, with every provider attempt the walk executes recorded in
 *  `served`. A failover inside one request records each account it tried. An
 *  attempt that `refuse` refuses throws before it sends anything. */
function recordServingAccounts(client: ModelClient, served: string[], refuse: LiveRoute["refuse"]): ModelClient {
  return {
    get model() { return client.model; },
    get modelFamily() { return client.modelFamily; },
    plannedAttempt: (providerOptions) => client.plannedAttempt(providerOptions),
    async admitRequest() {
      const admitted = await client.admitRequest();
      return {
        candidateAttributions: admitted.candidateAttributions,
        plannedAttempt: admitted.plannedAttempt,
        prepare: admitted.prepare,
        run: (request) => admitted.run({
          ...request,
          execute: (candidate) => {
            const account = servingAccount(candidate.attempt);
            const refusal = refuse?.(candidate.attempt);
            served.push(refusal === undefined ? account : `${account} refused`);
            if (refusal !== undefined) throw new Error(`The provider walk selected ${account}, which this test refuses: ${refusal}`);
            return request.execute(candidate);
          },
        }),
      };
    },
  };
}
