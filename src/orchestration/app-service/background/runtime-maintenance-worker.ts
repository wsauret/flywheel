import type { DebugLogRecordInput } from "../../../infra/diagnostics/debug-log.js"
import type { StartupDirectories } from "../../../infra/platform/files/directory-authorities.js"
import { runModuleMaintenance } from "../../modules.js"
import { installCrashPolicy, recordFatal } from "../../../infra/process/crash-policy.js"
import { errorDetail, errorMessage } from "../../../infra/diagnostics/error-message.js"
import { createMessagePortProcessEndpoint } from "../../../infra/process/channels/internal-process-channel.js"
import { Log } from "../../../infra/diagnostics/log.js"
import { ownedCommandRunner } from "../../../infra/owned-command.js"
import { connectOwnedProcessBridge } from "../../../infra/owned-process-bridge.js"
import { resolveEventStoreDbFile } from "../../../infra/platform/files/paths.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
import type { AsyncEventWriter } from "../../../infra/substrate/store/event-store-types.js"
import { INCREMENTAL_VACUUM_STEP_PAGES, pruneRetiredFactFamiliesThrough, pruneSupersededFactsThrough, readEventStoreSizeStats, readStoreUsage, type StoreUsage, type SupersededPlanBounds } from "../../session/persistence/storage/event-store-maintenance.js"
import { reclaimStoreExclusively } from "../../session/persistence/storage/store-reclaim.js"
import type { StorageReclaimOutcome } from "../../../protocol/store-reclaim.js"
import { sweepIdleScratch } from "../../session/persistence/storage/session-artifacts.js"
import type { WorkerSelf } from "../project-state/worker/bun-worker-rpc.js"
import { createProjectExecutionState } from "../project-state/project-execution-state.js"
import type { ProjectStateClient } from "../project-state/project-state-client.js"
import { connectProjectStateChannel } from "../project-state/project-state-channel.js"
import { planFinalizedToolResultCheckpointPage } from "../../workspace-state/migrations/finalized-tool-result-checkpoints.js"

/* The jobs one maintenance Worker runs:
 *  - `startup`: the upkeep a project's open defers until its foreground is ready.
 *  - `idle-reclaim`: the superseded prune and incremental vacuum while the
 *    project runs no work, in bounded steps that stop when work starts.
 *  - `reclaim`: the Reclaim storage command's prune and full VACUUM, on a
 *    project the account has closed, so it has no state channel. */

export type RuntimeMaintenanceWorkerInit = {
  readonly flywheel: "maintenance.init"
  readonly directories: StartupDirectories
  /** The Worker's end of its guardian generation. */
  readonly ownership: MessagePort
} & (
  | {
    readonly job: "startup" | "idle-reclaim"
    /** The Worker's end of the project's state channel, which the account
     *  serves from the project's one writer. */
    readonly state: MessagePort
    /** Idle reclaim's superseded-prune bounds from the project's last runs. */
    readonly plannedThrough?: SupersededPlanBounds
  }
  | { readonly job: "reclaim" }
)

/** The frames the maintenance Worker posts to its owner: its log records,
 *  the store usage a project job measured last, and the reclaim's outcome. */
export type RuntimeMaintenanceWorkerFrame =
  | { readonly flywheel: "maintenance.log"; readonly record: DebugLogRecordInput }
  | { readonly flywheel: "maintenance.usage"; readonly usage: StoreUsage }
  | { readonly flywheel: "maintenance.reclaimed"; readonly outcome: StorageReclaimOutcome }
  | { readonly flywheel: "maintenance.planned"; readonly eventType: string; readonly through: number }

const log = Log.create({ service: "runtime-maintenance" })

/** Runs one project's startup maintenance job and exits (ARCH-RUNTIME-044). It reads
 *  the store on its own read-only connection and writes only through the
 *  project's state channel, so the state Worker stays the store's one writer
 *  while this Worker's synchronous reads stay off every other loop. */
