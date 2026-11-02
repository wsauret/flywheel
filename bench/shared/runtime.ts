import { createOwnedCredentialCommandRunner, createKeyResolver } from "../../src/infra/auth/resolve-key.js";
import { selectStartupDirectories, type StartupDirectories } from "../../src/infra/directory-authorities.js";
import { findConfigFile } from "../../src/infra/paths.js";
import {
  acquireSharedProviderAvailability,
  disposeSharedProviderAvailability,
} from "../../src/orchestration/agent-runtime/llm/shared-provider-availability.js";
import { captureRuntimeConfigRequest } from "../../src/orchestration/agent-runtime/request-config.js";
import { createRuntimeConfigOwner } from "../../src/orchestration/config/runtime-config-owner.js";
import { AuthProfileManager } from "../../src/orchestration/auth/auth-profile-manager.js";
import { startModulePolicy } from "../../src/orchestration/config/module-policy.js";
import { composeRealmModuleSnapshot, type ModuleId } from "../../src/orchestration/modules.js";
import { installedAccessProviderIds } from "../../src/orchestration/credential-provider-modules.js";
import { createAgentJudge, type JudgeModel } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { prepareWorkflowDeps, type WorkflowDeps } from "../../src/orchestration/workflow-host/deps.js";
import { createCliLauncher } from "../../src/cli/runtime-launch.js";
import { createInstalledDefinitionRegistry } from "../../src/orchestration/definition-catalog.js";
import { createHeadlessProfileRuntime, resolveHeadlessAuthProfile } from "../../src/orchestration/headless/headless-profile-runtime.js";
import { getSharedModelsClient } from "../../src/orchestration/config/llm-clients.js";
import { createHeadlessUsageAuthorityOwner } from "../../src/orchestration/headless/headless-usage-authority.js";
import { createBackgroundExecutionOwner, type BackgroundExecutionOwner } from "../../src/orchestration/agent-runtime/background-execution-owner.js";
import {
  createForegroundBashHoldController,
  type ForegroundBashHoldController,
} from "../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { createBackgroundWorkRegistry } from "../../src/orchestration/agent-runtime/background-work.js";
import type { UsageAuthorityGeneration } from "../../src/orchestration/agent-runtime/usage-settlement.js";
import { createSubscriptionUsageService } from "../../src/orchestration/auth/provider-observations/subscription-usage-service.js";
import { createSubscriptionUsageServicePool } from "../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js";
import { createSubscriptionSpendConsentCaptureCache } from "../../src/orchestration/subscription-spend-consent/capture-cache.js";
import { captureSubscriptionAdmission } from "../../src/orchestration/subscription-spend-consent/admission-capture.js";
import type { SubscriptionSpendConsentCapture } from "../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js";
import type { LauncherScope } from "../../src/infra/process-supervisor.js";
import type { ShellRuntimeClient } from "../../src/orchestration/agent-runtime/tools/shell-runtime-types.js";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { accessProviderRegistry } from "../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import type { ProjectDefinitionRegistry } from "../../src/workflows/definition-registry.js";
export interface OwnedBenchmarkRuntime extends AsyncDisposable {
  readonly deps: WorkflowDeps;
  readonly profileId: string;
  readonly usageAuthority: UsageAuthorityGeneration;
  readonly background: BackgroundExecutionOwner;
  readonly foregroundBashHold: ForegroundBashHoldController;
  readonly launcher: LauncherScope;
  readonly shell: ShellRuntimeClient;
  readonly runOwnedCommand: OwnedCommandRunner;
  assertUsageAuthority(expected: UsageAuthorityGeneration): void;
}

export interface PreparedBenchmarkRuntime {
  readonly deps: WorkflowDeps;
  readonly profileId: string;
  readonly usageAuthority: UsageAuthorityGeneration;
  readonly background: BackgroundExecutionOwner;
  readonly foregroundBashHold: ForegroundBashHoldController;
  readonly launcher: LauncherScope;
  readonly shell: ShellRuntimeClient;
  assertUsageAuthority(expected: UsageAuthorityGeneration): void;
  dispose(): Promise<void>;
}

export interface BenchmarkRuntimeComposition {
  acquireAvailability(userDataRoot: string): void;
  disposeAvailability(): Promise<void>;
  /** `authProfile` selects the profile as `FLYWHEEL_AUTH_PROFILE` would; a stored generation's profile wins.
   *  `excludedModules` stay off whatever the account's selection states. */
  prepare(directories: StartupDirectories, options: Omit<BenchmarkRuntimeOptions, "composition" | "accountHome">): Promise<PreparedBenchmarkRuntime>;
}

