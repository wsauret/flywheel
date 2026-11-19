import { createBoundedWorkerSpawner } from "../../infra/bounded-worker-spawner.js"
import { DebugLog, parseForwardedLogRecord } from "../../infra/debug-log.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import { Log } from "../../infra/log.js"
import { createBackgroundLane } from "../../infra/ordered-lane.js"
import { serveOwnedProcessBridge, type OwnedProcessBridge } from "../../infra/owned-process-bridge.js"
import type { GuardianControl } from "../../infra/process-supervisor.js"
import { terminateWorker } from "../../infra/worker-termination.js"
import type { StoreUsage, SupersededPlanBounds } from "../session/event-store-maintenance.js"
import type { StorageReclaimOutcome } from "../../protocol/store-reclaim.js"
import type { RuntimeMaintenanceWorkerFrame, RuntimeMaintenanceWorkerInit } from "./runtime-maintenance-worker.js"

const log = Log.create({ service: "runtime-maintenance-owner" })

/** One project's maintenance job, as the project's composition knows it:
 *  its startup upkeep, or one idle reclaim run. */
interface ProjectMaintenanceJob {
  readonly kind: "startup" | "idle-reclaim"
  readonly directories: StartupDirectories
  /** Serves the project's state channel on `port` for the job's Worker, from
   *  the project's one writer. The returned close stops serving and joins the
   *  requests in flight. */
  readonly serveState: (port: MessagePort) => () => Promise<void>
  /** Told the store's usage once the job's work is done, and by idle
   *  reclaim also as its superseded plan is read and deleted. */
  readonly onUsage?: (usage: StoreUsage) => void
  /** Idle reclaim's superseded-prune bounds from the project's last runs,
   *  and the listener told each family's new bound as the run finishes it. */
  readonly plannedThrough?: SupersededPlanBounds
  readonly onPlanned?: (eventType: string, through: number) => void
}

/** The handle a project composition holds on its own job. */
interface ProjectMaintenance {
  /** Settles when the job has ended or was withdrawn, whatever it did. */
  readonly settled: Promise<void>
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
  /** Runs the Reclaim storage command's prune and full VACUUM of a project
   *  the account has closed, in the queue's turn, and answers its outcome. */
  reclaim(directories: StartupDirectories): Promise<StorageReclaimOutcome>
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
        settled: done.promise,
        admit() {
          if (admitted || closed || withdrawal.signal.aborted) return
          admitted = true
          DebugLog.record({ type: "runtime.maintenance.queued", payload: { projectRoot, kind: job.kind } })
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
    reclaim(directories) {
      if (closed) return Promise.resolve({ kind: "failed", message: "The account service is stopping." })
      const outcome = Promise.withResolvers<StorageReclaimOutcome>()
      lane.runInBackground("reclaim", async () => {
        let answered: StorageReclaimOutcome = { kind: "failed", message: "The reclaim job ended without an outcome." }
        try {
          await runMaintenanceWorkerJob(options, { kind: "reclaim", directories, onReclaimed: (result) => { answered = result } }, new AbortController().signal)
        } finally {
          outcome.resolve(answered)
        }
      })
      return outcome.promise
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
type WorkerJob = ProjectMaintenanceJob | {
  readonly kind: "reclaim"
  readonly directories: StartupDirectories
  readonly onReclaimed: (outcome: StorageReclaimOutcome) => void
}

async function runMaintenanceWorkerJob(options: MaintenanceQueueOptions, job: WorkerJob, signal: AbortSignal): Promise<void> {
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
    const frame = workerResultFrame(event.data)
    if (frame?.flywheel === "maintenance.usage" && job.kind !== "reclaim") job.onUsage?.(frame.usage)
    if (frame?.flywheel === "maintenance.reclaimed" && job.kind === "reclaim") job.onReclaimed(frame.outcome)
    if (frame?.flywheel === "maintenance.planned" && job.kind !== "reclaim") job.onPlanned?.(frame.eventType, frame.through)
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
    bridge = serveOwnedProcessBridge({ port: ownership.port1, guardian: options.guardian })
    if (job.kind === "reclaim") {
      const init: RuntimeMaintenanceWorkerInit = { flywheel: "maintenance.init", job: "reclaim", directories: job.directories, ownership: ownership.port2 }
      worker.postMessage(init, [ownership.port2])
    } else {
      const state = new MessageChannel()
      stopServingState = job.serveState(state.port1)
      const init: RuntimeMaintenanceWorkerInit = {
        flywheel: "maintenance.init", job: job.kind, directories: job.directories, ownership: ownership.port2, state: state.port2,
        ...(job.plannedThrough === undefined ? {} : { plannedThrough: job.plannedThrough }),
      }
      worker.postMessage(init, [ownership.port2, state.port2])
    }
    log.debug("maintenance job started", { projectRoot: job.directories.projectRoot, kind: job.kind })
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

/** A usage, plan-bound, or reclaim frame of the Worker, read structurally: the Worker is
 *  the same build, so its frames carry the shapes its init names. */
function workerResultFrame(data: unknown): Extract<RuntimeMaintenanceWorkerFrame, { flywheel: "maintenance.usage" | "maintenance.reclaimed" | "maintenance.planned" }> | undefined {
  if (typeof data !== "object" || data === null || !("flywheel" in data)) return undefined
  if (data.flywheel === "maintenance.planned" && "eventType" in data && typeof data.eventType === "string" && "through" in data && typeof data.through === "number") {
    return { flywheel: "maintenance.planned", eventType: data.eventType, through: data.through }
  }
  if (data.flywheel === "maintenance.usage" && "usage" in data && isStoreUsage(data.usage)) return { flywheel: "maintenance.usage", usage: data.usage }
  if (data.flywheel === "maintenance.reclaimed" && "outcome" in data && isReclaimOutcome(data.outcome)) return { flywheel: "maintenance.reclaimed", outcome: data.outcome }
  return undefined
}

function isStoreUsage(value: unknown): value is StoreUsage {
  return typeof value === "object" && value !== null && "storeBytes" in value && typeof value.storeBytes === "number"
    && "reclaimableBytes" in value && typeof value.reclaimableBytes === "number"
    && "supersededBytes" in value && typeof value.supersededBytes === "number"
    && "liveBytes" in value && typeof value.liveBytes === "number"
    && "incremental" in value && typeof value.incremental === "boolean"
}

function isReclaimOutcome(value: unknown): value is StorageReclaimOutcome {
  return typeof value === "object" && value !== null && "kind" in value && (value.kind === "reclaimed" || value.kind === "refused" || value.kind === "failed")
}

function workerLogRecord(data: unknown) {
  if (typeof data !== "object" || data === null || !("flywheel" in data) || data.flywheel !== "maintenance.log" || !("record" in data)) return undefined
  return parseForwardedLogRecord(data.record)
}
