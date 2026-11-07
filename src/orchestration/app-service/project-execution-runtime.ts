import { installedModules, workflowRunOwner } from "../module-catalog.js";
import { composeRoleProtocolProjection } from "./role-protocol-projection.js"
import { createModuleTransports, type ModuleTransports } from "./module-transports.js"
import { resolve } from "node:path"
import { Log } from "../../infra/log.js"
import { createKeyResolver, createOwnedCredentialCommandRunner } from "../../infra/auth/resolve-key.js"
import { ownedCommandRunner } from "../../infra/owned-command.js"
import { commandUsageFile } from "../../infra/paths.js"
import type { ProjectDirectories, StartupDirectories } from "../../infra/directory-authorities.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { ensureEventLoopLagSampler } from "../../infra/event-loop-lag.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { createStartupTimeline } from "../../infra/startup-timeline.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { PersistentProcessClient } from "../../infra/persistent-process-manager.js"
import type { BridgedPersistentProcessClient } from "../../infra/persistent-process-bridge.js"
import type { RuntimeChatDefault } from "../../protocol/app-service-types.js"
import { createReplacementReport, type ReplacementBlocker } from "./replacement-blockers.js"
import { continueAfterReplacement } from "./replacement-continuation.js"
import { capacityContinuer, type CapacityContinuation } from "./capacity-wait-continuation.js"
import { registerCapacityWaits } from "../session/capacity-wait.js"
import { WHOLE_WORKFLOW } from "../session/conversation/addressed-workflow-messages.js"
import { createContinuationLanes } from "../session/planned-session-continuation.js"
import type { ReplacementState } from "./replacement-owner.js"
import type { SuccessorRows } from "./project-executor-protocol.js"
import { composeExecutorCommandHandover, sweepCommandHandovers } from "./executor-command-handover.js"
import { queueStartupRecovery } from "../session/startup-recovery.js"
import { reconcileChildSessionCompletions } from "../session/child-session-reconciliation.js"
import { routeChildResultNotices } from "../session/child-reconciliation-fault.js"
import { liveChildRuns, runningChildSessionIds, onLiveSessionRemoved, liveSessionControl } from "../session/live-session-control.js"
import { bindRetainedOperations, bindSessionStops } from "../session/module-session-operations.js"
import { attachedRunnerDelivery } from "./session-background-notifications.js"
import { createChildSessionControl } from "../session/child-session-control.js"
import { childSessionProjectionAttachment } from "../session-store/child-session-projection.js"
import { bindRetainedOperationHost, composeRetainedOperationHosts } from "../../infra/retained-operation-hosts.js"
import { workflowLaunchHost } from "../workflow-host/launch-operation-contract.js"
import { createRuntimeConfigOwner } from "../config/runtime-config-owner.js"
import { buildCustomProvidersFromConfig, logCustomProviderDiagnostics, publishCustomProvidersFromConfig } from "../config/custom-providers.js"
import { startModulePolicy } from "../config/module-policy.js"
import { prepareDefinitionReconciliation, type FirstPartyModuleComposition } from "../modules.js";
import { createRuntimeModuleComposer } from "./runtime-module-composition.js"
import { installedAccessProviderIds } from "../credential-provider-modules.js";
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js"
import { definitionRoots, type ProjectDefinitionRegistry } from "../../workflows/definition-registry.js";
import { watchDefinitionRoots } from "./definition-root-watcher.js"
import { skillStoreRoots } from "../../workflows/skills.js"
import { createInstalledDefinitionRegistry } from "../definition-catalog.js"

import { createModuleProjection } from "./module-projection.js"
import { createRuntimeConfigProjection } from "./runtime-config-projection.js"
import { persistentProcessPolicy } from "../config/persistent-process-policy.js"
import { shellWriteGuardObserver } from "../config/shell-write-guard-policy.js"
import { createSessionViewLoader } from "../session-store/view.js"
import { createFlywheelAppService, type FlywheelAppServiceDeps } from "./app-service.js"
import { composeAuthLogin } from "./auth-login-composition.js"
import { createAuthRuntime, type AuthRuntime } from "./auth-runtime.js"
import type { HeadlessAuthSelection } from "../headless/headless-profile-runtime.js"
import { createLazyWorkflowController } from "./lazy-workflow-controller.js"
import { composeModuleProtocolRuntimes } from "./module-protocol-host.js"
import { createSessionChangesPublisher } from "./session-changes-publisher.js"
import { createSessionPlacements } from "../session/session-metadata-store.js"
import { composeBackgroundIndex } from "./background-index.js"
import { createRuntimeSupervisor } from "./runtime-supervisor.js"
import { createChatRunnerLoader } from "./chat-runner-loader.js"
import type { ChatRunner } from "../chat/runner-types.js"
import { createIdleCompactionPolicy } from "../chat/idle-compaction.js"
import type { RuntimeRunnerCapabilities, RuntimeSupervisor } from "./runtime-supervisor-types.js"
import { createCommandInvokeService } from "./command-invoke-service.js"
import { createRuntimeBackgroundLane } from "./runtime-background-lane.js"
import { runRuntimeShutdownBarrier, type RuntimeShutdownOwner, type RuntimeShutdownRequest, type RuntimeShutdownResult } from "./runtime-shutdown.js"
import { createRuntimeOwnership, type RuntimeOwnership } from "./runtime-ownership.js"
import { completeProjectExecutionOwnership } from "./project-execution-ownership.js"
import { createProcessBackgroundClient } from "./worker-background-client.js"
import { createCommandCatalogProjection } from "./command-catalog-projection.js"
import { createDefinitionAvailability } from "./definition-availability.js"
import { loadBundledDefaultCatalog } from "../../workflows/definitions/bundled-defaults.js"
import { deriveDefinitionStalenessReport } from "../../workflows/definitions/override-staleness.js"
import { createDefinitionOverrideService } from "../definition-overrides/override-service.js"
import { createDefinitionOverrideBaselineOwner } from "../../workflows/definitions/override-baselines.js"
import { acquireSharedProviderAvailability, disposeSharedProviderAvailability } from "../agent-runtime/llm/shared-provider-availability.js"
import { composeSubscriptionNotifications } from "../auth/subscription-notification-composition.js"
import { composeModuleProcessServices, createNotifySeam } from "./module-service-host.js"
import { containNotifyFailures } from "./contained-notify.js"
import { createGitAiAttributionService } from "../agent-runtime/git-ai-attribution-service.js"
import { createGitAiAttributionProjection } from "./git-ai-attribution-projection.js"
import { createCommandUsageProjection } from "./command-usage-projection.js"
import { createStreamingEditValidationService } from "../agent-runtime/tools/streaming-edit-validation.js"

