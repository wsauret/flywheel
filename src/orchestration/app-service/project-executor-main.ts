import { connectInternalProcessChannel, type InternalProcessEndpoint } from "../../infra/internal-process-channel.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { processLoginShellPath } from "../../infra/login-shell-path.js"
import { exitAfter, installCrashPolicy, recordFatal, type UncaughtKind } from "../../infra/crash-policy.js"
import type { ShutdownSignal } from "../../infra/shutdown-signals.js"
import { createReattachableProcessEndpoint, type ReattachableProcessEndpoint } from "../../infra/reattachable-process-endpoint.js"
import { connectOwnedProcessBridge } from "../../infra/owned-process-bridge.js"
import { establishProcessPriority } from "../../infra/process-priority.js"
import { createProcessWatchdog, type ProcessWatchdog } from "../../infra/process-watchdog.js"
import { createInternalProcessSubchannel } from "../../infra/internal-process-subchannel.js"
import { connectPersistentProcessBridge } from "../../infra/persistent-process-bridge.js"
import { connectProjectStateChannel } from "./project-state-channel.js"
import { startReleaseMemorySampler } from "../../infra/startup-trace.js"
import { ensureProcessMemorySampler } from "../../infra/process-memory.js"
import { serveProjectExecutionChannel } from "./project-execution-channel.js"
import { connectProjectNotifyChannel } from "./project-notify-channel.js"
import { createProjectExecutionRuntime } from "./project-execution-composition.js"
import type { RuntimeComposition } from "./project-execution-runtime.js"
import { serveProjectExecutorLifecycle } from "./project-executor-lifecycle.js"
import { sharedProcessorClaims } from "../agent-runtime/tools/processor-claims.js"
import { listenForExecutorStopSignals } from "./executor-stop-signals.js"
import { RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS } from "./runtime-shutdown.js"
import {
  createProjectExecutorChannelSet,
  projectExecutorChannelLimits,
  projectExecutorReattachDelayMs,
  PROJECT_EXECUTOR_REATTACH_DEADLINE_MS,
  decodeProjectExecutorInitialization,
  encodeProjectExecutorCredential,
  type ProjectExecutorEndpointKind,
  type ProjectExecutorEvent,
} from "./project-executor-protocol.js"

/** What began an executor's stop: the account asked for it, the account went
 *  away without asking, or a stop signal arrived. The hard-exit clock's
 *  decision names the trigger as what armed it. */
type StopTrigger = "account stop" | "account gone" | `signal ${ShutdownSignal}`

const FATAL_FLUSH_BOUND_MS = 1_000

/** The executor's fatal path (ARCH-RUNTIME-030). It records the failure, flushes the
 *  durable writers of the runtime that `runtime` answers at that moment, so
 *  the facts written before the failure reach the store, closes the log, and
 *  exits 1. The flush is bounded, so a flush that the failure wedged never
 *  holds the exit, and the account restarts the executor. */
export function projectExecutorFatal(options: {
  readonly log: Pick<ReturnType<typeof Log.create>, "warn" | "error">
  readonly runtime: () => Pick<RuntimeComposition, "flushDurableState"> | undefined
  readonly exit: (code: number) => void
}): (failure: unknown, kind: UncaughtKind) => Promise<void> {
  const { log, runtime, exit } = options
  return (failure, kind) => {
    recordFatal(log, kind, failure)
    return exitAfter({
      log, boundMs: FATAL_FLUSH_BOUND_MS,
      settle: () => runtime()?.flushDurableState() ?? Promise.resolve(),
      exit: () => { void Log.closeGlobal().finally(() => { exit(1) }) },
    })
  }
}

