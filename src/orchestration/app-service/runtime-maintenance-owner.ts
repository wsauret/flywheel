import { createBoundedWorkerSpawner } from "../../infra/bounded-worker-spawner.js"
import { DebugLog, parseForwardedLogRecord } from "../../infra/debug-log.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import { Log } from "../../infra/log.js"
import { createBackgroundLane } from "../../infra/ordered-lane.js"
import { serveOwnedProcessBridge, type OwnedProcessBridge } from "../../infra/owned-process-bridge.js"
import type { GuardianControl } from "../../infra/process-supervisor.js"
import { terminateWorker } from "../../infra/worker-termination.js"
import type { RuntimeMaintenanceWorkerInit } from "./runtime-maintenance-worker.js"

const log = Log.create({ service: "runtime-maintenance-owner" })

/** One project's startup maintenance job, as the project's composition knows it. */
export interface ProjectMaintenanceJob {
  readonly directories: StartupDirectories
  /** Serves the project's state channel on `port` for the job's Worker, from
   *  the project's one writer. The returned close stops serving and joins the
   *  requests in flight. */
  readonly serveState: (port: MessagePort) => () => Promise<void>
}

/** The handle a project composition holds on its own job. */
interface ProjectMaintenance {
  /** Queues the job once the project's foreground is ready (ARCH-RUNTIME-044). Later
   *  calls, and a call after the withdrawal, do nothing. */
  admit(): void
  /** Withdraws the job and settles when nothing of it remains: a queued job
   *  never starts, and a running one is cut and joined with every process it
   *  launched. It never waits for another project's job. */
  withdraw(): Promise<void>
}

export interface MaintenanceQueue {
  project(job: ProjectMaintenanceJob): ProjectMaintenance
  /** Admits no job from now on and joins the job that runs. Each project
   *  withdraws its own job when it closes, so the account disposes this after
   *  its projects. */
  dispose(): Promise<void>
}

export interface MaintenanceQueueOptions {
  readonly workerUrl: string
  readonly guardian: Pick<GuardianControl, "openGeneration">
}

/** The account's startup maintenance: one job for each project open, run one
 *  at a time, each in its own one-shot Worker, so at most one maintenance
 *  Worker is live in the account service and none stays idle between jobs. */
export function createMaintenanceQueue(options: MaintenanceQueueOptions): MaintenanceQueue {
  const lane = createBackgroundLane(log, "runtime-maintenance")
  let closed = false
  return {
    project(job) {
      const withdrawal = new AbortController()
      const done = Promise.withResolvers<void>()
      let admitted = false
      let running = false
      const projectRoot = job.directories.projectRoot
      return {
        admit() {
          if (admitted || closed || withdrawal.signal.aborted) return
          admitted = true
          DebugLog.record({ type: "runtime.maintenance.queued", payload: { projectRoot } })
          lane.runInBackground("job", async () => {
            if (withdrawal.signal.aborted) return
            running = true
            try {
              await runMaintenanceWorkerJob(options, job, withdrawal.signal)
            } finally {
              running = false
              done.resolve()
            }
          })
        },
        withdraw() {
          if (!withdrawal.signal.aborted) {
            withdrawal.abort()
            // `running` tells a job cut short from one that never started.
            if (admitted) DebugLog.record({ type: "runtime.maintenance.withdrawn", payload: { projectRoot, running } })
          }
          if (!running) done.resolve()
          return done.promise
        },
      }
    },
    async dispose() {
      closed = true
      await lane.settled()
    },
  }
}

/** Starts one Worker for one job and joins it. The Worker, its bridge, the
 *  guardian generation behind the bridge, and the state channel are all
 *  released before this settles, whatever the job did. Never rejects: a job
 *  that fails is logged and holds nothing. */
async function runMaintenanceWorkerJob(options: MaintenanceQueueOptions, job: ProjectMaintenanceJob, signal: AbortSignal): Promise<void> {
  // The `runtime-maintenance` budget of one generation applies per job: each
  // job takes a spawner of its own and never starts a second Worker.
  const spawn = createBoundedWorkerSpawner("runtime-maintenance")
  let worker: Worker
  try {
    worker = spawn(options.workerUrl, { name: "flywheel-maintenance", ref: false, smol: true })
  } catch (error) {
    log.warn("startup maintenance Worker unavailable", { error: errorMessage(error), errorDetail: errorDetail(error) })
    return
  }
  DebugLog.record({ type: "runtime.worker.allocated", payload: { kind: "maintenance" } })
  const closed = new Promise<void>((resolve) => { worker.addEventListener("close", () => { resolve() }, { once: true }) })
  worker.addEventListener("message", (event) => {
    const record = workerLogRecord(event.data)
    if (record) DebugLog.record(record)
  })
  // A Worker that fails outside its own crash handler, such as in its import,
  // is ended here, so the join below never waits for a thread that is stuck.
  worker.addEventListener("error", (event) => {
    log.warn("startup maintenance Worker failed", { error: event.message || "it reported no cause" })
    void terminateWorker(worker)
  })
  let bridge: OwnedProcessBridge | undefined
  let stopServingState: (() => Promise<void>) | undefined
  const cut = (): void => { void bridge?.close() }
  void closed.then(() => { bridge?.peerExited() })
  signal.addEventListener("abort", cut, { once: true })
  try {
    // The guardian side of the job's generation is served here, and the
    // Worker receives the other end once, so no relay stands between them.
    // The state channel is served the same way, from the project's writer.
    const ownership = new MessageChannel()
    const state = new MessageChannel()
    bridge = serveOwnedProcessBridge({ port: ownership.port1, guardian: options.guardian })
    stopServingState = job.serveState(state.port1)
    const init: RuntimeMaintenanceWorkerInit = { flywheel: "maintenance.init", directories: job.directories, ownership: ownership.port2, state: state.port2 }
    worker.postMessage(init, [ownership.port2, state.port2])
    log.info("startup maintenance started", { projectRoot: job.directories.projectRoot })
    // The Worker ends itself once its job and its settlement are done; a
    // withdrawal ends its generation, which cuts the job short.
    await closed
  } catch (error) {
    log.warn("startup maintenance could not start", { error: errorMessage(error), errorDetail: errorDetail(error) })
    await terminateWorker(worker)
  } finally {
    signal.removeEventListener("abort", cut)
    const closure = await bridge?.close()
    if (closure && !closure.settled) log.warn("a maintenance job's commands did not prove settlement", { reason: closure.reason })
    await stopServingState?.()
    await closed
  }
}

function workerLogRecord(data: unknown) {
  if (typeof data !== "object" || data === null || !("flywheel" in data) || data.flywheel !== "maintenance.log" || !("record" in data)) return undefined
  return parseForwardedLogRecord(data.record)
}