import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import type { RuntimeChatKernel } from "./runtime-chat-kernel.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import { createRuntimeWorkSettlement, createSettledRuntimeDispatch, workflowSettlementOwners, type RuntimeWorkSettlement } from "./runtime-work-settlement.js"
import { readChatTurnEnd } from "../session/chat-session-run-evidence.js"
import { isResumableTurnEnd } from "../session/conversation/turn-end-record.js"
import type { MutationEvidenceService } from "./mutation-evidence-service.js"
import type { SessionChangesService } from "./session-changes-service.js"
const log = Log.create({ service: "runtime-composition" })

export interface RuntimeCompositionOptions extends StartupDirectories {
  /** Resolves an invocation completion port for its bound root only. */
  readonly rootChatCompletion?: RuntimeRunnerCapabilities["rootChatCompletion"]
  /** The account registry's label for this project, carried by every
   *  replacement blocker this composition reports. Defaults to the directory name. */
  readonly projectLabel?: string
  readonly chatDefault?: RuntimeChatDefault
  readonly notify?: (episode: NotificationEpisodeInput) => Promise<void>
  readonly workerUrl: string
  /** Launch authority of the generation this composition belongs to. Every
   *  process a tool starts is launched through it, so ending the generation
   *  ends what it launched. */
  readonly launcher: LauncherScope
  readonly persistentProcesses: PersistentProcessClient | BridgedPersistentProcessClient
  readonly allowPersistentProcesses: boolean
  /** The composition serves attached clients: the account service's project
   *  executor. Usage polling runs only there, and every other composition,
   *  such as headless chat, is headless: its shell offers no mutating
   *  declaration (PI-AGENT-119). */
  readonly interactive?: boolean
  /** Canonical active tools omitted from every runner and workflow admission in this run. */
  readonly disabledTools?: readonly string[]
  /** A headless run's own profile selector and auth snapshot. */
  readonly headlessAuth?: HeadlessAuthSelection
  /** Tells the account the project's earliest owed capacity time and
   *  resolves once it holds it. Absent where no account serves the project. */
  readonly recordCapacityWake?: (at: number | null) => Promise<void>
}

export interface RuntimeComposition {
  readonly bus: RuntimeChatKernel["bus"]
  readonly client: ReturnType<typeof createFlywheelAppService>
  /** Starts canonical default resolution after the output subscriber exists. */
  readonly startChatDefault: () => void
  readonly adoptBlankChat: RuntimeSupervisor["adoptBlankChat"]
  readonly workSettlement: RuntimeWorkSettlement
  /** The relay reverse transport registers its accept handler here, so a
   *  paired phone attaches to this composition through the same RPC server
   *  the local transport serves. */
  readonly transports: ModuleTransports
  /** This composition's contribution to the shutdown barrier its host runs: the
   *  admission it closes and, per phase, the owners it is the sole owner of. A
   *  host that owns more of a phase extends the owner array; it never runs a
   *  second barrier, because a nested barrier keeps running over the same
   *  resources after the outer one moved on. */
  readonly shutdown: RuntimeShutdownRequest
  /** What this project owns that is live, each with the reason that says
   *  whether it delays a replacement; empty means idle (PI-REMOTE-020). */
  blockers(): Promise<ReplacementBlocker[]>
  /** The account's replacement state, as its owner last published it. It
   *  only decides whether this project watches its own blocker changes: no
   *  client sees it, and no mutation is refused either way. */
  setReplacement(state: ReplacementState): void
  /** Told, coalesced, when this project's blockers may have changed while a
   *  replacement is held. */
  onBlockersChanged(listener: () => void): () => void
  /** A planned replacement's cut of this project: every running child, chat
   *  turn, and agent of a workflow is interrupted by the runtime with continuation
   *  authority for `handoffId`. Resolves with the sessions it interrupted. */
  interruptForReplacement(handoffId: string): Promise<readonly string[]>
  /** After this composition's stop, when a planned replacement's cut had
   *  begun: the continuation and handover rows the handoff holds in the
   *  project for the successor. */
  replacementSuccessorRows(): SuccessorRows | undefined
  /** The successor's half: attaches every chat the handoff handed a command
   *  to, which adopts it, then resumes every session `handoffId` authorized.
   *  Resolves with the sessions it resumed. */
  continueAfterReplacement(handoffId: string): Promise<readonly string[]>
  /** Once the executor has reported ready: adopts or settles every handed-over
   *  command that remains in the project. Never rejects. */
  adoptHandedOverCommands(): Promise<void>
  /** Continues every due capacity wait no run of this executor holds
   *  (`capacityContinuer`). Never rejects. */
  continueCapacityWaits(): Promise<CapacityContinuation>
  /** Drains the durable writers and stops no runner, for the executor's fatal
   *  path: the facts written before a fatal failure reach the store before
   *  the process exits. It is the same single settlement that the barrier's
   *  flush-durable-state phase joins, so a fatal failure during a stop drains
   *  the writers once. */
  flushDurableState(): Promise<void>
  /** The barrier's last phase for either host: close the event store, then hand
   *  back this project's state generation. The lease and the event-store runtime
   *  are each single-release, so the descriptor closes exactly once however many
   *  hosts hold this contribution. */
  releaseState(): Promise<void>
  /** Ordered graceful teardown. `clientsHold` is the stop's word on whether a
   *  client holds the project: each tab such a client shows attaches its
   *  session again, so the stop keeps every empty chat for it, and a stop
   *  that no client holds the project through removes them (ARCH-RUNTIME-024, PI-INTERACTION-075). */
  dispose(stop: { readonly clientsHold: boolean }): Promise<RuntimeShutdownResult>
}

