import { watch as watchDirectory, type FSWatcher } from "node:fs"
import { basename } from "node:path"
import { canonicalPathWithMissingTail } from "../../infra/canonical-path.js"
import type { ReplacementBlocker } from "./replacement-blockers.js"
import { createReplacementOwner, type ReplacementOwner } from "./replacement-owner.js"
import type { ServeLane } from "../../infra/cli-subprocess.js"
import { errorMessage } from "../../infra/error-message.js"
import { accountProjectDirectories, type AccountDirectories, type StartupDirectories } from "../../infra/directory-authorities.js"
import type { LauncherContext } from "../../infra/process-supervisor.js"
import type { PersistentProcessManager } from "../../infra/persistent-process-manager.js"
import { Log } from "../../infra/log.js"
import { ensureEventLoopLagSampler } from "../../infra/event-loop-lag.js"
import { ensureProcessMemorySampler } from "../../infra/process-memory.js"
import { createBackgroundLane } from "../../infra/ordered-lane.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { createStartupTimeline } from "../../infra/startup-timeline.js"
import { ownedCommandRunner } from "../../infra/owned-command.js"
import { accountProjectsDir, CURRENT_BUILD_LINK, globalConfigFile, projectWebPort, projectWebTokenPath } from "../../infra/paths.js"
import { ManagedRuntime, Effect, FiberSet, Layer, Redacted, Scope } from "effect"
import { RpcServer } from "effect/rpc"
import { layerMsgPack } from "../../protocol/rpc-msgpack.js"
import { NetAddress } from "effect/net"
import { Socket, SocketServer } from "effect/socket"

import type { RuntimeServiceState } from "../../protocol/app-service-types.js"
import { RuntimeProtocolRpc } from "../../protocol/runtime-protocol-schemas.js"
import type { AccountProjectRegistry, CapacityWakeStore, ReplacementHandoffStore } from "./account-project-registry.js"
import { createAccountProjectClone } from "./account-project-clone.js"
import { createAccountService } from "./account-service.js"
import { claimProjectServing } from "./project-serving-lane.js"
import { createReplacementHandoffs } from "./replacement-handoffs.js"
import { createCapacityWakes } from "./capacity-wakes.js"
import type { ServeHolds } from "./serve-lifetime.js"
import { createAccountSocketRouter } from "./account-socket-router.js"
import { createBunRawSocketServer, type BunRawSocketConnection } from "./bun-socket-rpc.js"
import type { ProjectServiceState } from "./project-control-client.js"
import { createProjectControlRuntime, type ProjectControlRuntime, type ProjectControlRuntimeOptions } from "./project-control-runtime.js"
import { createProcessorGovernor } from "./processor-governor.js"
import { createProjectRuntime, type ProjectRuntime } from "./project-runtime.js"
import { runtimeHandlers, type RuntimeHandlerOptions } from "./runtime-protocol-handlers.js"
import { runtimeProtocolSocketServer } from "./runtime-protocol-socket-server.js"
import { webSocketServerLayer } from "./web-socket-server.js"
import { createControlUiAssets, type ControlUiAssets } from "./web-serving/control-ui-assets.js"
import { serveControlUiStatic } from "./web-serving/control-ui-static.js"
import type { AccountHubOptions, Hub } from "./web-serving/hub.js"
import { startAccountWebAddresses, type AccountWebAddresses, type ProjectBrowserState } from "./account-web-addresses.js"
import { loadOrCreateToken } from "./web-serving/token-auth.js"
import { composeRealmModuleSnapshot } from "../modules.js"
import { createAccountModuleServiceOwner, type AccountModuleFaults, type AccountModuleService } from "./module-service-host.js"
import { createRuntimeConfigOwner } from "../config/runtime-config-owner.js"
import type { RuntimeShutdownResult } from "./runtime-shutdown.js"
import { createProcessBackgroundClient } from "./worker-background-client.js"
import { createMaintenanceQueue } from "./runtime-maintenance-owner.js"
import { createAccountUpdates, type AccountUpdates, type AccountUpdatesOptions } from "../update/account-updates.js"
import { createBuildFallback, type FallbackBuild } from "../update/build-fallback.js"
import type { ServiceSource } from "../../infra/source-snapshot.js"
import { createRuntimeFaultReporting, type RuntimeFaultReporter } from "./runtime-fault-reporting.js"

const log = Log.create({ service: "account-service-runtime" })
const PROJECT_IDLE_GRACE_MS = 30_000

