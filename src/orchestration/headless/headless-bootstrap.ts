import { ManagedRuntime } from "effect"
import { EventStoreLive, EventStoreService, EventStoreWriterLaneService, EventStoreWriterService, LocalEventStoreService, type EventStoreRuntime, type LocalEventStoreRuntime, type RuntimeEventState } from "../../infra/event-store-effect.js"
import type { AsyncEventWriter, EventStoreReadSurface } from "../../infra/event-store-types.js"
import type { EventStoreWriterLane } from "../../infra/event-store-writer-lane-types.js"
import type { ModuleServices } from "../../infra/module-service.js"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js"
import type { WorkflowDeps } from "../workflow-host/deps.js"
import type { FlywheelConfig } from "../config/schema.js"
import { createRuntimeConfigOwner, type RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import { createSessionManager, type SessionManager } from "../session/manager.js"
import { startModulePolicy, type ModulePolicyStartup } from "../config/module-policy.js"
import { prepareWorkspaceState } from "../workspace-state.js"
import { acquireSharedProviderAvailability, disposeSharedProviderAvailability } from "../agent-runtime/llm/shared-provider-availability.js"
import type { ModuleId } from "../modules.js"
import { installedAccessProviderIds } from "../credential-provider-modules.js"
import { installedModules } from "../module-catalog.js"
import { composePortableModuleServices } from "../app-service/module-service-host.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import { buildCustomProvidersFromConfig, logCustomProviderDiagnostics, publishCustomProvidersFromConfig } from "../config/custom-providers.js"
import type { CaptureSubscriptionAdmission } from "../agent-runtime/factory.js"
import type { SubscriptionUsageProfile } from "../auth/provider-observations/subscription-usage-service.js"
import { createHeadlessSubscriptionAdmission } from "./headless-profile-runtime.js"
import { createInstalledDefinitionRegistry } from "../definition-catalog.js"
import { createMutationEvidenceRecovery } from "../session/mutation-evidence-recovery.js"
import { createRuntimeModuleComposer } from "../app-service/runtime-module-composition.js"

export interface HeadlessBootstrapContext {
  readonly capabilityPolicy: ModulePolicyStartup
  readonly moduleSelection: WorkflowDeps["moduleSelection"]
  readonly definitions: ProjectDefinitionRegistry
  readonly runtimeConfig: RuntimeConfigOwner
  readonly runtime: EventStoreRuntime
  readonly eventStore: EventStoreReadSurface
  /** The same store as `eventStore`, read asynchronously, with its writes. */
  readonly eventState: RuntimeEventState
  readonly eventWriter: AsyncEventWriter
  readonly writerLane: EventStoreWriterLane
  /** Starts the portable services of the enabled modules, once, for every
   *  runner the run builds, and answers when their startup has settled, with
   *  the notices a person must read. A run that builds no runner never calls
   *  it, so no service starts for it. The bootstrap
   *  disposes the services after the run and before the store closes,
   *  because their work publishes through the store. */
  startModuleServices(): Promise<StartedModuleServices>
  captureSubscriptionAdmission(profile: SubscriptionUsageProfile, ...request: Parameters<CaptureSubscriptionAdmission>): ReturnType<CaptureSubscriptionAdmission>
  createManager(config: FlywheelConfig): SessionManager
}

interface StartedModuleServices {
  readonly services: ModuleServices
  readonly notices: readonly string[]
}

export interface HeadlessBootstrapRun<T> {
  readonly result: T
  readonly settle?: () => Promise<void>
}

interface HeadlessBootstrapOptions {
  readonly directories: StartupDirectories
  /** Launch authority of the command. The portable services launch into it,
   *  so a process one of them starts ends with the run (ARCH-TOOLS-029). */
  readonly launcher: LauncherScope
  readonly disabledTools?: readonly string[]
  /** Enabled modules this run composes without: no tool, prompt fragment,
   *  service, provider, or capability of theirs exists in the run. */
  readonly excludedModules?: readonly ModuleId[]
  readonly awaitModulePolicy?: <A>(operation: Promise<A>) => Promise<A>
  readonly createManager?: (projectRoot: string, config: FlywheelConfig, eventStore: EventStoreReadSurface, eventWriter: AsyncEventWriter) => SessionManager
  readonly eventWriter?: AsyncEventWriter
}

export async function disposeHeadlessBootstrapResources(options: {
  readonly settleRunOwned?: () => Promise<void>
  readonly disposeModuleServices?: () => Promise<void>
  readonly closeConfig?: () => Promise<void>
  readonly closeSubscriptionUsage?: () => Promise<void>
  readonly closeRuntime?: () => Promise<void>
  readonly releaseGeneration?: () => void
  readonly disposeProviderAvailability: () => Promise<void>
}): Promise<void> {
  const failures: unknown[] = []
  for (const operation of [options.settleRunOwned, options.disposeModuleServices, options.closeConfig, options.closeSubscriptionUsage, options.closeRuntime, options.releaseGeneration, options.disposeProviderAvailability]) {
    if (!operation) continue
    try {
      await operation()
    } catch (cause) {
      failures.push(cause)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Headless bootstrap disposal failed")
}

/** Owns the resources shared by every headless execution kind. The run body owns
 * kind-specific admission and settlement, and returns any final settlement that
 * must finish before the shared runtime starts closing. */
export async function runHeadlessBootstrap<T>(
  options: HeadlessBootstrapOptions,
  run: (context: HeadlessBootstrapContext) => Promise<HeadlessBootstrapRun<T>>,
): Promise<T> {
  const { directories } = options
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, watch: false })
  const providerCandidate = buildCustomProvidersFromConfig(runtimeConfig.snapshot().config.custom_providers)
  publishCustomProvidersFromConfig(providerCandidate)
  logCustomProviderDiagnostics(providerCandidate)
  // The policy publishes the run's own selection, so the composition below,
  // every capability check, and every grant read that one selection.
  const capabilityPolicy = await (options.awaitModulePolicy ?? (async <A>(operation: Promise<A>) => await operation))(
    startModulePolicy({ userDataRoot: directories.userDataRoot }, runtimeConfig, { excluded: options.excludedModules ?? [] }),
  )
  const moduleComposition = createRuntimeModuleComposer(options.disabledTools)(capabilityPolicy.policy.state())
  const moduleSelection = (): typeof moduleComposition => moduleComposition
  const subscriptions = createHeadlessSubscriptionAdmission(moduleSelection, options.launcher)
  const moduleServices = composePortableModuleServices(installedModules(), () => moduleComposition.enabledModuleIds, {
    directories,
    config: runtimeConfig,
    launcher: options.launcher,
    // A headless run holds one selection for its whole life.
    onSelectionChanged: () => () => {},
  })
  let moduleServicesStart: Promise<StartedModuleServices> | undefined
  const startModuleServices = (): Promise<StartedModuleServices> => {
    if (moduleServicesStart) return moduleServicesStart
    moduleServicesStart = (async () => {
      moduleServices.start()
      return { services: moduleServices.services, notices: await moduleServices.settleStartup() }
    })()
    // The caller awaits the start later; a run that fails first still disposes the services.
    moduleServicesStart.catch(() => {})
    return moduleServicesStart
  }
  let workspaceState: ReturnType<typeof prepareWorkspaceState> | undefined
  let runtime: LocalEventStoreRuntime | undefined
  let settleRunOwned: (() => Promise<void>) | undefined

  acquireSharedProviderAvailability(directories.userDataRoot, installedAccessProviderIds())
  try {
    workspaceState = prepareWorkspaceState(directories)
    const definitions = createInstalledDefinitionRegistry(directories)
    runtime = ManagedRuntime.make(EventStoreLive(workspaceState.dbFile,
      (reader, writer) => createMutationEvidenceRecovery(reader, writer).reader))
    // A headless run owns its project's store, so it reads the connection itself.
    const eventStore = await runtime.runPromise(LocalEventStoreService)
    const eventState = await runtime.runPromise(EventStoreService)
    const eventWriter = options.eventWriter ?? await runtime.runPromise(EventStoreWriterService)
    const writerLane = await runtime.runPromise(EventStoreWriterLaneService)
    const createManagerForRun = (config: FlywheelConfig): SessionManager => options.createManager?.(
      directories.projectRoot,
      config,
      eventStore,
      eventWriter,
    ) ?? createSessionManager({
      projectRoot: directories.projectRoot,
      executionCwd: directories.executionCwd,
      projectionReader: eventState,
      writer: eventWriter,
    })
    const execution = await run({ capabilityPolicy, moduleSelection, definitions, runtimeConfig, runtime, eventStore, eventState, eventWriter, writerLane, startModuleServices, captureSubscriptionAdmission: subscriptions.capture, createManager: createManagerForRun })
    settleRunOwned = execution.settle
    return execution.result
  } finally {
    const closeRuntime = runtime ? runtime.dispose.bind(runtime) : undefined
    const releaseGeneration = workspaceState ? workspaceState.generation.release.bind(workspaceState.generation) : undefined
    await disposeHeadlessBootstrapResources({
      settleRunOwned,
      disposeModuleServices: moduleServices.dispose,
      closeConfig: runtimeConfig.dispose,
      closeSubscriptionUsage: subscriptions.dispose,
      closeRuntime,
      releaseGeneration,
      disposeProviderAvailability: disposeSharedProviderAvailability,
    })
  }
}