const PRODUCTION_COMPOSITION: BenchmarkRuntimeComposition = {
  acquireAvailability: (userDataRoot) => { acquireSharedProviderAvailability(userDataRoot, installedAccessProviderIds()); },
  disposeAvailability: disposeSharedProviderAvailability,
  async prepare(directories, { stored, authProfile: selected, excludedModules = [], definitions: definitionOwner, watchConfig = false }) {
    await using resources = new AsyncDisposableStack();
    const definitions = definitionOwner ?? createInstalledDefinitionRegistry(directories);
    const launcher = await createCliLauncher();
    resources.defer(async () => { await launcher.dispose(); });
    const configLocation = { configPath: findConfigFile(directories.userDataRoot), userDataRoot: directories.userDataRoot };
    const configOwner = await createRuntimeConfigOwner({ ...configLocation, watch: watchConfig });
    resources.defer(async () => { await configOwner.dispose(); });
    const authProfiles = new AuthProfileManager({
      userDataRoot: directories.userDataRoot,
      projectRoot: directories.projectRoot,
      ...(stored || selected !== undefined ? { env: { FLYWHEEL_AUTH_PROFILE: stored?.profileId ?? selected } } : {}),
    });
    const authProfile = await resolveHeadlessAuthProfile(authProfiles);
    // The modules the account enables less the modules the caller leaves out,
    // through the entry that a headless run with these excluded modules starts
    // its policy through (headless-bootstrap.ts), so the obsolete-setting
    // migration and an invalid file's fallback give both one selection.
    const modulePolicy = await startModulePolicy(configLocation, configOwner, { excluded: excludedModules });
    resources.defer(async () => { await modulePolicy.dispose(); });
    const moduleComposition = composeRealmModuleSnapshot({ moduleIds: modulePolicy.policy.state().moduleIds });
    const moduleSelection = () => moduleComposition;
    const usagePool = createSubscriptionUsageServicePool({
      create: (profile, thresholds) => createSubscriptionUsageService({
        profile: () => profile,
        registry: () => accessProviderRegistry(moduleComposition),
        thresholds: () => thresholds,
        monitor: false,
      }),
    });
    const consentCache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>();
    resources.defer(async () => {
      usagePool.closeAdmission();
      consentCache.clear();
      await usagePool.settled();
    });
    const residentUsage = await usagePool.acquire(authProfile);
    resources.defer(async () => { await residentUsage.release(); });
    const authority = residentUsage.service.store();
    if (!authority) throw new Error(`Usage authority is unavailable for profile ${authProfile.id}`);
    const usageOwner = createHeadlessUsageAuthorityOwner(authProfile);
    resources.defer(async () => { await usageOwner.settled(); });
    const resolveKey = createKeyResolver(createOwnedCredentialCommandRunner(launcher.scope));
    const profileRuntime = await createHeadlessProfileRuntime({
      userDataRoot: directories.userDataRoot,
      modelsClient: getSharedModelsClient(directories.userDataRoot),
      profile: authProfile,
      allowTrainingRoutes: configOwner.snapshot().config.profiles[authProfile.id]?.allow_training_routes ?? false,
      captureRuntimeConfig: () => captureRuntimeConfigRequest(configOwner.snapshot(), authProfile.id),
      moduleSelection,
      resolveKey,
      workflowPreparation: {
        ...directories,
        definitions,
        moduleSelection,
        launcher: launcher.scope,
        resolveKey,
      },
      captureSubscriptionAdmission: (candidates, providerSettings) => captureSubscriptionAdmission({
        candidates,
        providerSettings,
        registry: accessProviderRegistry(moduleComposition),
        profile: authProfile,
        residentLease: residentUsage,
        pool: usagePool,
        consentCache,
      }),
      acquireUsageSettlementAuthority: usageOwner.acquire,
      prepareWorkflowDeps,
    });
    resources.defer(async () => { await profileRuntime.dispose(); });
    const deps = await profileRuntime.prepare();
    const generation = profileRuntime.generation();
    if (stored) profileRuntime.assertGeneration(stored);
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
    const foregroundBashHold = createForegroundBashHoldController(() => {});
    const generationResources = resources.move();
    return {
      deps,
      profileId: authProfile.id,
      usageAuthority: generation,
      background,
      foregroundBashHold,
      launcher: launcher.scope,
      shell: background.shell,
      assertUsageAuthority: profileRuntime.assertGeneration,
      dispose: async () => { await generationResources.disposeAsync(); },
    };
  },
};