export async function runRuntimeMaintenanceWorker(worker: WorkerSelf, init: RuntimeMaintenanceWorkerInit): Promise<void> {
  // The job opens no log file: its records join the account service's one
  // stream, and a file per job would be a file per project open.
  await Log.init({ forward: (record) => { worker.postMessage({ flywheel: "maintenance.log", record } satisfies RuntimeMaintenanceWorkerFrame, []) } })
  installCrashPolicy({
    role: "runtime-maintenance-worker", log,
    fatal: (failure, kind) => {
      recordFatal(log, kind, failure)
      return Log.closeGlobal().finally(() => process.exit(1))
    },
  })
  const post = (frame: RuntimeMaintenanceWorkerFrame): void => { worker.postMessage(frame, []) }
  const ownership = connectOwnedProcessBridge({ port: init.ownership })
  const state = init.job === "reclaim" ? undefined : connectProjectStateChannel(createMessagePortProcessEndpoint({ port: init.state, decode: (value) => value }), { kind: "maintenance", projectId: init.directories.projectRoot })
  await runRuntimeMaintenanceLifecycle({
    lifetime: ownership.lifetime,
    work: async (signal) => {
      if (!state) {
        post({ flywheel: "maintenance.reclaimed", outcome: await reclaimStoreExclusively(init.directories.projectRoot) })
        return
      }
      const dbPath = resolveEventStoreDbFile(init.directories.projectRoot)
      // A usage read is page headers and one index walk, so it never holds
      // the job past its work.
      const postUsage = (supersededBytes: number): void => {
        const usage = readStoreUsage(dbPath, supersededBytes)
        if (usage) post({ flywheel: "maintenance.usage", usage })
      }
      const steps: MaintenanceSteps = init.job === "idle-reclaim"
        ? (directories, _launcher, channel, _writer, cut) => runIdleReclaim(directories, channel, cut, init.plannedThrough ?? {}, {
          onPlanned: (eventType, through) => { post({ flywheel: "maintenance.planned", eventType, through }) },
          onPending: postUsage,
        })
        : runStartupSteps
      await runMaintenanceWork(steps, init.directories, ownership.launcher, state, signal)
      // No superseded bytes are left to add: a finished idle run deleted every
      // row it planned, whose pages the read counts as free, and the startup
      // job plans none, because the idle run that follows it plans them from
      // the start of the store.
      postUsage(0)
    },
    closeLauncher: async () => {
      try {
        const closure = await ownership.launcher.close()
        if (!closure.settled) throw new Error(closure.reason)
      } finally {
        await state?.close()
      }
    },
    logOwnershipClosed: () => { log.debug("startup maintenance ownership closed") },
    closeLog: () => Log.closeGlobal(),
    exit: () => process.exit(0),
    reportFailure: (stage, error) => {
      log.warn("startup maintenance settlement failed", { stage, error: errorMessage(error), errorDetail: errorDetail(error) })
    },
  })
}

interface RuntimeMaintenanceLifecycleInput {
  /** Aborts when the job's owner ends its generation, which is how the owner
   *  withdraws the job (ARCH-RUNTIME-044). */
  readonly lifetime: AbortSignal
  readonly work: (signal: AbortSignal) => Promise<void>
  readonly closeLauncher: () => Promise<void>
  readonly logOwnershipClosed: () => void
  readonly closeLog: () => Promise<void>
  readonly exit: () => void
  readonly reportFailure: (stage: "work" | "launcher" | "log", error: unknown) => void
}

/** Owns cancellation and ordered settlement for one bounded maintenance Worker run. */
async function runRuntimeMaintenanceLifecycle(input: RuntimeMaintenanceLifecycleInput): Promise<void> {
  try {
    await input.work(input.lifetime)
  } catch (error) {
    // A withdrawn job stops where it is; that is its owner's decision, not a failure.
    if (!input.lifetime.aborted) input.reportFailure("work", error)
  } finally {
    let launcherClosed = false
    try {
      await input.closeLauncher()
      launcherClosed = true
    } catch (error) {
      input.reportFailure("launcher", error)
    }
    if (launcherClosed) input.logOwnershipClosed()
    try {
      await input.closeLog()
    } catch (error) {
      input.reportFailure("log", error)
    }
    input.exit()
  }
}

/** Runs ordered maintenance boundaries and checks cancellation before each one. */
async function runSerializedMaintenanceSteps(
  signal: AbortSignal,
  steps: readonly (() => void | Promise<void>)[],
): Promise<void> {
  for (const step of steps) {
    signal.throwIfAborted()
    await step()
  }
}

type MaintenanceSteps = (directories: StartupDirectories, launcher: LauncherScope, state: ProjectStateClient, writer: AsyncEventWriter, signal: AbortSignal) => Promise<void>

async function runMaintenanceWork(steps: MaintenanceSteps, directories: StartupDirectories, launcher: LauncherScope, state: ProjectStateClient, signal: AbortSignal): Promise<void> {
  const execution = await createProjectExecutionState(state)
  try {
    await steps(directories, launcher, state, execution.eventStore, signal)
  } finally {
    await execution.eventStoreRuntime.dispose()
  }
}

/** Gives space back while the project runs no work (ARCH-RUNTIME-083): the
 *  superseded rows first, then the free pages, each in bounded steps through
 *  the store's one writer with a pause between steps, so a write that arrives
 *  waits out one step at most. The owner withdraws the job when work starts,
 *  which stops it at the next step. One record when the run finishes: INFO
 *  when it gave something back, DEBUG for a run that found nothing. */
