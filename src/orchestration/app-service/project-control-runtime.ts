import { createHash, randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import type { LauncherContext } from "../../infra/process-supervisor.js"
import type { PersistentProcessManager } from "../../infra/persistent-process-manager.js"
import { createProcessTemporaryDirectory, removeProcessTemporaryDirectory } from "../../infra/process-temporary-directory.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import type { LoginShellPath } from "../../infra/login-shell-path.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { createStartupTimeline } from "../../infra/startup-timeline.js"
import { AuthProfileManager } from "../auth/auth-profile-manager.js"
import { createRuntimeConfigOwner } from "../config/runtime-config-owner.js"
import { persistentProcessPolicy } from "../config/persistent-process-policy.js"
import { installedModules } from "../module-catalog.js"
import { composeRealmModuleSnapshot } from "../modules.js"
import type { AccountProjectRegistry } from "./account-project-registry.js"
import type { CapacityWakeResult } from "./capacity-wakes.js"
import { createProjectControlClient } from "./project-control-client.js"
import { createOutputWatches } from "./output-watches.js"
import { ProjectExecutionChannelDetached, ProjectExecutionStopping } from "./project-execution-channel.js"
import { createProjectExecutorClient } from "./project-executor-client.js"
import type { ProcessorAdmission } from "./processor-governor.js"
import type { SuccessorRows } from "./project-executor-protocol.js"
import { createProjectExecutorGenerations, executionAskerOf, readAskerOf, type ProjectExecutorGeneration } from "./project-executor-generations.js"
import { spawnProjectStateWorker } from "./project-state-worker-spawner.js"
import type { ProjectStateStandby } from "./project-state-standby.js"
import { createModuleTransports } from "./module-transports.js"
import { composeAccountProjectModuleServices, createNotifySeam, type AccountModuleFaults } from "./module-service-host.js"
import { composeAccountModuleProtocolRuntimes } from "./module-protocol-host.js"
import { containNotifyFailures } from "./contained-notify.js"
import { createRuntimeUiBus } from "./runtime-ui-bus.js"
import { runtimeReadAnchor } from "./runtime-ui-patch-sequencer.js"
import { runningDisplayBuildId } from "./runtime-executable.js"
import { createRuntimeOwnership } from "./runtime-ownership.js"
import { runRuntimeShutdownBarrier } from "./runtime-shutdown.js"
import { createRuntimeBackgroundLane, serveRuntimeBackgroundQuery } from "./runtime-background-lane.js"
import type { MaintenanceQueue } from "./runtime-maintenance-owner.js"
import { serveProjectStateChannel } from "./project-state-channel.js"
import { createMessagePortProcessEndpoint } from "../../infra/internal-process-channel.js"
import type { RuntimeBackgroundClient } from "./worker-background-client.js"
import type { FrontendEvent, FrontendMutation, MutationResult, RuntimeChatDefault, RuntimeQuery, RuntimeQueryResult } from "../../protocol/app-service-types.js"
import type { StartupReached } from "../../protocol/startup-steps.js"
import type { ReplacementBlocker, ReplacementBlockerReason } from "./replacement-blockers.js"
import type { SessionHoldGrace } from "./session-holds.js"
import type { ReplacementState } from "./replacement-owner.js"
import type { SettledControlUiAssetState } from "./web-serving/control-ui-assets.js"
import type { ProjectControlExecutor, ProjectServiceState, ProjectUpdates } from "./project-control-client.js"
import type { BuildProof } from "../update/build-fallback.js"
import type { RuntimeFaultReporter } from "./runtime-fault-reporting.js"
import { createSessionAutoDelete } from "./session-auto-delete.js"

export interface ProjectControlRuntimeOptions {
  readonly reportFault?: RuntimeFaultReporter
  readonly readServiceFaultReport?: () => string | undefined
  readonly onStartupStep?: (reached: StartupReached) => void
  readonly directories: StartupDirectories
  readonly launcher: LauncherContext
  readonly persistentProcesses: PersistentProcessManager
  readonly allowPersistentProcesses: boolean
  readonly workerUrl: string
  /** The account service's pre-started state Worker, which the first open takes. */
  readonly stateStandby?: Pick<ProjectStateStandby, "take">
  readonly createBackgroundClient: (projectRoot: string) => RuntimeBackgroundClient
  readonly registry: AccountProjectRegistry
  readonly version: string
  readonly predecessorPids?: readonly number[]
  readonly releaseForHandoff?: () => Promise<boolean>
  /** Acquisition stays real; tests can hold a private endpoint before it accepts execution. */
  readonly listen?: Parameters<typeof createProjectExecutorClient>[0]["listen"]
  /** The period each executor generation sends its heartbeat in and the
   *  account counts missed heartbeats in. The production period applies when
   *  absent; tests shorten it, and with it the wedge bound of thirty periods. */
  readonly executorHeartbeatIntervalMs?: number
  /** The account's replacement owner, as this project reaches it: the state
   *  every executor generation is told, the report that its blockers may
   *  have changed, and the handoff row the account keeps for this project.
   *  Absent in a composition no account serves. */
  readonly replacement?: {
    readonly state: () => ReplacementState
    readonly changed: () => void
    /** Adds this project to the handoff the state names, so the successor
     *  continues whatever this project's executor stops with. */
    readonly joinHandoff: () => Promise<void>
    /** This project's executor stopped after the handoff's cut and counted
     *  the continuation and handover rows the handoff holds here. */
    readonly stopped: (rows: SuccessorRows) => Promise<boolean>
  }
  /** Whether a client holds the project now: the account's surface
   *  registrations, which each executor stop sends, so that the stop keeps
   *  or removes the project's empty chats (ARCH-RUNTIME-024, PI-INTERACTION-075). */
  readonly clientsHold: () => boolean
  /** The account's part in the grace of the session holds of a client
   *  connection that ended (ARCH-RUNTIME-023, PI-REMOTE-013). */
  readonly sessionHolds: SessionHoldGrace
  /** The account's one web client resolution, for the module services that
   *  serve the client beyond the account socket. Absent in a composition no
   *  account serves. */
  readonly webClient?: () => Promise<SettledControlUiAssetState>
  /** The account's report of the module services it could not start, which
   *  this project hands to its module services. Absent in a composition no
   *  account serves. */
  readonly accountModuleFaults?: AccountModuleFaults
  /** The account's update coordinator, whose one view this project serves. */
  readonly updates: ProjectUpdates
  /** The account service's report about itself, which this project serves. */
  readonly service: ProjectServiceState
  /** The account's login shell PATH, which every executor generation is told. */
  readonly loginShellPath: Pick<LoginShellPath, "watch" | "current" | "request">
  /** The account's one processor admission, which every executor generation
   *  of this project joins (ARCH-TOOLS-051). */
  readonly processorAdmission: ProcessorAdmission
  /** The account's capacity wakes of this project (ARCH-SESSIONS-039).
   *  Absent in a composition no account serves. */
  readonly capacityWakes?: {
    /** The earliest continue time of the project's capacity waits, or null
     *  for none, as an executor reported it; resolves once the account
     *  store holds it. */
    readonly report: (at: number | null) => Promise<void>
    /** A generation ended while the project stays open: the account arms
     *  the wake it holds for the project again, at once when it is due. */
    readonly rearm: () => void
  }
  /** The account's startup maintenance, which runs this project's job once
   *  its foreground is ready. */
  readonly maintenance: Pick<MaintenanceQueue, "project">
  /** The fallback of the account service's build, which every executor
   *  generation of this project tells whether it opened. Absent in a
   *  composition no account serves. */
  readonly buildProof?: BuildProof
}

/** Account-side ownership of the state Worker, public facade, module services, and background executor.
 * Resolves on state readiness. No execution composition is imported or constructed on this event loop. */
export async function createProjectControlRuntime(options: ProjectControlRuntimeOptions) {
  const { directories } = options
  const timeline = createStartupTimeline({
    owner: "project-control",
    context: { projectRoot: directories.projectRoot, pid: String(process.pid) },
    stages: ["state-spawn", "state-ready", "modules", "facade", "executor-ready"],
  })
  let endStage: ((outcome?: "ready" | "failed" | "incomplete") => void) | undefined
  const projectId = createHash("sha256").update(directories.userDataRoot).update("\0").update(directories.projectRoot).digest("hex").slice(0, 16)
  // The executor client's records name the project by this same id, so one
  // filter finds the account's control of a project and its executors' records.
  const log = Log.create({ service: "project-control-runtime" }).with({ projectId })
  const scope = createRuntimeOwnership((error) => log.error("project control rollback failed", { error: errorMessage(error) }))
  try {
    const config = scope.own("config", await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot }), (owner) => owner.dispose())
    // The public bus: every client holds what it last received or read, so an
    // equal whole-value repeat carries nothing and is not published.
    const bus = scope.own("bus", createRuntimeUiBus({ publishOnChange: true }), (owner) => owner.clear())
    const history = scope.own("history", createRuntimeBackgroundLane(directories.projectRoot, {
      createClient: options.createBackgroundClient,
    }), (owner) => owner.dispose())
    endStage = timeline.begin("state-spawn")
    options.onStartupStep?.({ step: "state-worker" })
    const stateOwner = spawnProjectStateWorker(directories, directories.executionCwd, options.workerUrl, options.onStartupStep, options.stateStandby, options.predecessorPids)
    let finishClose: (() => Promise<void>) | undefined = undefined
    const state = scope.own("state", stateOwner.acquire(), async (owner) => {
      // Keep the holder through durable flush so a normal successor cannot
      // enter early. Executor, maintenance, and module writers have joined
      // their committed acknowledgements; after a skip, close writes no facts.
      await finishClose?.()
      await owner.close()
    })
    endStage()
    // The job's writes reach this project's state Worker through the account,
    // as the account's own writes do, so the store keeps one writer.
    const maintenance = scope.own("maintenance", options.maintenance.project({
      directories,
      serveState: (port) => serveProjectStateChannel(state, createMessagePortProcessEndpoint({ port, decode: (value) => value }), { kind: "maintenance", projectId }),
    }), (job) => job.withdraw())
    const selection = () => composeRealmModuleSnapshot({ moduleIds: config.snapshot().config.modules })
    const enabled = () => selection().enabledModuleIds
    const failures: unknown[] = []
    const writes = new Set<Promise<void>>()
    const applyNotification = createNotifySeam(selection, () => services.services)
    // The executors' channel answers each delivery with this settlement,
    // every write settles before the module services that apply it close,
    // and a failed write also fails the durable shutdown result.
    const notify = (episode: NotificationEpisodeInput): Promise<void> => {
      const task = applyNotification(episode)
      const settled: Promise<void> = task.then(() => { writes.delete(settled) }, (error: unknown) => { failures.push(error); writes.delete(settled) })
      writes.add(settled)
      return task
    }
    // The account's own module producers do not act on a failed delivery.
    const accountNotify = scope.own("notification-delivery-failures", containNotifyFailures(notify), (contained) => { contained.end() })
    const onError = (error: unknown): void => {
      log.error("project control operation failed", { error: errorMessage(error) })
    }
    // Closing the project removes its sockets with the directory; a sweep of
    // `fw-ipc-<uid>` removes the directory of an account process that was killed.
    const endpointRoot = process.platform === "win32" ? undefined : await createProcessTemporaryDirectory("fw-ipc")
    scope.own("endpoints", endpointRoot, async (root) => { if (root) await removeProcessTemporaryDirectory(root) })
    if (endpointRoot && Buffer.byteLength(join(endpointRoot, "c.sock")) >= 104) {
      throw new Error("The system temporary directory is too long for private IPC. Set TMPDIR to a shorter owner-only directory.")
    }
    const nonce = randomUUID().slice(0, 8)
    const endpoint = (kind: string) => endpointRoot
      ? join(endpointRoot, `${kind}.sock`)
      : String.raw`\\.\pipe\flywheel-${projectId}-${nonce}-${kind}`
    // The registry's label is what every blocker names this project by; a
    // project on its first open is recorded after it opens, under this same
    // directory name.
    const projectLabel = (await options.registry.list()).find((project) => project.projectRoot === directories.projectRoot)?.label
      ?? (basename(directories.projectRoot) || directories.projectRoot)
    const projectBlocker = (reason: ReplacementBlockerReason): ReplacementBlocker => ({ projectRoot: directories.projectRoot, projectLabel, reason })
    let chatDefault: RuntimeChatDefault = { kind: "pending" }
    let publicClientAttached = false
    let stopping = false
    const executionListeners = new Set<(event: FrontendEvent) => void>()
    let repairOutput: (() => Promise<void>) | undefined
    // The statement to the generation that serves now. Each generation hears
    // the union when it starts to serve, before any call reaches it, and
    // again at each change.
    let stateWatchedOutput: ((sessionIds: readonly string[]) => void) | undefined
    const outputWatches = createOutputWatches({ onUnionChange: (sessionIds) => stateWatchedOutput?.(sessionIds) })
    let resetExecution: (() => void) | undefined
    const startChatDefault = (record: ProjectExecutorGeneration): void => {
      if (record.ready) void record.owner.startChatDefault().catch(onError)
    }
    // The last replacement state sent to an executor, in the order sent. A
    // dispatch and the executor's stop wait for it, so a generation hears a
    // handoff before it serves input and before it is asked to stop.
    const replacementSent = createOrderedLane()
    /** Tells the live generation the account's replacement state. While a
     *  handoff exists, the project joins its row first, so the stop of this
     *  generation never writes a continuation row for a project the handoff
     *  does not name. A generation that is not ready hears it when it becomes
     *  ready; one that is gone has nothing to hold. */
    const syncReplacement = (record: ProjectExecutorGeneration): void => {
      const replacement = options.replacement
      if (!replacement || !record.ready || record.recovery) return
      const published = replacement.state()
      void replacementSent.run(async () => {
        if (published.kind === "draining") await replacement.joinHandoff()
        await record.owner.setReplacement(published)
      }).catch(onError)
    }
    // The executor spawns before the state Worker answers so its module imports
    // overlap the Worker's startup; its admission queues on the Worker, and the
    // executor client wires nothing the executor can act through until the
    // admission result is known. Owned here so a failed Worker handshake rolls the
    // spawned process back with everything acquired after it.
    const generations = scope.own("executor", createProjectExecutorGenerations({
      log,
      ...(options.reportFault === undefined ? {} : { reportFault: options.reportFault }),
      spawn: (next) => {
        const suffix = next === 1 ? "" : String(next)
        return createProjectExecutorClient({
          async admit() {
            startupTrace("executor generation admit start")
            const admission = await state.execution({ kind: "generation.admit", projectId, generation: next })
            if (admission.kind !== "ok") throw new Error("Executor write generation was not admitted")
            startupTrace("executor generation admitted")
          },
          directories, projectId, projectLabel, generation: next,
          endpoints: { control: endpoint(`c${suffix}`), state: endpoint(`s${suffix}`), output: endpoint(`o${suffix}`), lifecycle: endpoint(`l${suffix}`) },
          launcher: options.launcher, state, persistentProcesses: options.persistentProcesses,
          allowPersistentProcesses: options.allowPersistentProcesses,
          allowPersistentLaunch: async () => (await persistentProcessPolicy({ userDataRoot: directories.userDataRoot, forcedByCli: options.allowPersistentProcesses, owner: config })).effective,
          workerUrl: options.workerUrl, notify, chatDefault: () => chatDefault, loginShellPath: options.loginShellPath, clientsHold: options.clientsHold,
          processorAdmission: options.processorAdmission,
          ...(options.capacityWakes ? { onCapacityWake: options.capacityWakes.report } : {}),
          watchedOutput: outputWatches.union,
          ...(options.listen ? { listen: options.listen } : {}),
          ...(options.executorHeartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.executorHeartbeatIntervalMs }),
        })
      },
      serve(record, runtime) {
        const isCurrent = () => generations.current === record && !record.recovery
        const stopBlockerReports = record.owner.onBlockersChanged(() => { if (generations.current === record) options.replacement?.changed() })
        const stopRecovery = runtime.onOutputGap?.(async () => { if (isCurrent()) await repairOutput?.() })
        const unsubscribeExecution = runtime.subscribe((event) => {
          if (isCurrent()) for (const listener of executionListeners) listener(event)
        })
        const stateWatches = (sessionIds: readonly string[]): void => runtime.watchOutput?.(sessionIds)
        stateWatches(outputWatches.union())
        stateWatchedOutput = stateWatches
        if (publicClientAttached) startChatDefault(record)
        if (options.replacement && options.replacement.state().kind !== "none") syncReplacement(record)
        options.replacement?.changed()
        return () => {
          if (stateWatchedOutput === stateWatches) stateWatchedOutput = undefined
          unsubscribeExecution()
          stopRecovery?.()
          stopBlockerReports()
          // The waits the ended generation held live are owed again, and only
          // the account's wake asks a paused project for execution.
          if (!stopping) options.capacityWakes?.rearm()
        }
      },
      execution: (operation) => state.execution({ ...operation, projectId }),
      onReset: () => resetExecution?.(),
      changed: () => options.replacement?.changed(),
      replacementRequested: () => options.replacement?.state().kind === "requested",
      handoffRecovery: (rows) => options.replacement?.stopped(rows) ?? Promise.resolve(false),
      releaseForHandoff: options.releaseForHandoff,
      bus,
      ...(options.buildProof === undefined ? {} : { buildProof: options.buildProof }),
    }), async (owner) => {
      stopping = true
      await replacementSent.settled()
      await owner.close()
    })
    finishClose = generations.finishClose
    const endExecutor = timeline.begin("executor-ready")
    let foregroundReady = false
    let executorOutcome: "ready" | "failed" | undefined
    const completeExecutor = (outcome: "ready" | "failed") => {
      endExecutor(outcome)
      executorOutcome = outcome
      if (foregroundReady) timeline.finish(outcome)
    }
    void generations.current.owner.ready.then(
      () => completeExecutor("ready"),
      () => completeExecutor("failed"),
    )
    endStage = timeline.begin("state-ready")
    try {
      await state.capturePosition()
    } catch (error) {
      // A state Worker that ends before it serves is this build failing to
      // open the project, as an executor that ends before ready is: the
      // fallback counts it, so a source that cannot recover the store
      // returns the lane to its proved build (PI-UPDATES-008, PI-UPDATES-009).
      if (!state.available) options.buildProof?.failedToOpen()
      throw error
    }
    endStage()
    startupTrace("project state worker ready")
    endStage = timeline.begin("modules")
    options.onStartupStep?.({ step: "project-modules" })
    const transports = scope.own("transports", createModuleTransports(), (owner) => owner.dispose())
    const services = scope.own("modules", composeAccountProjectModuleServices(installedModules(), enabled, {
      directories, launcher: options.launcher.scope, projectRegistry: options.registry,
      readFaultReport: (source) => source === "service" ? options.readServiceFaultReport?.() : generations.failedReport(),
      ...(options.webClient === undefined ? {} : { webClient: options.webClient }),
      ...(options.accountModuleFaults === undefined ? {} : { accountModuleFaults: options.accountModuleFaults }),
      transports, eventStore: state, projectionReader: state, eventWriter: state.writer, onStored: state.onStored,
      publish: bus.publish, snapshotPosition: bus.snapshotPosition, notify: accountNotify.notify,
      onFrontendEvent(listener) { bus.addListener(listener); return () => bus.removeListener(listener) },
      onSelectionChanged: (listener) => config.subscribe("moduleSelection", listener),
    }), async (owner) => {
      await Promise.all(writes)
      await owner.dispose()
      if (failures.length) throw new AggregateError(failures, "Account notification durability failed")
    })
    services.reconcile()
    const unsubscribe = config.subscribe("moduleSelection", () => services.reconcile())
    scope.own("selection", unsubscribe, (stop) => stop())
    const routes = scope.own("routes", composeAccountModuleProtocolRuntimes(installedModules(), {
      modules: services.services, publish: bus.publish, snapshotPosition: bus.snapshotPosition,
    }, enabled), (owner) => owner.dispose())
    startupTrace("project modules composed")
    endStage()
    // A stopping executor runs no call it has not admitted, and it refuses
    // each call it reads rather than leave the call's outcome unknown, however
    // its stop began. A refused call is taken again once that generation has
    // ended, as a call sent after the end is taken: a person's input by the
    // generation that follows, and a read by the history, the generation a
    // restart starts, or for a transcript read, the generation it asks for.
    // Undefined means the call was refused.
    const onGeneration = async <A>(record: ProjectExecutorGeneration, call: (runtime: Awaited<ProjectExecutorGeneration["owner"]["ready"]>) => Promise<A>): Promise<{ readonly answer: A } | undefined> => {
      try {
        return { answer: await call(await record.owner.ready) }
      } catch (error) {
        if (!(error instanceof ProjectExecutionStopping)) throw error
        await record.owner.closed
        return undefined
      }
    }
    const onServing = async <A>(asker: ReturnType<typeof executionAskerOf>, call: (runtime: Awaited<ProjectExecutorGeneration["owner"]["ready"]>) => Promise<A>): Promise<A> => {
      for (;;) {
        if (stopping) throw new Error(PROJECT_CLOSING)
        const record = await generations.serving(asker)
        await replacementSent.settled()
        if (stopping) throw new Error(PROJECT_CLOSING)
        const taken = await onGeneration(record, call)
        if (taken) return taken.answer
      }
    }
    const dispatch = <C extends FrontendMutation>(command: C): Promise<MutationResult<C>> => onServing(executionAskerOf(command), (runtime) => runtime.dispatch(command))
    function query<Q extends RuntimeQuery>(request: Q): Promise<RuntimeQueryResult<Q>>
    // oxlint-disable-next-line eslint/no-inner-declarations -- overload keeps query/result discrimination at the runtime boundary
    async function query(request: RuntimeQuery): Promise<RuntimeQueryResult<RuntimeQuery>> {
      // Only the executor serves transcripts and mutation evidence, so these reads ask for a
      // generation as an open tab does, and fails with that ask (ARCH-RUNTIME-016).
      const asker = readAskerOf(request)
      for (;;) {
        const snapshotPosition = bus.snapshotPosition(runtimeReadAnchor(request.type))
        const record = generations.current
        const live = await record.started && !record.recovery
        if (!live && asker === undefined) {
          // A passive read waits for the recovery that is running and never starts another.
          await record.recovery?.attempt
          const historical = await serveRuntimeBackgroundQuery(history, request, snapshotPosition)
          if (historical !== undefined) return historical
        }
        const serving = live ? record : await generations.serving(asker)
        // A read is idempotent, so one its generation's end cut off is taken
        // again like a refused one: a detached call's outcome is unknown, and
        // the next pass finds the history or the generation that follows.
        const taken = await onGeneration(serving, (runtime) => runtime.query(request)).catch((error: unknown) => {
          if (error instanceof ProjectExecutionChannelDetached || serving.recovery) return undefined
          throw error
        })
        if (taken) return taken.answer
      }
    }
    const executionClient: ProjectControlExecutor = {
      onOutputGap(listener) {
        repairOutput = listener
        return () => { if (repairOutput === listener) repairOutput = undefined }
      },
      query,
      dispatch,
      hideSession: (sessionId) => generations.withdraw((runtime) => runtime.hideSession(sessionId)),
      subscribe(listener) {
        executionListeners.add(listener)
        return () => { executionListeners.delete(listener) }
      },
      async close() { executionListeners.clear() },
    }
    endStage = timeline.begin("facade")
    options.onStartupStep?.({ step: "project-runtime" })
    const client = scope.own("client", createProjectControlClient({
      state, executor: executionClient, directories,
      history,
      awaitGenerationRecovery: async () => {
        await generations.current.recovery?.attempt
      },
      executionPaused: () => generations.current.recovery !== undefined,
      restartScheduled: () => generations.restartScheduled,
      executorState: () => generations.state,
      onExecutionReset(listener) {
        resetExecution = listener
        return () => { if (resetExecution === listener) resetExecution = undefined }
      },
      executionCwd: directories.executionCwd, runtimeVersion: options.version, runtimeBuildId: runningDisplayBuildId(),
      authProfiles: new AuthProfileManager({ ...directories, config: () => config.snapshot().config }),
      chatDefault: () => chatDefault,
      setChatDefault: (value) => { chatDefault = value },
      onPublicSubscriptionChange(active) {
        publicClientAttached = active
        if (active) startChatDefault(generations.current)
      },
      accountModules: routes, bus, onError, updates: options.updates, service: options.service,
      endIfWedged: (input) => generations.endIfWedged(input),
      sessionHolds: options.sessionHolds,
    }), (owner) => owner.close())
    endStage()
    const autoDelete = scope.own("session-auto-delete", createSessionAutoDelete({
      config, sessions: state.sessions,
      deleteSession: async (sessionId, inactiveBefore) => {
        const result = await dispatch({ type: "session.delete", sessionId, inactiveBefore })
        if (!result.ok) throw new Error("Automatic session deletion failed")
        return result.sessionRemoved === true
      },
    }), (owner) => owner.dispose())
    scope.sequence("executor", "stop-runners", ["session-auto-delete", "client", "executor"])
    scope.shutdown("maintenance", "stop-runners")
    scope.sequence("account-modules", "flush-durable-state", ["selection", "modules", "notification-delivery-failures"])
    scope.sequence("account-views", "close-client-streams", ["history", "routes", "transports", "bus", "config"])
    scope.sequence("state-worker", "release-state", ["state", "endpoints"])
    const shutdown = { owners: scope.complete() }
    timeline.foregroundReady()
    foregroundReady = true
    if (executorOutcome) timeline.finish(executorOutcome)
    return {
      client, bus, transports,
      /** The sessions each client connection watches, which the protocol
       *  boundary states, drops, and filters `output.delta` by (ARCH-PROTOCOL-057). */
      outputWatches,
      /** Admits the work that waits for this project's foreground readiness:
       *  its module services and its startup maintenance (ARCH-RUNTIME-012). */
      admitDeferredWork: () => {
        services.start()
        maintenance.admit()
        autoDelete.start()
      },
      async blockers(): Promise<readonly ReplacementBlocker[]> {
        const hold = generations.replacementHold()
        if (hold === undefined) return []
        if (hold !== "live") return [projectBlocker(hold)]
        // An executor that misses its read before it reports any list has its
        // loop inside a call, so it counts as an admitted call.
        return (await generations.current.owner.blockers()) ?? [projectBlocker("call")]
      },
      syncReplacement: () => syncReplacement(generations.current),
      /** One half of a planned replacement's handoff in this project's
       *  executor: the cut before the old build stops, or the resume after
       *  the new one opens the project. A generation that is recovering from
       *  an exit runs nothing to cut; the next generation hears the handoff
       *  when it serves. A resume is the runtime's ask for execution, so a
       *  paused project restarts its executor within its restart backoff and
       *  resumes in the same call, unless a newer replacement is requested,
       *  whose successor then continues it. The resume waits on every
       *  generation that serves while the call lasts, so each one proven
       *  wedged meanwhile is ended: one still opening is followed by the
       *  restart the call waits for, and the end of a ready one fails the
       *  call, which the continuation duty tries again on its backoff. */
      async handoff(kind: "interrupt_for_replacement" | "continue_after_replacement", handoffId: string): Promise<readonly string[]> {
        if (kind === "continue_after_replacement") {
          const withdraw = new AbortController()
          void generations.endIfWedged({ signal: withdraw.signal, waiter: { kind: "continuation" } })
          try {
            return await (await generations.serving("runtime")).owner.handoff(kind, handoffId)
          } finally { withdraw.abort() }
        }
        const record = generations.current
        if (record.recovery) return []
        return record.owner.handoff(kind, handoffId)
      },
      /** The account's wake of this project at the continue time of its
       *  capacity waits (ARCH-SESSIONS-039): the runtime's ask for
       *  execution, so a project whose executor ended restarts it within its
       *  restart backoff, and then the serving executor continues every due
       *  wait that no run of it holds. The account records the earliest
       *  owed time the executor reports, and the result says whether a due
       *  wait is still owed and when a wait left for later is due. */
      async wakeForCapacity(): Promise<CapacityWakeResult> {
        const { pending, at, next } = await (await generations.serving("runtime")).owner.continueCapacityWaits()
        await options.capacityWakes?.report(at)
        return { owed: pending > 0, next }
      },
      dispose: () => {
        timeline.finish("incomplete")
        return runRuntimeShutdownBarrier(shutdown)
      },
    }
  } catch (error) {
    endStage?.("failed")
    timeline.finish("failed", error)
    await scope.releaseAcquired()
    throw error
  }
}

export type ProjectControlRuntime = Awaited<ReturnType<typeof createProjectControlRuntime>>

const PROJECT_CLOSING = "This project is closing."