function requireRuntimeRelease(result: RuntimeShutdownResult): void {
  if (result.kind === "settled") return
  throw new AggregateError(
    result.failures.map((failure) => failure.error),
    `Project shutdown blocked in ${result.phase}`,
  )
}

interface ProjectComposition {
  readonly composition: ProjectControlRuntime
  readonly browserState: ProjectBrowserState | undefined
  readonly openBrowser: () => Promise<string>
  readonly holdClient: () => () => void
  readonly held: () => boolean
  readonly dispose: () => Promise<void>
}

interface ProjectRuntimeHolder {
  current?: ProjectRuntime
}

export interface AccountServiceRuntime {
  readonly ready: Promise<void>
  /** Begins the work that can convert durable state, once the service's
   *  start is confirmed (ARCH-RUNTIME-015): it admits project opens, starts the
   *  account module services, and starts the update coordinator. Until then
   *  the service listens and answers, and an open waits. A module service
   *  that cannot start is recorded and contained, so the service keeps
   *  serving without it, and the module states the failure where its state
   *  shows. A later call does nothing, and so does a call once disposal
   *  began. */
  readonly openAdmission: () => void
  /** Every blocker across every open project, as they stand now; empty means
   *  the whole account is idle. */
  readonly blockers: () => Promise<readonly ReplacementBlocker[]>
  /** The account's one replacement state and the requests that move it. */
  readonly replacement: ReplacementOwner
  /** The successor's half of a planned replacement: consumes every handoff a
   *  predecessor of this lane left, resuming the work it interrupted with no
   *  client attached. Runs after the service is listening and never delays an
   *  attach. Each project a handoff names is retried until it has continued. */
  readonly continueReplacements: () => Promise<void>
  /** States what every project's clients should know about this service,
   *  in place of what it stated before (ARCH-PROTOCOL-025). The start of the installed
   *  service states its crash loop and the loop's end (ARCH-RUNTIME-042). */
  readonly reportService: (state: RuntimeServiceState) => void
  /** Stops the lane listener at once, which removes its socket path, and
   *  ends every admitted connection; what they started settles in the
   *  drain. The stop path calls it before it withdraws the identity record,
   *  because nothing may remove the socket path after that: a successor can
   *  bind the path as soon as nothing listens. Each project a client holds
   *  as it withdraws stays held until the project has stopped, because
   *  every client it disconnects attaches again. */
  readonly withdraw: () => void
  readonly dispose: () => Promise<void>
}

export interface AccountServiceRuntimeOptions extends AccountDirectories {
  /** The lane this service serves: its rendezvous, hub port, and remote identity. */
  readonly lane: ServeLane
  readonly socketPath: string
  readonly credential: Redacted.Redacted<string>
  readonly launcher: LauncherContext
  readonly persistentProcessManager: PersistentProcessManager
  readonly allowPersistentProcesses: boolean
  readonly workerUrl: string
  /** The state Worker that the serve command started before this runtime
   *  loaded; the first project open takes it. The serve command owns it and
   *  disposes a Worker that no open took. */
  readonly stateStandby?: ProjectControlRuntimeOptions["stateStandby"]
  readonly registry: AccountProjectRegistry & ReplacementHandoffStore & CapacityWakeStore
  readonly version: string
  /** How long a project stays open after its last client leaves. A shorter
   *  override also bounds the grace of the session holds of a client that
   *  left, which otherwise keeps its project open for twenty minutes, so a
   *  harness and the development lane close projects as soon as they ask. */
  readonly projectIdleGraceMs?: number
  /** Decides whether this service can retire after a newer installed build activates. */
  readonly retireIfSuperseded: (beforeRetire?: () => Promise<void>) => Promise<"busy" | "retiring">
  /** Answers a client's cutover request, which only the router receives. It
   *  weighs the build as `retireIfSuperseded` does and, for a dev service,
   *  its checkout's source, which the activation watch never weighs. */
  readonly answerCutover: (beforeRetire?: () => Promise<void>) => Promise<"busy" | "retiring">
  /** Begins this service's stop path once a requested replacement has no blockers left. */
  readonly retire: () => void
  /** How long the stop waits for a replacement's cut; the owner's own limit
   *  applies when absent. A harness shortens it. */
  readonly replacementCutLimitMs?: number
  /** Told how many connections the service admitted and how many projects are open. */
  readonly holds?: ServeHolds
  readonly startHub?: (options: AccountHubOptions) => Hub
  /** The web client's files, in place of the ones this runtime locates or,
   *  from a source checkout, builds. A harness supplies them to control how
   *  long the build takes. */
  readonly clientAssets?: ControlUiAssets
  /** Composes the account's update coordinator, which this runtime starts
   *  once its admission opens and disposes with itself. */
  readonly createUpdates?: (options: AccountUpdatesOptions) => AccountUpdates
  readonly recordTrustedAttach: (canonicalProjectRoot: string) => Promise<void>
  readonly prepareProject: (directories: StartupDirectories) => Promise<void>
  /** This service's login shell PATH, which every project executor is told (ARCH-RUNTIME-045). */
  readonly loginShellPath: ProjectControlRuntimeOptions["loginShellPath"]
  /** The snapshot a dev service runs from, and the refused source its entry
   *  ran the proved snapshot in place of (ARCH-DISTRIBUTION-030). Absent for a service
   *  that runs no snapshot. */
  readonly source?: Pick<ServiceSource, "snapshot" | "refusedSource">
}