export interface BenchmarkRuntimeOptions {
  readonly composition?: BenchmarkRuntimeComposition;
  /** Definition owner captured before provider connections and runner factories are built. */
  readonly definitions?: ProjectDefinitionRegistry;
  /** Account authority when the process HOME belongs to an isolated cell. */
  readonly accountHome?: string;
  /** The usage authority generation a resumed run must still hold. */
  readonly stored?: UsageAuthorityGeneration;
  /** The auth profile the runtime selects; the process environment's selection by default. */
  readonly authProfile?: string;
  /** Persona campaigns inherit profile edits in later cells; historical harnesses retain a fixed capture. */
  readonly watchConfig?: boolean;
  /** Installed modules the runtime leaves off whatever the account's selection
   *  states, such as the provider modules other than a benchmark arm's own. */
  readonly excludedModules?: readonly ModuleId[];
}

/** Compose the production runtime dependencies one benchmark process owns. */
export async function createBenchmarkRuntime(projectRoot: string, options: BenchmarkRuntimeOptions = {}): Promise<OwnedBenchmarkRuntime> {
  const { composition = PRODUCTION_COMPOSITION, accountHome, ...preparation } = options;
  const directories = selectStartupDirectories({ projectRootOption: projectRoot, env: process.env, cwd: projectRoot, home: accountHome });
  composition.acquireAvailability(directories.userDataRoot);
  try {
    const prepared = await composition.prepare(directories, preparation);
    let disposal: Promise<void> | undefined;
    return {
      deps: prepared.deps,
      profileId: prepared.profileId,
      usageAuthority: prepared.usageAuthority,
      background: prepared.background,
      foregroundBashHold: prepared.foregroundBashHold,
      launcher: prepared.launcher,
      shell: prepared.shell,
      runOwnedCommand: ownedCommandRunner(prepared.launcher),
      assertUsageAuthority: prepared.assertUsageAuthority,
      [Symbol.asyncDispose]: () => {
        disposal ??= (async () => {
        // Availability is released even when the prepared generation's own
        // disposal fails: a leaked availability lease outlives the process
        // that took it, and the rejection still reaches the caller.
        try {
          const failures: Error[] = [];
          const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
            try {
              await operation();
            } catch (cause) {
              failures.push(cause instanceof Error ? cause : new Error(String(cause)));
            }
          };
          await attempt(() => prepared.background.close());
          await attempt(() => prepared.foregroundBashHold.awaitSettlement());
          await attempt(() => prepared.foregroundBashHold.dispose());
          await attempt(() => prepared.dispose());
          if (failures.length > 0) {
            throw new AggregateError(failures, `Benchmark runtime cleanup failed: ${failures.map((failure) => failure.message).join("; ")}`);
          }
        } finally {
          await composition.disposeAvailability();
        }
        })();
        return disposal;
      },
    };
  } catch (error) {
    await composition.disposeAvailability();
    throw error;
  }
}

/** Build the tool-free, one-call Agent judge shared by every standalone harness. */
export async function createJudge(
  source: Pick<WorkflowDeps, "createAgent" | "captureProviderConnection" | "userDataRoot" | "accountHome" | "activeProfileId"> | OwnedBenchmarkRuntime,
  model: string,
  systemPrompt = "",
  evidenceDirectory?: string,
): Promise<JudgeModel> {
  const deps = "deps" in source ? source.deps : source;
  return createAgentJudge({
    createAgent: deps.createAgent,
    captureProviderConnection: deps.captureProviderConnection,
    model,
    systemPrompt,
    evidenceDirectory,
    userDataRoot: deps.userDataRoot,
    accountHome: deps.accountHome,
    ...(deps.activeProfileId ? { profileId: deps.activeProfileId } : {}),
    ...("deps" in source
      ? {
          profileId: source.profileId,
          authorityIncarnation: source.usageAuthority.authorityIncarnation,
          runtimeSurfaces: {
            launcher: source.launcher,
            background: source.background,
            foregroundBashHold: source.foregroundBashHold,
            shell: source.shell,
          },
        }
      : {}),
  });
}