async function runIdleReclaim(
  directories: StartupDirectories,
  state: ProjectStateClient,
  signal: AbortSignal,
  plannedThrough: SupersededPlanBounds,
  listeners: Pick<Parameters<typeof pruneSupersededFactsThrough>[2], "onPlanned" | "onPending">,
): Promise<void> {
  const started = performance.now()
  const dbPath = resolveEventStoreDbFile(directories.projectRoot)
  const pruned = await pruneSupersededFactsThrough(dbPath, (step) => state.upkeep.pruneSupersededStep(step.eventType, step.positions), { signal, plannedThrough, ...listeners })
  const { pageSize } = readEventStoreSizeStats(dbPath)
  let pagesFreed = 0
  for (;;) {
    signal.throwIfAborted()
    const freed = await state.upkeep.incrementalVacuumStep(INCREMENTAL_VACUUM_STEP_PAGES)
    pagesFreed += freed
    // A step that frees less than it may has emptied the free list, and a
    // store not in incremental mode frees nothing at its first step.
    if (freed < INCREMENTAL_VACUUM_STEP_PAGES) break
    await Bun.sleep(IDLE_STEP_PAUSE_MS)
  }
  const done = {
    rowsDeleted: pruned.rowsDeleted,
    payloadBytesDeleted: pruned.payloadBytesDeleted,
    bytesFreed: pagesFreed * pageSize,
    durationMs: Math.round(performance.now() - started),
  }
  if (done.rowsDeleted > 0 || done.bytesFreed > 0) log.info("idle store reclaim done", done)
  else log.debug("idle store reclaim done", done)
}

/** The window between idle-reclaim steps in which a waiting write takes the lock. */
const IDLE_STEP_PAUSE_MS = 15

async function runStartupSteps(directories: StartupDirectories, launcher: LauncherScope, state: ProjectStateClient, writer: AsyncEventWriter, signal: AbortSignal): Promise<void> {
  // The state client is the reader, as in the executor, so a projection that
  // maintenance holds is keyed by the same object that releases it.
  const input = { directories, launcher, reader: state, writer, signal }
  const dbPath = resolveEventStoreDbFile(directories.projectRoot)
  // A withdrawn job is not a failed step; the step runner ends the run.
  const contained = (failure: string, step: () => Promise<void>) => async (): Promise<void> => {
    try {
      await step()
    } catch (err) {
      if (signal.aborted) throw err
      log.warn(failure, { error: errorMessage(err), errorDetail: errorDetail(err) })
    }
  }
  await runSerializedMaintenanceSteps(signal, [
    contained("finalized tool result checkpoint maintenance failed", async () => {
      const started = performance.now()
      let afterRowid = 0
      let retired = 0
      let examined = 0
      let longestTransactionMs = 0
      for (;;) {
        signal.throwIfAborted()
        const plan = planFinalizedToolResultCheckpointPage(dbPath, afterRowid)
        const page = await state.upkeep.retireFinalizedCheckpointPage({ afterRowid, ...plan })
        retired += page.retired
        examined += page.examined
        longestTransactionMs = Math.max(longestTransactionMs, page.transactionMs)
        afterRowid = page.afterRowid
        if (page.complete) break
        await Bun.sleep(15)
      }
      if (examined > 0) log.info("finalized tool result checkpoint maintenance done", {
        retired, examined, longestTransactionMs, durationMs: performance.now() - started,
      })
    }),
    contained("startup module maintenance failed before store maintenance", () => runModuleMaintenance("before-store", input)),
    contained("retired event-store index drop failed", async () => {
      const dropped = await state.upkeep.dropRetiredIndexes()
      if (dropped > 0) log.info("retired event-store indexes dropped", { count: dropped })
    }),
    contained("startup event-store maintenance failed", async () => {
      const result = await pruneRetiredFactFamiliesThrough(dbPath, (eventType) => state.upkeep.pruneRetiredFamilyChunk(eventType), signal)
      log.info("startup event-store maintenance done", {
        rowsDeleted: result.rowsDeleted,
        deletedByType: Object.fromEntries(result.deletedByType.map((family) => [family.type, family.count])),
      })
    }),
    contained("startup module maintenance failed after store maintenance", () => runModuleMaintenance("after-store", input)),
    // Last, because its walk can visit millions of files in a project whose
    // agents left clones behind, and nothing else waits on it.
    contained("idle scratch sweep failed", async () => {
      const startedAt = Date.now()
      const swept = await sweepIdleScratch({ projectRoot: directories.projectRoot, now: startedAt, signal, runGit: ownedCommandRunner(launcher) })
      log.info("idle scratch sweep done", { ...swept, durationMs: Date.now() - startedAt })
    }),
  ])
}