/** Stall gates for the runtime thread: control-plane RPCs live on this loop,
 *  so every stall past the first bound is latency, observed at DEBUG with its
 *  attribution for measuring fairness between sessions on that thread. A
 *  stall past the second is a pause a person sees in typing or scrolling, and
 *  reaches the default level. The request timing facts attribute lag to each
 *  request. */
const RUNTIME_LOOP_STALL_OBSERVE_MS = 50
const RUNTIME_LOOP_STALL_WARN_MS = 250

/** Compose one project's runtime, owning everything it acquires until it can
 *  hand ownership to the caller. Construction after workspace preparation opens
 *  the event store, the module services, the background Worker lane, the runner
 *  pool, and the account-global availability authority, and none of them has a
 *  disposal closure yet: a throw from any await or constructor below hands back
 *  what is already open, newest first, and the state generation last. */
export async function assembleProjectRuntime(
  options: RuntimeCompositionOptions,
  createKernel: (scope: RuntimeOwnership, backgroundLane: ReturnType<typeof createRuntimeBackgroundLane>) => Promise<RuntimeChatKernel>,
): Promise<RuntimeComposition> {
  const timeline = createStartupTimeline({
    owner: "project-execution",
    context: { projectRoot: options.projectRoot, pid: String(process.pid) },
    stages: ["prepare", "kernel", "modules", "services"],
  })
  const scope = createRuntimeOwnership((err) => {
    log.warn("runtime composition cleanup failed", { error: errorMessage(err), errorDetail: errorDetail(err) })
  })
  let endStage: ReturnType<typeof timeline.begin> | undefined
  try {
    const result = await composeRuntime(options, scope, createKernel, (name) => {
      endStage = timeline.begin(name)
      return endStage
    })
    timeline.foregroundReady()
    timeline.finish()
    return result
  } catch (err) {
    endStage?.("failed")
    timeline.finish("failed", err)
    await scope.releaseAcquired()
    throw err
  }
}