/** Production account placement: one listener owns account admission, while
 * each accepted socket gets a fresh RPC protocol bound to its selected project
 * composition. No protocol layer or inbound stream is shared across clients. */
export async function createAccountServiceRuntime(options: AccountServiceRuntimeOptions): Promise<AccountServiceRuntime> {
  ensureEventLoopLagSampler({ observeStallsFromMs: 50, warnOnStallMs: 250 })
  ensureProcessMemorySampler()
  const backgroundClient = createProcessBackgroundClient({ workerUrl: options.workerUrl, logBase: options.accountHome })
  // Startup maintenance runs off the account's event loop, one project's job
  // at a time, and each job writes through its project's state Worker (ARCH-RUNTIME-044).
  const maintenance = createMaintenanceQueue({ workerUrl: options.workerUrl, guardian: options.launcher.guardian })
  // Update work is account-wide, so the account runs it once, with or without
  // an open project, and every project serves its one view (ARCH-RUNTIME-043).
  const updates = (options.createUpdates ?? createAccountUpdates)({
    userDataRoot: options.userDataRoot,
    accountHome: options.accountHome,
    workerUrl: options.workerUrl,
    guardian: options.launcher.guardian,
    ...(options.source?.refusedSource === undefined ? {} : { refusedSource: options.source.refusedSource }),
  })
  // Processor admission is machine-wide, so the account owns the one governor
  // and every executor generation of every project joins it (ARCH-TOOLS-051).
  const processorGovernor = createProcessorGovernor()
  const assets = options.clientAssets ?? createControlUiAssets({ run: ownedCommandRunner(options.launcher.scope) })
  // The service's report about itself is one value for the account, and every
  // open project serves it and publishes each change.
  const serviceListeners = new Set<(state: RuntimeServiceState) => void>()
  const accountModulesStarted = Promise.withResolvers<void>()
  const reportFault: RuntimeFaultReporter = async (fault, projectRoot) => {
    await accountModulesStarted.promise
    const work: Array<ReturnType<RuntimeFaultReporter>> = []
    for (const service of accountModuleServices) if (service.reportFault) work.push(service.reportFault(fault, projectRoot))
    const results = await Promise.all(work)
    return results.find((result) => result !== undefined)
  }
  const faultReporting = createRuntimeFaultReporting<RuntimeServiceState>({
    initial: { kind: "serving" }, report: reportFault,
    publish: (state) => { for (const listener of serviceListeners) listener(state) },
  })
  const serviceReport: ProjectServiceState = {
    state: faultReporting.state,
    subscribe(listener) {
      serviceListeners.add(listener)
      return () => { serviceListeners.delete(listener) }
    },
  }
  // The account module services, which start only once admission opens, and
  // the cause each module's service could not start with. The report is one
  // value for the account, and every open project hands it to its modules.
  let accountModuleServices: readonly AccountModuleService[] = []
  let moduleFaults: ReadonlyMap<string, string> = new Map()
  const moduleFaultListeners = new Set<() => void>()
  const accountModuleFaults: AccountModuleFaults = {
    fault: (moduleId) => moduleFaults.get(moduleId),
    subscribe(listener) {
      moduleFaultListeners.add(listener)
      return () => { moduleFaultListeners.delete(listener) }
    },
  }
  // The one replacement state for the account. Its blockers are read from
  // every project slot: a project still opening is itself a blocker, an open
  // one answers from its composition, and a closing or failed one holds nothing.
  const replacement = createReplacementOwner({ blockers: () => blockers(), handOff: (handoffId) => handoffs.handOff(handoffId), retire: options.retire, ...(options.replacementCutLimitMs === undefined ? {} : { cutLimitMs: options.replacementCutLimitMs }) })
  // The build this service runs proves itself when an executor of any
  // project reports ready, and leaves through the replacement owner when its
  // executors cannot open (ARCH-DISTRIBUTION-024).
  const fallbackBuild: FallbackBuild | undefined = options.lane === "installed"
    ? { lane: "installed", userDataRoot: options.userDataRoot }
    : options.source?.snapshot === undefined ? undefined : { lane: "dev", snapshot: options.source.snapshot }
  const buildProof = fallbackBuild === undefined ? undefined : createBuildFallback({ build: fallbackBuild, request: (trigger) => replacement.request(trigger) })
  const blockers = async (): Promise<readonly ReplacementBlocker[]> => {
    const registered = await options.registry.list()
    const label = (root: string): string => registered.find((project) => project.projectRoot === root)?.label ?? (basename(root) || root)
    const reports = await Promise.all([...projects.slots()].map(async ([root, slot]): Promise<readonly ReplacementBlocker[]> => {
      if (slot.state === "opening") return [{ projectRoot: root, projectLabel: label(root), reason: "opening" }]
      if (slot.state === "open") return slot.runtime.composition.blockers()
      return []
    }))
    return reports.flat()
  }
  // Both halves of a planned replacement (ARCH-RUNTIME-031, ARCH-RUNTIME-032): the cut this service
  // hands off, and the handoffs a predecessor left it.
  const handoffs = createReplacementHandoffs({
    lane: options.lane,
    registry: options.registry,
    openProjects: () => new Map([...projects.slots()].flatMap(([root, slot]) => slot.state === "open" ? [[root, slot.runtime] as const] : [])),
    open: (projectRoot) => projects.open(projectRoot, "replacement continuation"),
    awakeForPhone: (projectRoot) => accountModuleServices.some((service) => service.phoneKeepAwake?.held(projectRoot) === true),
    holdAwakeForPhone: async (projectRoot) => {
      await Promise.all(accountModuleServices.map((service) => service.phoneKeepAwake?.hold(projectRoot))).catch((error: unknown) => {
        log.warn("a continued project could not be held awake for the phone", { projectRoot, error: errorMessage(error) })
      })
    },
  })
  // The account's wakes of the projects whose agents wait for model
  // capacity (ARCH-SESSIONS-039): at its time, a project opens, and its
  // executor continues the waits.
  const capacityWakes = createCapacityWakes({
    lane: options.lane,
    store: options.registry,
    wake: async (projectRoot) => await (await projects.open(projectRoot, "capacity wake")).composition.wakeForCapacity(),
  })
  const clientIdentity = async (): Promise<string | undefined> => {
    const client = await assets.settle()
    return client.kind === "resolved" ? client.identity : undefined
  }
  const handlerOptions: RuntimeHandlerOptions = { version: options.version, clientIdentity }
  // Creates a project from a repository a paired device names; the account
  // service opens it as it opens any other.
  const projectClone = createAccountProjectClone({
    projectsRoot: accountProjectsDir(options.accountHome),
    registry: options.registry,
    run: ownedCommandRunner(options.launcher.scope),
    searchPath: () => options.loginShellPath.current(),
  })
  // Created with the account service, which starts its addresses at once.
  let webAddresses: AccountWebAddresses | undefined
  const projects = createAccountService<ProjectComposition>({
    canonicalizeProjectRoot: canonicalPathWithMissingTail,
    claimProject: (projectRoot) => claimProjectServing(projectRoot, options.lane),
    recordTrustedAttach: options.recordTrustedAttach,
    openProject: async (projectRoot, onStartupStep, exclusiveClaim, ownership) => {
      const timeline = createStartupTimeline({
        owner: "account-project",
        context: { projectRoot, pid: String(process.pid) },
        stages: ["defaults", "module-preparation", "control-runtime", "transports"],
      })
      let endStage: ((outcome?: "ready" | "failed" | "incomplete") => void) | undefined
      try {
      const directories = accountProjectDirectories(options, projectRoot)
      startupTrace("project open start")
      endStage = timeline.begin("defaults")
      onStartupStep({ step: "project" })
      await options.prepareProject(directories)
      endStage()
      startupTrace("project prepared")
      endStage = timeline.begin("module-preparation")
      onStartupStep({ step: "project-module-preparation" })
      await Promise.all(accountModuleServices.map((service) => service.prepareProject?.(projectRoot)))
      endStage()
      startupTrace("project modules prepared")
      endStage = timeline.begin("control-runtime")
      const runtimeHolder: ProjectRuntimeHolder = {}
      const predecessorPids = handoffs.predecessorPids(projectRoot)
      const { releaseForHandoff } = ownership
      const composition = await createProjectControlRuntime({
        directories,
        onStartupStep,
        launcher: options.launcher,
        persistentProcesses: options.persistentProcessManager,
        allowPersistentProcesses: options.allowPersistentProcesses,
        workerUrl: options.workerUrl,
        ...(options.stateStandby === undefined ? {} : { stateStandby: options.stateStandby }),
        createBackgroundClient: (root) => backgroundClient.acquire(root),
        registry: options.registry,
        version: options.version,
        predecessorPids: exclusiveClaim ? predecessorPids : [],
        releaseForHandoff: releaseForHandoff === undefined ? undefined
          : () => releaseForHandoff(() => handoffs.recoveryPending(projectRoot)),
        replacement: {
          state: () => replacement.state,
          changed: replacement.refresh,
          joinHandoff: () => handoffs.join(projectRoot),
          stopped: (rows) => handoffs.stopped(projectRoot, rows),
        },
        // Until the project runtime exists, no hold can be registered, and a
        // stop then, such as the rollback of a failed open, knows nothing of
        // the client that asked for the project, so it keeps every empty
        // chat (ARCH-RUNTIME-024).
        clientsHold: () => runtimeHolder.current?.held() ?? true,
        sessionHolds: { holdProject: () => runtimeHolder.current?.holdIfOpen(), projectIdleGraceMs: options.projectIdleGraceMs },
        webClient: assets.settle,
        updates,
        service: serviceReport,
        reportFault: (error) => reportFault(error, projectRoot),
        readServiceFaultReport: faultReporting.failedReport,
        accountModuleFaults,
        loginShellPath: options.loginShellPath,
        processorAdmission: processorGovernor,
        capacityWakes: {
          report: (at) => capacityWakes.report(projectRoot, at),
          rearm: () => { capacityWakes.rearm(projectRoot) },
        },
        maintenance,
        ...(buildProof === undefined ? {} : { buildProof }),
      })
      endStage()
      startupTrace("project control runtime created")
      const webClientReleases: Array<() => void> = []
      let browser: ManagedRuntime.ManagedRuntime<never, never> | undefined
      let browserStart: Promise<string> | undefined
      let browserState: ProjectBrowserState | undefined
      let browserClosing = false
      let transportStart: Promise<void> | undefined
      const projectRuntime = createProjectRuntime({
        projectRoot,
        idleGraceMs: options.projectIdleGraceMs ?? PROJECT_IDLE_GRACE_MS,
        blockers: () => composition.blockers(),
        onIdle: () => projects.close(projectRoot, "idle"),
        async closeEndpoint() {
          browserClosing = true
          await browserStart?.catch(() => {})
          await browser?.dispose()
          for (const release of webClientReleases.splice(0)) release()
        },
        async closeTransports() {
          await transportStart?.catch(() => {})
          await composition.transports.dispose()
        },
        runShutdownBarrier: async () => { requireRuntimeRelease(await composition.dispose()) },
      })
      runtimeHolder.current = projectRuntime
      const ensureTransports = (): Promise<void> => {
        transportStart ??= composition.transports.serve((_kind, listener) => {
          const releases: Array<() => void> = []
          const transport = ManagedRuntime.make(
            Layer.fresh(RpcServer.layer(RuntimeProtocolRpc)).pipe(
              Layer.provide(runtimeHandlers(composition, log, handlerOptions)),
              Layer.provide(Layer.fresh(runtimeProtocolSocketServer)),
              Layer.provide(layerMsgPack),
              Layer.provide(listener((open) => {
                while (releases.length < open) releases.push(projectRuntime.holdClient())
                while (releases.length > open) releases.pop()?.()
              })),
            ),
          )
          return {
            ready: transport.context().then(() => {}),
            async dispose() {
              try {
                await transport.dispose()
              } finally {
                for (const release of releases.splice(0)) release()
              }
            },
          }
        })
        return transportStart
      }
      const openBrowser = (): Promise<string> => {
        if (browserClosing) return Promise.reject(new Error("Project browser endpoint is closing"))
        browserStart ??= (async () => {
          browserState = undefined
          const webToken = await loadOrCreateToken(projectWebTokenPath(options.userDataRoot, projectRoot))
          const preferredWebPort = projectWebPort(projectRoot, (await options.registry.list()).map((project) => project.projectRoot))
          let webPort: number | undefined
          // The account answered at this address while the project slept;
          // the endpoint takes it over now.
          webAddresses?.release(projectRoot)
          const endpoint = ManagedRuntime.make(
            Layer.fresh(RpcServer.layer(RuntimeProtocolRpc)).pipe(
              Layer.provide(runtimeHandlers(composition, log, handlerOptions)),
              Layer.provide(Layer.fresh(runtimeProtocolSocketServer)),
              Layer.provide(layerMsgPack),
              Layer.provide(webSocketServerLayer({
                token: webToken,
                port: preferredWebPort,
                staticResponse: (request) => serveControlUiStatic(request, assets.prepare(), projectRoot),
                onListening: (listening) => { webPort = listening.port },
                onConnectionCountChanged: (open) => {
                  const runtime = runtimeHolder.current
                  if (!runtime) return
                  while (webClientReleases.length < open) webClientReleases.push(runtime.holdClient())
                  while (webClientReleases.length > open) webClientReleases.pop()?.()
                },
              })),
            ),
          )
          browser = endpoint
          try {
            await Promise.all([endpoint.context(), ensureTransports()])
            if (webPort === undefined) throw new Error("Project browser listener did not publish its port")
            if (browserClosing) throw new Error("Project browser endpoint is closing")
            return `http://127.0.0.1:${webPort}/#token=${encodeURIComponent(webToken)}`
          } catch (cause) {
            await endpoint.dispose()
            if (browser === endpoint) browser = undefined
            throw cause
          }
        })().then((link) => {
          browserState = { kind: "ready", link }
          return link
        }, (cause: unknown) => {
          browserStart = undefined
          if (!browserClosing) {
            browserState = { kind: "failed", error: `Browser endpoint could not start: ${errorMessage(cause)}` }
            log.warn("project browser endpoint failed", {
              projectRoot,
              kind: cause instanceof Error ? cause.name : typeof cause,
              code: cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : undefined,
            })
          }
          throw cause
        })
        return browserStart
      }
      const project: ProjectComposition = {
        composition,
        get browserState() { return browserState },
        openBrowser,
        holdClient: () => projectRuntime.holdClient(),
        held: () => projectRuntime.held(),
        dispose: () => projectRuntime.dispose(),
      }
      ownership.own(project)
      endStage = timeline.begin("transports")
      onStartupStep({ step: "project-transports" })
      await ensureTransports()
      endStage()
      composition.admitDeferredWork()
      timeline.foregroundReady()
      // Browser serving belongs to the open project, but its startup never
      // gates terminal admission. closeEndpoint joins this owned attempt.
      void openBrowser().catch(() => {})
      timeline.finish()
      return project
      } catch (error) {
        endStage?.("failed")
        timeline.finish("failed", error)
        throw error
      }
    },
    startHub: (service) => (webAddresses = startAccountWebAddresses({ lane: options.lane, service, registry: options.registry, assets, ...(options.startHub ? { startHub: options.startHub } : {}) })),
  })
  // A composition that fails after the hub started must not leave the hub
  // bound, able to request an open, while the failed start exits, nor keep
  // the watch it opened.
  let accountRootWatcher: FSWatcher | undefined
  try {
    // A malformed, refused, or unreadable flywheel.toml degrades the way a live
    // edit does: the service starts on defaults (or keeps the last valid
    // values) and each project publishes the malformed status to its clients.
    // The account's one directory watch below drives the rereads.
    const accountConfigOwner = await createRuntimeConfigOwner({ userDataRoot: options.userDataRoot, watch: false })
    let accountConfig = accountConfigOwner.snapshot().config
    let accountModulesAdmitted = false
    // Each step runs after the one before it settles, and a step that fails is
    // recorded and contained: the service keeps serving without its modules.
    const accountModuleReconciliation = createBackgroundLane(log, "account module")
    const applyToAccountModules = (step: () => void | Promise<void>): void => { accountModuleReconciliation.runInBackground("configuration", step) }
    // A module whose service cannot start is recorded once for that start, and
    // its fault stays in the report until a start of it succeeds.
    const accountModuleOwner = createAccountModuleServiceOwner({
      userDataRoot: options.userDataRoot,
      version: options.version,
      webClient: assets.settle,
      registry: options.registry,
      projects,
      projectClone,
      launcher: options.launcher,
      onStartFailure: (module, error) => log.warn("account module configuration could not be applied", { module, error: errorMessage(error) }),
    })
    const startAccountModules = async (): Promise<void> => {
      accountModulesAdmitted = true
      const start = await accountModuleOwner.reconcile(composeRealmModuleSnapshot({ moduleIds: accountConfig.modules }), accountConfig)
      accountModuleServices = start.services
      accountModulesStarted.resolve()
      const faults = new Map([...start.failures].map(([module, error]) => [module, errorMessage(error)] as const))
      const changed = JSON.stringify([...faults]) !== JSON.stringify([...moduleFaults])
      moduleFaults = faults
      if (changed) for (const listener of moduleFaultListeners) listener()
    }
    const accountConfigName = basename(globalConfigFile(options.userDataRoot))
    // Before admission opens, a changed configuration is recorded and starts
    // nothing; the start at admission reads it.
    const reconcileAccountModules = async (): Promise<void> => {
      accountConfig = (await accountConfigOwner.refresh()).config
      if (accountModulesAdmitted) await startAccountModules()
    }
    // The account process's one watch on its data root. A hint that names the
    // account config file fans out to every account-level reader, and each
    // rereads the file itself (ARCH-RUNTIME-058): the module services, and the update
    // coordinator's policy, so an edit made anywhere reaches the update view
    // without a check. A hint that names the `current` link starts the
    // retirement decision at once, so an activated build replaces this service
    // without a client's cutover or the build tick (ARCH-RUNTIME-031).
    accountRootWatcher = watchDirectory(options.userDataRoot, (_event, filename) => {
      if (filename === null) return
      if (String(filename) === CURRENT_BUILD_LINK) {
        void options.retireIfSuperseded().catch((error: unknown) => {
          log.warn("the activated build could not be checked; the build tick checks it again", { error: errorMessage(error) })
        })
        return
      }
      if (String(filename) !== accountConfigName) return
      updates.refreshPolicy()
      applyToAccountModules(reconcileAccountModules)
    })
    const bindings = new Map<BunRawSocketConnection, ManagedRuntime.ManagedRuntime<never, never>>()
    const bindingDisposals = new Set<Promise<void>>()
    // A socket holds the service from the moment its attach is admitted until
    // it closes, whatever it asked for. A liveness probe connects and closes
    // without a preface, and a client's launcher probes about a second before
    // the client itself attaches; counting the probe as a hold ended the dev
    // lane's startup grace and started its idle clock, which retired the
    // service before the client arrived. Holding only once a request was
    // answered let a source runtime's first client, whose answer waits on the
    // web client build, see the service retire under it.
    const admitted = new Set<BunRawSocketConnection>()
    const publishHolds = (): void => { options.holds?.setConnectionCount(admitted.size) }
    const router = createAccountSocketRouter<BunRawSocketConnection>({
      credential: options.credential,
      canonicalizeProjectRoot: canonicalPathWithMissingTail,
      send: async (connection, bytes) => { await connection.send(bytes) },
      admitted: (connection) => {
        admitted.add(connection)
        publishHolds()
      },
      answerCutover: options.answerCutover,
      answerRestart: (beforeRetire) => replacement.request({ kind: "restart requested" }, beforeRetire),
      client: assets.settle,
      moduleRequest: async (module, request, answer, withdrawn) => {
        await accountModulesStarted.promise
        await accountModuleOwner.serveRequest(module, request, answer, withdrawn)
      },
      openProject: async (projectRoot, intent, connection, onStartupStep) => {
        const project = await projects.open(projectRoot, intent === "browser" ? "browser" : "client attach", onStartupStep)
        const releaseProject = project.holdClient()
        if (intent === "browser") {
          try {
            await project.openBrowser()
            await assets.openable()
            return {
              receive: async () => {},
              release: releaseProject,
            }
          } catch (error) {
            releaseProject()
            throw error
          }
        }
        const singletonSocketServer = Layer.succeed(SocketServer.SocketServer, SocketServer.SocketServer.of({
          address: NetAddress.unixPathAddress(options.socketPath),
          run: <R, E, A>(handler: (socket: Socket.Socket) => Effect.Effect<A, E, R>) =>
            Effect.scopedWith((scope) =>
              Effect.gen(function*() {
                const fibers = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope))
                const runFork = yield* FiberSet.runtime(fibers)<R>()
                runFork(Effect.flatMap(Socket.Socket, handler).pipe(Effect.provide(connection.socketLayer)))
                return yield* Effect.never
              }),
            ),
        }))
        const protocol = ManagedRuntime.make(
          Layer.fresh(RpcServer.layer(RuntimeProtocolRpc)).pipe(
            Layer.provide(runtimeHandlers(project.composition, log, handlerOptions)),
            Layer.provide(Layer.fresh(runtimeProtocolSocketServer)),
            Layer.provide(layerMsgPack),
            Layer.provide(singletonSocketServer),
          ),
        )
        bindings.set(connection, protocol)
        try {
          await protocol.context()
        } catch (error) {
          bindings.delete(connection)
          releaseProject()
          await protocol.dispose()
          throw error
        }
        return {
          receive: (bytes) => connection.receive(bytes),
          release: () => {
            releaseProject()
            bindings.delete(connection)
            const disposal = protocol.dispose().finally(() => bindingDisposals.delete(disposal))
            bindingDisposals.add(disposal)
          },
        }
      },
    })
    // A project holds the serve from the moment its open is accepted until its
    // slot is gone; a failed open that kept no runtime holds nothing. Every slot
    // change can move the account's blockers, so the owner is told.
    const heldProjects = new Set<string>()
    projects.watch((projectRoot, slot) => {
      if (slot === undefined || (slot.state === "failed" && slot.runtime === undefined)) heldProjects.delete(projectRoot)
      else heldProjects.add(projectRoot)
      options.holds?.setProjectCount(heldProjects.size)
      replacement.refresh()
    })
    // The owner's state reaches every open project's executor on each change;
    // a project that opens later hears it when its executor becomes ready.
    replacement.subscribe(() => {
      for (const slot of projects.slots().values()) if (slot.state === "open") slot.runtime.composition.syncReplacement()
    })
    const server = createBunRawSocketServer({
      path: options.socketPath,
      onOpen: () => {},
      onData: async (connection, bytes) => {
        if ((await router.receive(connection, bytes)) === "rejected") connection.close()
      },
      onClose: (connection) => {
        router.close(connection)
        if (admitted.delete(connection)) publishHolds()
      },
    })
    // A client that the withdrawal disconnects attaches again, to the next
    // service or to this one's next start, and its tabs show what they showed.
    // So each project a client holds as the service withdraws stays held until
    // it has stopped, and its executor's stop keeps an empty chat for each such
    // tab (ARCH-RUNTIME-024, PI-INTERACTION-075). A project that no client holds stops as it sleeps.
    let withdrawalHolds: readonly (() => void)[] | undefined
    const withdraw = (): void => {
      withdrawalHolds ??= [...projects.slots().values()].flatMap((slot) => slot.state === "open" && slot.runtime.held() ? [slot.runtime.holdClient()] : [])
      server.close()
    }
    return {
      ready: server.ready,
      openAdmission() {
        if (!projects.openAdmission()) return
        applyToAccountModules(startAccountModules)
        capacityWakes.start()
        // The first check waits for the coordinator's own deferral, so neither
        // a first attach nor a first frame waits on it.
        updates.start(accountConfigOwner)
      },
      blockers,
      replacement,
      continueReplacements: () => handoffs.continueAll(),
      reportService(state) {
        faultReporting.update(state)
      },
      withdraw,
      async dispose() {
        // Withdraw before draining: the lane listener, the hub address, and
        // admission go first so a successor can start while bindings, module
        // services, and projects settle.
        withdraw()
        accountModulesStarted.resolve()
        await faultReporting.dispose()
        replacement.dispose()
        handoffs.dispose()
        capacityWakes.dispose()
        // Update work settles beside the drain, and disposal joins it whatever
        // the drain does, so no install or collection outlives the service.
        const updatesSettled = updates.dispose().catch((error: unknown) => {
          log.warn("account update work did not settle cleanly", { error: errorMessage(error) })
        })
        try {
          projects.closeAdmission()
          accountRootWatcher?.close()
          // A clone in progress stops with the service; its folder goes with it.
          await projectClone.dispose()
          await accountModuleReconciliation.settled()
          await server.dispose()
          await Promise.all([...bindings.values()].map((binding) => binding.dispose()))
          await Promise.all(bindingDisposals)
          bindings.clear()
          await projects.dispose()
          await maintenance.dispose()
          await backgroundClient.dispose()
          await accountModuleOwner.dispose()
        } finally {
          for (const release of withdrawalHolds ?? []) release()
          // Each closed generation continued its own containers; this
          // continues whatever a drain that failed left held.
          processorGovernor.dispose()
          await updatesSettled
        }
      },
    }
  } catch (error) {
    projects.closeAdmission()
    accountRootWatcher?.close()
    processorGovernor.dispose()
    throw error
  }
}