/** Composes execution over account-owned state and private IPC, with no public listener. */
export async function runProjectExecutorMain(): Promise<void> {
  // The command supervisor that launched this process leads its container.
  // Read now, because a process whose parent exits is given a new parent.
  const supervisorPid = process.ppid
  const serialized = process.env.FLYWHEEL_PROJECT_EXECUTOR
  delete process.env.FLYWHEEL_PROJECT_EXECUTOR
  if (!serialized) throw new Error("project executor initialization is missing")
  const init = decodeProjectExecutorInitialization(JSON.parse(serialized))
  if (!init) throw new Error("project executor initialization is invalid")
  if (!establishProcessPriority("background")) throw new Error("project executor could not establish background priority")
  // Execution diagnostics belong to the project log beside the account's and
  // the interface's records, so `flywheel events search` reads one directory.
  await Log.init({ dir: init.directories.projectRoot })
  const log = Log.create({ service: "project-executor-main" }).with({ projectId: init.projectId, generation: init.generation })
  let runtime: RuntimeComposition | undefined
  installCrashPolicy({ role: "project-executor", log, fatal: projectExecutorFatal({ log, runtime: () => runtime, exit: (code) => process.exit(code) }) })
  const stopSignals = listenForExecutorStopSignals({ platform: process.platform, log })
  // The executor's own shutdown bound, armed when a stop begins. The account
  // waits this bound and the grace for the answer, so a stop that cannot
  // settle ends with this process, inside the account's wait. Its Worker is
  // created once the executor has reported ready, off the path to that
  // readiness and while the cwd it loads from still exists; a stop before
  // ready creates it then. The account owns the parent watch through the
  // guardian, so this watchdog watches no parent. Its decision names the
  // supervisor's container, which the account watches for this launch.
  let watchdog: ProcessWatchdog | undefined
  const shutdownWatchdog = (): ProcessWatchdog => {
    watchdog ??= createProcessWatchdog({ parentPid: 0, containerPid: supervisorPid, hardExitMs: RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS })
    return watchdog
  }
  const endpoints = new Map<ProjectExecutorEndpointKind, ReattachableProcessEndpoint<unknown, unknown>>()
  const memorySampler = startReleaseMemorySampler({ role: "project-executor" })
  ensureProcessMemorySampler()
  const connect = async (kind: ProjectExecutorEndpointKind): Promise<InternalProcessEndpoint<unknown, unknown>> => {
    const live = await connectInternalProcessChannel<unknown, unknown>({ path: init.endpoints[kind], decode: (value) => value, ...projectExecutorChannelLimits(kind) })
    await live.send(encodeProjectExecutorCredential({ projectId: init.projectId, generation: init.generation, endpoint: kind, credential: init.credentials[kind] }))
    return live
  }
  // A lost socket is not a lost account. The channel detaches, sends wait, and
  // this walk reconnects with the generation's own credential for as long as
  // the channel is open; the facade's deadline, the same one the account
  // holds, is what finally ends the channel if the account never answers.
  const reattach = async (kind: ProjectExecutorEndpointKind, channel: ReattachableProcessEndpoint<unknown, unknown>, cause: Error): Promise<void> => {
    log.warn("executor channel lost; reconnecting", { kind, reason: cause.message })
    let closed = false
    const stop = channel.onClose(() => { closed = true })
    try {
      for (let attempt = 0; ; attempt++) {
        if (closed || channel.attached) return
        await new Promise<void>((resolve) => { setTimeout(resolve, projectExecutorReattachDelayMs(attempt)) })
        if (closed || channel.attached) return
        try {
          channel.attach(await connect(kind))
          log.info("executor channel reconnected", { kind })
          return
        } catch (error) {
          log.warn("executor channel reconnect attempt failed", { kind, error: errorMessage(error) })
        }
      }
    } finally {
      stop()
    }
  }
  try {
    for (const kind of ["control", "state", "output", "lifecycle"] as const) {
      const channel = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: PROJECT_EXECUTOR_REATTACH_DEADLINE_MS })
      channel.attach(await connect(kind))
      channel.onDetach((cause) => { void reattach(kind, channel, cause) })
      endpoints.set(kind, channel)
    }
    const control = endpoints.get("control")
    const lifecycle = endpoints.get("lifecycle")
    const stateEndpoint = endpoints.get("state")
    const output = endpoints.get("output")
    if (!control || !lifecycle || !stateEndpoint || !output) throw new Error("project executor channel setup is incomplete")
    const channels = createProjectExecutorChannelSet({
      control, lifecycle, state: stateEndpoint, output,
    })
    const launcher = connectOwnedProcessBridge({ endpoint: createInternalProcessSubchannel(control, "guardian") }).launcher
    const persistentProcesses = connectPersistentProcessBridge(createInternalProcessSubchannel(control, "persistent"))
    const state = connectProjectStateChannel(channels.state, { kind: "executor", projectId: init.projectId, generation: init.generation })
    const notify = connectProjectNotifyChannel(createInternalProcessSubchannel(control, "notify"))
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let starting: Promise<void> | undefined
    let closeOutput: ReturnType<typeof serveProjectExecutionChannel> | undefined
    let accepting = true
    let stopping: Promise<void> | undefined
    // The stop answers the account only when the account asked for it, and
    // the account can ask after a signal began the stop. The answer goes once
    // there is both a request and an outcome, so a request that arrives after
    // the stop settled is answered at once while the channel is open.
    let asked = false
    let outcome: Extract<ProjectExecutorEvent, { kind: "stopped" | "failed" }> | undefined
    let answer: Promise<void> | undefined
    // Set once the stop has done its work and answered, so that only its
    // closures and the exit remain.
    let stopFinished = false
    const sendAnswer = (): Promise<void> => {
      if (asked && outcome) answer ??= lifecycle.send(outcome)
      return answer ?? Promise.resolve()
    }
    const conclude = async (result: NonNullable<typeof outcome>): Promise<void> => {
      outcome = result
      // A request the account sent while the stop ran can still wait unread
      // behind the stop's own work, so the stop reads what is due before it
      // decides that nobody asked. A request that arrives after this can
      // find the channels closed and get no answer. The account then reads
      // this process's exit by its stop signal as the end of its own stop
      // (ARCH-RUNTIME-020).
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await sendAnswer()
    }
    // From the first heartbeat until the stop closes the channels, a
    // heartbeat each period the account named is its evidence that this
    // process's event loop answers: through a slow start, while it serves,
    // and through the stop, so only a silent executor can read as wedged and
    // a stop that stalls shows in the account's stall records. The account
    // counts missed heartbeats in the same period.
    const startHeartbeat = (): void => {
      if (stopping) return
      heartbeat = setInterval(() => {
        void lifecycle.send({ kind: "heartbeat" }).catch(() => { void channels.close() })
      }, init.heartbeatIntervalMs)
    }
    // Starts the ordered stop, or joins the one that runs: the first caller's
    // trigger arms the clock, and its clientsHold decides the empty chats.
    const stop = (trigger: StopTrigger, clientsHold: boolean): Promise<void> => {
      if (!stopping) {
        accepting = false
        shutdownWatchdog().arm(trigger)
        stopping = (async () => {
          try {
            await starting
            const result = await runtime?.dispose({ clientsHold })
            if (result?.kind === "blocked") throw new Error(`project executor shutdown blocked at ${result.phase}`)
            await closeOutput?.drain()
            persistentProcesses.close()
            const closure = await launcher.close()
            if (!closure.settled) throw new Error(closure.reason)
            const successorRows = runtime?.replacementSuccessorRows()
            await conclude({ kind: "stopped", ...(successorRows === undefined ? {} : { successorRows }) })
          } catch (error) {
            await conclude({ kind: "failed", reason: errorMessage(error) }).catch(() => {})
            throw error
          } finally {
            stopFinished = true
            persistentProcesses.close()
            await launcher.close()
            await closeOutput?.()
            await state.close()
            clearInterval(heartbeat)
            await channels.close()
          }
        })()
      }
      return stopping
    }
    const { reportBlockers, recordCapacityWake } = serveProjectExecutorLifecycle({
      lifecycle, log, processor: sharedProcessorClaims(),
      end: (reason) => channels.close(reason),
      handlers: {
        async start(chatDefault) {
          if (stopping) throw new Error("project executor is stopping")
          starting = (async () => {
            runtime = await createProjectExecutionRuntime({
              ...init.directories, projectLabel: init.projectLabel, workerUrl: init.workerUrl, state, launcher,
              persistentProcesses, allowPersistentProcesses: init.allowPersistentProcesses,
              notify, interactive: true, chatDefault, recordCapacityWake,
            })
            // A report without an id tells the account that the list
            // changed. The account keeps the list as the latest one, and a
            // read that misses its bound answers with it.
            runtime.onBlockersChanged(reportBlockers)
            // From the moment a stop begins, a call the channel reads is
            // refused rather than run, so the account takes it again after
            // this generation, whatever began the stop.
            closeOutput = serveProjectExecutionChannel(runtime.client, channels.output, { admits: () => accepting })
          })()
          await starting
          if (stopping) return
          await lifecycle.send({ kind: "ready" })
          shutdownWatchdog()
          // Off the path to ready: every command a previous build handed to
          // this project that no host has adopted is adopted or settled.
          void runtime?.adoptHandedOverCommands()
          // Off the path to ready: every capacity wait an earlier generation
          // left continues through its owning host, and the account learns
          // the time the project owes a wake now.
          void runtime?.continueCapacityWaits()
            .then(({ at }) => recordCapacityWake(at))
            .catch((error: unknown) => { log.warn("the project's capacity waits could not be continued at start", { error: errorMessage(error) }) })
        },
        stop: (clientsHold) => {
          asked = true
          void sendAnswer().catch(() => {})
          return stop("account stop", clientsHold)
        },
        runtime: () => runtime,
        adoptLoginShellPath: (path) => { processLoginShellPath.adopt(path) },
      },
    })
    stopSignals.serve({ stop, lifecycle, finished: () => stopFinished })
    await lifecycle.send({ kind: "process", pid: process.pid })
    // The final authenticated endpoint proves handlers are installed before start can arrive.
    await lifecycle.send({ kind: "heartbeat" })
    startHeartbeat()
    await channels.closed
    clearInterval(heartbeat)
    try {
      // The service went away without asking, so nothing here knows whether
      // a client holds the project. Its clients attach to the next service,
      // so the stop keeps every empty chat for their tabs.
      await stop("account gone", true)
    } finally {
      persistentProcesses.close()
      await launcher.close()
    }
  } finally {
    memorySampler?.dispose()
    for (const endpoint of endpoints.values()) endpoint.close()
    await Promise.all([...endpoints.values()].map((endpoint) => endpoint.closed))
    await watchdog?.dispose()
  }
}