async function composeRuntime(options: RuntimeCompositionOptions, scope: RuntimeOwnership, createKernel: (scope: RuntimeOwnership, backgroundLane: ReturnType<typeof createRuntimeBackgroundLane>) => Promise<RuntimeChatKernel>, beginStage: ReturnType<typeof createStartupTimeline>["begin"]): Promise<RuntimeComposition> {
  const endPrepare = beginStage("prepare")
  startupTrace("runtime composition start")
  const executionCwd = resolve(options.executionCwd)
  const projectRoot = resolve(options.projectRoot)
  const { userDataRoot, accountHome } = options
  const directories = { projectRoot, userDataRoot, accountHome } satisfies ProjectDirectories
  log.debug("runtime composition start", { projectRoot, executionCwd })
  ensureEventLoopLagSampler({ observeStallsFromMs: RUNTIME_LOOP_STALL_OBSERVE_MS, warnOnStallMs: RUNTIME_LOOP_STALL_WARN_MS })
  scope.own("persistent-process-client", options.persistentProcesses, (client) => { client.close() })
  const runtimeConfig = scope.own("runtime-config", await createRuntimeConfigOwner({ userDataRoot }), (owner) => owner.dispose())
  const { config: initialConfig, warnings: initialConfigWarnings } = runtimeConfig.snapshot()
  const initialProviderCandidate = buildCustomProvidersFromConfig(initialConfig.custom_providers)
  publishCustomProvidersFromConfig(initialProviderCandidate)
  logCustomProviderDiagnostics(initialProviderCandidate)
  if (initialConfigWarnings.length > 0) log.warn("runtime-config-normalized", { code: "runtime-config-normalized", count: initialConfigWarnings.length })
  // Every mutating and work-admitting root migrates the obsolete Learning
  // opt-out and builds its own capability projection before it can admit
  // optional work, so a direct or test construction never depends on the CLI.
  const started = await startModulePolicy({ userDataRoot }, runtimeConfig)
  if (started.migrationError) log.warn("learning-capability-migration-failed", { code: "learning-capability-migration-failed" })
  if (started.notice) log.warn("learning-capability-migrated", { code: "learning-capability-migrated" })
  const capabilities = started.policy
  const composeModules = createRuntimeModuleComposer(options.disabledTools)
  const moduleSelection = (): FirstPartyModuleComposition => composeModules(capabilities.state())
  if (moduleSelection().warnings.length > 0) log.warn("runtime-capability-module-warning", { code: "runtime-capability-module-warning", count: moduleSelection().warnings.length })
  log.debug("runtime capability modules composed", { moduleCount: moduleSelection().enabledModuleIds.length })
  // Installed owners admit their optional store recovery before definitions
  // open. The same operation gains the consent reader when the store is ready.
  const reconcileDefinitions = await prepareDefinitionReconciliation({ directories, capabilities })
  await reconcileDefinitions()
  // The workspace store is prepared before the registry is built: preparation
  // owns this project's state generation and migrates the legacy overlay
  // definitions inside that gate, so the registry below reads what it settled
  // on.
  // Construct the lazy lane before the executor kernel so every foreground
  // summary view shares it. Construction does not start its Worker.
  const backgroundClient = scope.own(
    "background-process-client",
    createProcessBackgroundClient({ workerUrl: options.workerUrl, logBase: projectRoot }),
    (owned) => owned.dispose(),
  )
  const backgroundLane = scope.own("background-lane", createRuntimeBackgroundLane(projectRoot, {
    createClient: (laneCwd) => backgroundClient.acquire(laneCwd),
  }), (lane) => lane.dispose())
  startupTrace("runtime background lane prepared")
  endPrepare()
  const endKernel = beginStage("kernel")
  const kernel = await createKernel(scope, backgroundLane)
  endKernel()
  const endModules = beginStage("modules")
  // Every definition root is observed before the registry reads it, so the
  // first load and the events after it cover every change without a
  // reconciliation pass. The command catalog names what a change runs.
  const skillRoots = skillStoreRoots(directories)
  const definitionWatch = scope.own("definition-root-watch", watchDefinitionRoots({ roots: definitionRoots(directories, skillRoots) }), (watch) => watch.dispose())
  // One owner per project: every definition read in this realm resolves through
  // it, so discovery, dispatch, and writes cannot disagree about the project.
  const definitions = createInstalledDefinitionRegistry({ ...directories, skillRoots })
  // Availability is derived from the complete registry and the live capability
  // projection, before any consumer of it exists. A settings change republishes
  // it, so the command roster and every new admission read one projection.
  const availability = await createDefinitionAvailability({ definitions, capabilities })
  scope.own("definition-availability-subscription", capabilities.onChange(() => { void availability.refresh() }), (unsubscribe) => { unsubscribe() })

  // One credential resolver per generation: a `!command` key runs its helper at
  // most once for everything composed below.
  const resolveKey = createKeyResolver(createOwnedCredentialCommandRunner(options.launcher))
  startupTrace("runtime definition registry created")
  const { runtime, eventReader, projectionReader, eventStore, eventWriter, manager, sessionStore, workflowHosts, keeper, bus, transcriptCache, projections } = kernel
  // A person's message to an agent of a workflow that they interrupted waits
  // while a module the run requires is off. Each selection change offers it to
  // the agent again, and the agent continues once its run is admitted (ARCH-RUNTIME-068, ARCH-WORKFLOWS-031).
  scope.own("workflow-held-messages", capabilities.onChange(() => { for (const id of workflowHosts.allIds()) void workflowHosts.get(id)?.continueHeldMessages() }), (unsubscribe) => { unsubscribe() })
  // Every completion sweep of this store, whoever starts it, states on the
  // parent whether its finished children can report back.
  scope.own("child-result-notices", routeChildResultNotices(eventReader, (sessionId, operation) => {
    sessionStore.updateEntry(sessionId, { noticeOperation: { operation, timestamp: Date.now() } })
  }), (unroute) => { unroute() })
  // The durable rows of this executor's capacity waits (ARCH-SESSIONS-039).
  // The ledger closes as the stop begins, so every wait the stop ends
  // continues in the next executor.
  const capacityWaits = scope.own("capacity-waits", registerCapacityWaits(eventReader, { reader: projectionReader, writer: eventWriter, ...(options.recordCapacityWake ? { recordWake: options.recordCapacityWake } : {}) }), (ledger) => { ledger.dispose() })
  // The handoff this executor heard lives in the replacement report, which is
  // composed after the app service, which needs the supervisor.
  const commandHandover = composeExecutorCommandHandover({ reader: eventReader, projectionReader, writer: eventWriter, launcher: options.launcher, userDataRoot, keeper })
  const streamingEditValidation = scope.own(
    "streaming-edit-validation", createStreamingEditValidationService(), (service) => service.dispose(),
  )
  scope.own("session-changes-publisher", createSessionChangesPublisher({ onStored: eventStore.onStored, publish: bus.publish, sessionPlacements: createSessionPlacements(projectionReader) }), (publisher) => { publisher.dispose() })
  const backgroundIndex = scope.own("background-index", composeBackgroundIndex({ reader: projectionReader, readSession: manager.read, onStored: eventStore.onStored, publish: bus.publish, sessionStore, onKeptChange: keeper.onChange }), (index) => { index.dispose() })
  // One service per enabled module, once per process, before any producer
  // can raise: the notify seam reads the live selection, so a module turned
  // off hears nothing and no kernel producer names one (ARCH-RUNTIME-048, ARCH-STRUCTURE-034).
  const transports = scope.own("module-transports", createModuleTransports(), (owner) => owner.dispose())
  const moduleServices = scope.own("module-services", composeModuleProcessServices(installedModules(), () => moduleSelection().enabledModuleIds, {
    transports, onFrontendEvent: (listener) => { bus.addListener(listener); return () => bus.removeListener(listener) },
    directories: { ...directories, executionCwd }, eventStore: eventReader, projectionReader, eventWriter, onStored: eventStore.onStored, publish: bus.publish, snapshotPosition: bus.snapshotPosition,
    sessionManager: manager, sessionStore, config: runtimeConfig, launcher: options.launcher,
    onSelectionChanged: (listener) => capabilities.onChange(() => {
      void (async () => { await listener() })().catch((error: unknown) => log.warn("module selection application failed", { error: errorMessage(error) }))
    }),
    profileAccounting: () => authRuntime, configView: () => configProjection.view(), moduleSelection, notify: (episode) => notify(episode), interactive: options.interactive === true,
    executionEnvironment: () => ({
      authAdmission: authRuntime.sessionAuthAdmission,
      recall: backgroundLane.recall,
      attachProjection: childSessionProjectionAttachment(sessionStore),
      deliverNotification: attachedRunnerDelivery(sessionStore),
      openChatRunner: async (sessionId): Promise<ChatRunner | undefined> => await runtimeSupervisor.activateSession(sessionId) ? runtimeSupervisor.ensureChatRunner(sessionId) : undefined,
    }),
  }, options.notify !== undefined), (services) => services.dispose())
  moduleServices.reconcile()
  // The parent agent's controls of its own children (`process`). The
  // workflow host and the supervisor whose Interrupt they use are composed
  // after the runners that hold these controls, so each control reads them
  // when it runs.
  const childSessions = createChildSessionControl({
    manager, reader: eventReader, projectionReader, writer: eventWriter, projectRoot,
    modules: moduleServices.services, deliverNotification: attachedRunnerDelivery(sessionStore),
    hosts: () => moduleHosts,
    interrupt: (sessionId, address) => runtimeSupervisor.interruptSession(sessionId, "agent", address),
  })
  // The seam with its settlement: a forwarded delivery rejects when the
  // account service refuses it, the send fails, or no answer arrives.
  const settledNotify: (episode: NotificationEpisodeInput) => Promise<void> = options.notify ?? createNotifySeam(moduleSelection, () => moduleServices.services)
  const { notify } = scope.own("notification-delivery-failures", containNotifyFailures(settledNotify), (contained) => { contained.end() })
  const configProjection = scope.own("runtime-config-projection", createRuntimeConfigProjection({ owner: runtimeConfig, projectRoot, publish: bus.publish, notify }), (projection) => projection.dispose())
  const gitAiAttributionService = options.canonicalRepositoryRoot === undefined
    ? undefined
    : scope.own("git-ai-attribution-service", createGitAiAttributionService({ canonicalRepositoryRoot: options.canonicalRepositoryRoot, runOwnedCommand: ownedCommandRunner(options.launcher) }), (service) => service.dispose())
  const gitAiAttribution = scope.own("git-ai-attribution-projection", createGitAiAttributionProjection({ ...(gitAiAttributionService ? { service: gitAiAttributionService } : {}), publish: bus.publish }), (projection) => { projection.dispose() })

  const persistentPolicy = await persistentProcessPolicy({ userDataRoot, forcedByCli: options.allowPersistentProcesses, owner: runtimeConfig })
  // The permission in force at use time: the config file is re-read, so a
  // setting saved mid-session applies to the next launch.
  const effectivePersistent = async (): Promise<boolean> => (await persistentProcessPolicy({ userDataRoot, forcedByCli: persistentPolicy.forcedByCli, owner: runtimeConfig })).effective
  // The runtime's one capability publication and mutation owner: the config file
  // is the authority, the policy is its live projection, and this is the protocol
  // face of both. Nothing copies a selection out of it.
  const moduleProjection = scope.own("module-projection", await createModuleProjection({
    preparePublication: moduleServices.reconcile,
    location: { userDataRoot },
    capabilities,
    persistentProcesses: persistentPolicy,
    runtimeConfig,
    publish: bus.publish,
    notify,
    settlePublication: async () => { await availability.settled() },
  }), async (projection) => { await projection.dispose() })
  const definitionCatalog = loadBundledDefaultCatalog()
  const definitionBaselines = await createDefinitionOverrideBaselineOwner({ userDataRoot, resolutions: definitions.resolutions(), catalog: definitionCatalog })
  const definitionOverrides = createDefinitionOverrideService({
    catalog: definitionCatalog,
    baselines: definitionBaselines,
    load: async () => deriveDefinitionStalenessReport(definitions.resolutions(), definitionCatalog, definitionBaselines.records()),
  })
  await definitionOverrides.list()
  // A write in this realm publishes through the watch's ordered reload, so it
  // never waits for the file system to report it.
  const runtimeDefinitions = { ...definitions, definitionOverrides, publishNow: definitionWatch.reloadNow } satisfies ProjectDefinitionRegistry
  // One derivation of the Workflows mode for every reader: the model tool
  // surface, the launch boundary, and the Settings row cannot disagree.
  const workflowMode = (): WorkflowsMode => moduleProjection.workflowsMode()
  // The runtime owns the definition registries, so it owns the one definition
  // watcher: a reload republishes the roster clients render, and resolution of
  // any invocation stays in this realm.
  // Now that the claim ledger is readable, an operation this project can prove
  // the user confirmed is finished, and the watcher republishes the roster.
  await reconcileDefinitions(eventReader)
  const commandCatalog = scope.own("command-catalog", createCommandCatalogProjection({
    definitions: runtimeDefinitions,
    availability,
    moduleSelection,
    publish: bus.publish,
    watch: definitionWatch,
    beforeDefinitionsReload: async () => {
      const reconcile = await prepareDefinitionReconciliation({ directories, capabilities })
      await reconcile(eventReader)
    },
    onDefinitionsReloaded: async () => {
      await definitionBaselines.observe(definitions.resolutions())
      await definitionOverrides.refresh()
    },
  }), (catalog) => catalog.dispose())
  const commandUsage = scope.own("command-usage-projection", createCommandUsageProjection({ filePath: commandUsageFile(userDataRoot), publish: bus.publish }), (projection) => { projection.dispose() })
  startupTrace("runtime command catalog created")
  const authRuntime: AuthRuntime = scope.own("auth-runtime-core", await createAuthRuntime({
    userDataRoot,
    projectRoot,
    manager,
    capabilities,
    moduleSelection,
    bus,
    notify,
    settledNotify,
    resolveKey,
    own: (name, resource, dispose) => scope.own(name, resource, dispose),
    subscriptionUsageThresholds: () => [],
    interactive: options.interactive === true,
    sessionStore, workflowHosts, eventReader, eventWriter, availability, runtimeConfig,
    chatDefault: options.chatDefault ?? { kind: "pending" },
    persistentProcessesForcedByCli: options.allowPersistentProcesses,
    ...(options.headlessAuth === undefined ? {} : { headlessAuth: options.headlessAuth }),
    workflowPreparation: {
      userDataRoot,
      accountHome,
      definitions: runtimeDefinitions,
      moduleSelection,
      moduleServices: moduleServices.services,
      launcher: options.launcher,
      commandHandover: commandHandover.authority,
      childSessions,
      resolveKey,
      capabilities,
      persistentProcesses: options.persistentProcesses,
      allowPersistentProcesses: effectivePersistent,
      enforcedShellWriteGuard: shellWriteGuardObserver(runtimeConfig),
      ...(gitAiAttributionService ? { gitAiAttribution: gitAiAttributionService } : {}),
      streamingEditValidation,
      onNotification: notify,
      ...(options.interactive === true ? {} : { headless: true }),
    },
  }), (owner) => owner.disposeCore())
  const subscriptionUsage = authRuntime.subscriptionUsage
  const { subscriptionSpendConsentMaterializer } = composeSubscriptionNotifications(scope, {
    authRuntime,
    notify,
    projectRoot,
    bus,
    log,
    providerName: (providerId) => accessProviderRegistry(moduleSelection()).selection.shortName(providerId),
  })
  const authLogin = scope.own("auth-login", composeAuthLogin({
    auth: authRuntime,
    resolveKey,
    launcher: options.launcher,
    admit: capabilities.admit,
    log,
  }), (service) => service.dispose())
  startupTrace("runtime auth runtime created")
  scope.own("module-selection-subscription", runtimeConfig.subscribe("moduleSelection", async () => {
    await subscriptionUsage.refresh()
  }), (unsubscribe) => unsubscribe())
  scope.own("custom-providers-subscription", runtimeConfig.subscribe("custom_providers", async (snapshot) => {
    const candidate = buildCustomProvidersFromConfig(snapshot.config.custom_providers)
    publishCustomProvidersFromConfig(candidate)
    logCustomProviderDiagnostics(candidate)
    await moduleProjection.refresh()
    await subscriptionUsage.refresh()
  }), (unsubscribe) => unsubscribe())
  const sessionViewLoader = createSessionViewLoader({ reader: eventReader, projectionReader, writer: eventWriter })

  startupTrace("runtime session view loader created")
  const onRunnerError = (_id: string, message: string): void => {
    Log.Default.warn("runner error", { error: message })
  }
  const workflows = createLazyWorkflowController({
    create: async () => {
      const { createWorkflowController } = await import("../workflow-host/controller.js")
      return createWorkflowController({
        sessionStore,
        workflowHosts,
        openChatRunner: async (sessionId) => await runtimeSupervisor.activateSession(sessionId) ? runtimeSupervisor.ensureChatRunner(sessionId) : undefined,
        manager,
        ...directories,
        definitions: runtimeDefinitions,
        capabilities,
        composeModules,
        availability,
        workflowMode,
        onRunnerError,
        eventReader,
        projectionReader,
        eventWriter,
        recall: backgroundLane.recall,
        authAdmission: authRuntime.sessionAuthAdmission,
        reconcileChildSessionCompletions: (parentSessionId) => runtimeSupervisor.reconcileChildSessionCompletions(parentSessionId),
      })
    },
  })
  startupTrace("runtime workflow proxy created")
  scope.own("startup-recovery", queueStartupRecovery(manager, log), (cancel) => { cancel() })
  let changesService: Promise<SessionChangesService> | undefined
  const sessionChanges = () => {
    changesService ??= import("./session-changes-service.js").then(({ createSessionChangesService }) => createSessionChangesService({ reader: eventReader, projectionReader, writer: eventWriter, manager, projectRoot }))
    return changesService
  }
  let evidenceService: Promise<MutationEvidenceService> | undefined
  const mutationEvidence = () => {
    evidenceService ??= import("./mutation-evidence-service.js").then(({ createMutationEvidenceService }) => createMutationEvidenceService({ reader: eventReader, manager, projectRoot }))
    return evidenceService
  }
  const runnerCapabilities = Promise.resolve<RuntimeRunnerCapabilities>({
    rootChatCompletion: options.rootChatCompletion,
    runnerLoader: createChatRunnerLoader({ authAdmission: authRuntime.sessionAuthAdmission }),
    definitions: runtimeDefinitions,
    moduleSelection,
    proactiveCompactionThreshold: () => runtimeConfig.snapshot().config.proactive_compaction_threshold,
    idleCompaction: createIdleCompactionPolicy(runtimeConfig),
    moduleServices: moduleServices.services,
    workflowMode,
    capabilities,
    startWorkflow: workflows.startWorkflow,
    launcher: options.launcher,
    commandHandover: commandHandover.authority,
    childSessions,
    resolveKey,
    authAdmission: authRuntime.sessionAuthAdmission,
    subscribeProfiles: (listener) => runtimeConfig.subscribe("profiles", listener),
    persistentProcesses: options.persistentProcesses,
    allowPersistentProcesses: effectivePersistent,
    recall: backgroundLane.recall,
  })
  // What the stop that disposes this composition says, read once that stop
  // reaches the supervisor. A teardown that no stop asked for, the rollback
  // of a startup that failed, knows nothing of the clients, so it keeps
  // every empty chat, as an executor whose service went away does.
  let clientsHold = true
  // The one set of continuation lanes of this executor: the supervisor's
  // cut and its Interrupt of every session, and the successor's resume each
  // take their session's turn here.
  const continuationLanes = createContinuationLanes()
  // The hosts that run module-owned work here: the workflow controller
  // commits launches that parents accepted, and stops launched workflows.
  const moduleHosts = composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, workflows)])
  const retainedOperations = bindRetainedOperations({ reader: projectionReader, writer: eventWriter, hosts: moduleHosts })
  const runtimeSupervisor = scope.own("runtime-supervisor", createRuntimeSupervisor({
    undoChanges: async (request, signal) => (await sessionChanges()).undo(request, signal),
    transcriptCache, sessionStore, manager, workflowHosts,
    directories,
    runtime, projectionReader, sessionViewLoader,
    runnerCapabilities: () => runnerCapabilities,
    authProfileId: authRuntime.newSessionProfileId,
    onRunnerError,
    resumeWorkflow: workflows.resumeWorkflow,
    retainedOperations,
    sessionStops: bindSessionStops({ hosts: moduleHosts, modules: moduleServices.services, reader: eventReader, projectionReader, writer: eventWriter, projectRoot, read: manager.read, deliverNotification: attachedRunnerDelivery(sessionStore) }),
    reconcileChildSessionCompletions: (parentSessionId, sweep) => reconcileChildSessionCompletions({
      parentSessionId,
      reader: eventReader,
      projectionReader,
      writer: eventWriter,
      ...sweep,
    }),
    lifecycle: { settleSessionStore: async (causeOf) => { await workflowHosts.disposeAll(causeOf); await scope.settle("session-store") }, settleAuthAdmission: () => scope.settle("auth-session-admission") },
    replacementHandoff: commandHandover.authority.handoffId,
    onReplacementStop: commandHandover.stopBegan,
    keeper,
    continuationLanes,
    clientsHold: () => clientsHold,
  }), (supervisor) => supervisor.disposeAll())
  startupTrace("runtime supervisor created")
  const commandInvoke = createCommandInvokeService({
    catalog: commandCatalog, availability, moduleSelection, manager, sessionStore,
    supervisor: runtimeSupervisor, projectionReader, eventWriter, directories, authDirectory: () => authRuntime.activeProfile().directory,
    runOwnedCommand: ownedCommandRunner(options.launcher),
  })

  const moduleProtocol = scope.own("module-protocol-runtimes", composeModuleProtocolRuntimes(installedModules(), {
    eventStore: eventReader,
    projectionReader,
    eventWriter,
    manager,
    sessionStore,
    interruptSession: (sessionId) => runtimeSupervisor.interruptSession(sessionId, "person"),
    definitions: runtimeDefinitions,
    onStored: eventStore.onStored,
    publish: bus.publish,
    snapshotPosition: bus.snapshotPosition,
    hasLiveSession: projections.projection.hasLiveSession,
    openChatRunner: async (sessionId) => await runtimeSupervisor.activateSession(sessionId) ? runtimeSupervisor.ensureChatRunner(sessionId) : undefined,
    background: backgroundLane.moduleSnapshot,
    modules: workflowRunOwner().protocolServices({ modules: moduleServices.services, projectRoot, controller: workflows, auth: authRuntime.workflowAuth, authStatus: authRuntime.authStatusProjection, supervisor: runtimeSupervisor, deletion: manager, bus, hosts: workflowHosts }),
  }, () => moduleSelection().enabledModuleIds, options.notify !== undefined), (owned) => { owned.dispose() })
  startupTrace("runtime frontend projection created")
  endModules()
  const endServices = beginStage("services")
  const deps = {
    ...projections,
    roleProjection: composeRoleProtocolProjection(scope, { manager, bus, onProfilesChanged: (onChange) => runtimeConfig.subscribe("profiles", onChange), onStored: eventStore.onStored, publish: bus.publish, reader: projectionReader, userDataRoot, capture: async (sessionId) => (await authRuntime.sessionAuthAdmission.admit(sessionId)).workflowDeps.captureProviderConnection(), definitions: runtimeDefinitions }),
    projectionReader,
    moduleProtocol,
    projectRoot,
    chatDefault: authRuntime.chatDefault.current,
    authStatusProjection: authRuntime.authStatusProjection,
    commandCatalog,
    commandUsage,
    sessionChanges,
    mutationEvidence,
    backgroundIndex,
    modelAssignments: authRuntime.modelAssignments,
    backgroundLane,
    authProfileSelection: { ...authRuntime.authProfileSelection, settle: authRuntime.settle },
    authLogin,
    subscriptionSpendConsent: { mutate: authRuntime.mutateSubscriptionSpendConsent },
    providerModels: authRuntime.providerModels,
    scheduleCatalogRefresh: authRuntime.scheduleCatalogRefresh,
    capabilities: moduleProjection,
    config: configProjection,
    gitAiAttribution,
    commandInvoke,
    runtimeSupervisor,
    warmTools: async () => { await (await import("../agent-runtime/tools/bash-parser.js")).warmBashParser() },
    publishReferences: async () => (await import("../../workflows/definitions/installer.js")).publishBundledReferences(userDataRoot),
    bus,
  } satisfies FlywheelAppServiceDeps
  startupTrace("runtime app-service deps created")
  // Acquired here, before this composition accepts a request: the durable
  // availability authority opens its file and creates an absent schema in the
  // composition lifecycle, so no client build and no selection pays for it.
  scope.own("provider-availability", acquireSharedProviderAvailability(userDataRoot, installedAccessProviderIds()), () => disposeSharedProviderAvailability())
  startupTrace("runtime availability authority acquired")
  const client = createFlywheelAppService(deps)
  startupTrace("runtime app service created")
  moduleServices.start()
  void gitAiAttribution.check()
  // The startup summary is the composition's one default-level record.
  log.debug("runtime composition done", { projectRoot })

  const { "stop-runners": runnerOwners = [], "flush-durable-state": durableStateOwners = [], "close-client-streams": clientStreamOwners = [] } = client.shutdown.owners

  const ownershipOwners = completeProjectExecutionOwnership(scope, {
    hasAttributionService: Boolean(gitAiAttributionService),
    stateReleaseResources: kernel.stateReleaseResources,
  })
  endServices()
  const requireOwner = (owners: readonly RuntimeShutdownOwner[], name: string) => {
    const owner = owners.find((candidate) => candidate.owner === name)
    if (owner === undefined) throw new Error(`Runtime shutdown owner '${name}' is missing`)
    return owner
  }
  const durableStateOwner = requireOwner(ownershipOwners["flush-durable-state"] ?? [], "durable-state")
  const projectStateOwner = requireOwner(ownershipOwners["release-state"] ?? [], "project-state-generation")

  const replacement = createReplacementReport({
    projectRoot, projectLabel: options.projectLabel, client, sessionStore, runningWorkflows: workflowHosts.allIds,
    listMetadata: () => manager.listMetadata(), runningChildren: () => liveChildRuns(eventReader), keptSessions: keeper.sessions,
  })
  const workSettlement = createRuntimeWorkSettlement({
    client, ...workflowSettlementOwners(workflowHosts, eventReader),
    awaitAcceptedWork: runtimeSupervisor.awaitAcceptedWork,
    ownedSessionIds: () => [...runtimeSupervisor.ownedSessionIds(), ...sessionStore.allIds()],
    runningChildren: () => runningChildSessionIds(eventReader),
    keptSessions: keeper.sessions,
    pendingTurnSettlement: (sessionId) => { const entry = sessionStore.get(sessionId); return entry?.kind === "chat" ? entry.runner?.pendingTurnSettlement : undefined },
    backgroundWork: (sessionId) => sessionStore.get(sessionId)?.runner?.backgroundTasks,
    failed: (sessionId) => runtimeSupervisor.runtimeState(sessionId)?.kind === "failed",
    onLiveSessionRemoved: (listener) => onLiveSessionRemoved(eventReader, listener),
    requiresContinuation: async (sessionId, rootSessionId) => {
      const live = liveSessionControl(eventReader, sessionId)
      if (live && await live.state() === "interrupted") return true
      const host = workflowHosts.get(sessionId)
      if (host) return Boolean(await host.cut())
      const session = await manager.read(sessionId)
      if (!session || session.kind === "workflow") return false
      if ((await Promise.all(retainedOperations.map((authority) => authority.read({ sessionId, conversationId: session.conversationId })))).some((cells) => cells.length > 0)) return true
      const end = (await readChatTurnEnd(projectionReader, session.conversationId))?.end
      return sessionId === rootSessionId ? isResumableTurnEnd(end) : end?.reason === "paused"
    },
  })
  commandHandover.hearThrough(replacement)
  const shutdown: RuntimeShutdownRequest = {
    closeAdmission: () => {
      capacityWaits.close()
      replacement.stop()
      subscriptionUsage.closeAdmission()
      subscriptionSpendConsentMaterializer.closeAdmission()
      moduleServices.closeAdmission()
      client.shutdown.closeAdmission?.()
    },
    owners: {
      ...client.shutdown.owners,
      "stop-runners": [
        ...runnerOwners.filter((owner) => owner.owner !== "session-runners"),
        ...(ownershipOwners["stop-runners"] ?? []),
      ],
      "flush-durable-state": [
        ...durableStateOwners.filter((owner) => owner.owner !== "history-projection"),
        ...(ownershipOwners["flush-durable-state"] ?? []),
      ],
      "dispose-availability": ownershipOwners["dispose-availability"] ?? [],
      "close-client-streams": [
        ...clientStreamOwners.filter((owner) => owner.owner !== "frontend-projection"),
        ...(ownershipOwners["close-client-streams"] ?? []),
      ],
      "release-state": ownershipOwners["release-state"] ?? [],
    },
  }

  const dispatch = createSettledRuntimeDispatch({ manager, sessionStore, eventReader, client, supervisor: runtimeSupervisor, settlement: workSettlement })
  return {
    bus,
    client: { ...client, dispatch },
    startChatDefault: authRuntime.chatDefault.start,
    adoptBlankChat: runtimeSupervisor.adoptBlankChat,
    workSettlement,
    transports,
    shutdown,
    blockers: replacement.blockers,
    setReplacement: replacement.set,
    onBlockersChanged: replacement.onChange,
    // The cut can reach this executor before the `draining` state does.
    interruptForReplacement: (handoffId) => { replacement.hear(handoffId); return runtimeSupervisor.interruptForReplacement(handoffId) },
    replacementSuccessorRows: () => runtimeSupervisor.replacementSuccessorRows(),
    continueAfterReplacement: (handoffId) => continueAfterReplacement({ reader: eventReader, projectionReader, writer: eventWriter, manager, supervisor: runtimeSupervisor, keep: commandHandover.keep, lanes: continuationLanes, dispatch: client.dispatch, resumePlannedWorkflow: (sessionId) => workflows.resumeWorkflow(sessionId, WHOLE_WORKFLOW, { wake: "planned" }), handoffId, settled: projections.statusProjection.refresh }),
    adoptHandedOverCommands: () => sweepCommandHandovers({ ...commandHandover, manager, supervisor: runtimeSupervisor }),
    continueCapacityWaits: capacityContinuer({ projectionReader, liveStore: eventReader, manager, ledger: capacityWaits, lanes: continuationLanes, dispatch: client.dispatch, workflows, settled: projections.statusProjection.refresh }),
    flushDurableState: () => durableStateOwner.settled(),
    releaseState: () => projectStateOwner.settled(),
    dispose: (stop) => {
      clientsHold = stop.clientsHold
      return runRuntimeShutdownBarrier(shutdown)
    },
  }
}

