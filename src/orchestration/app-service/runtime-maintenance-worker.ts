import type { DebugLogRecordInput } from "../../infra/debug-log.js"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import { runModuleMaintenance } from "../modules.js"
import { installCrashPolicy, recordFatal } from "../../infra/crash-policy.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { createMessagePortProcessEndpoint } from "../../infra/internal-process-channel.js"
import { Log } from "../../infra/log.js"
import { ownedCommandRunner } from "../../infra/owned-command.js"
import { connectOwnedProcessBridge } from "../../infra/owned-process-bridge.js"
import { resolveEventStoreDbFile } from "../../infra/paths.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { AsyncGuardedEventWriter } from "../../infra/event-store-types.js"
import { pruneRetiredFactFamiliesThrough, readEventStoreSizeStats, shouldVacuum } from "../session/event-store-maintenance.js"
import { sweepIdleScratch } from "../session/session-artifacts.js"
import type { WorkerSelf } from "./bun-worker-rpc.js"
import { createProjectExecutionState } from "./project-execution-state.js"
import type { ProjectStateClient } from "./project-state-client.js"
import { connectProjectStateChannel } from "./project-state-channel.js"
import { planFinalizedToolResultCheckpointPage } from "../migrations/finalized-tool-result-checkpoints.js"

export interface RuntimeMaintenanceWorkerInit {
  readonly flywheel: "maintenance.init"
  readonly directories: StartupDirectories
  /** The Worker's end of its guardian generation. */
  readonly ownership: MessagePort
  /** The Worker's end of the project's state channel, which the account
   *  serves from the project's one writer. */
  readonly state: MessagePort
}

/** The frames the maintenance Worker posts to its owner. */
export type RuntimeMaintenanceWorkerFrame = { readonly flywheel: "maintenance.log"; readonly record: DebugLogRecordInput }

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
  const ownership = connectOwnedProcessBridge({ port: init.ownership })
  const state = connectProjectStateChannel(createMessagePortProcessEndpoint({ port: init.state, decode: (value) => value }), { kind: "maintenance", projectId: init.directories.projectRoot })
  await runRuntimeMaintenanceLifecycle({
    lifetime: ownership.lifetime,
    work: (signal) => runMaintenanceWork(init.directories, ownership.launcher, state, signal),
    closeLauncher: async () => {
      try {
        const closure = await ownership.launcher.close()
        if (!closure.settled) throw new Error(closure.reason)
      } finally {
        await state.close()
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

export interface RuntimeMaintenanceLifecycleInput {
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
export async function runRuntimeMaintenanceLifecycle(input: RuntimeMaintenanceLifecycleInput): Promise<void> {
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
export async function runSerializedMaintenanceSteps(
  signal: AbortSignal,
  steps: readonly (() => void | Promise<void>)[],
): Promise<void> {
  for (const step of steps) {
    signal.throwIfAborted()
    await step()
  }
}

async function runMaintenanceWork(directories: StartupDirectories, launcher: LauncherScope, state: ProjectStateClient, signal: AbortSignal): Promise<void> {
  const execution = await createProjectExecutionState(state)
  try {
    await runMaintenanceSteps(directories, launcher, state, execution.eventStore, signal)
  } finally {
    await execution.eventStoreRuntime.dispose()
  }
}

async function runMaintenanceSteps(directories: StartupDirectories, launcher: LauncherScope, state: ProjectStateClient, writer: AsyncGuardedEventWriter, signal: AbortSignal): Promise<void> {
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
      const stats = readEventStoreSizeStats(dbPath)
      log.info("startup event-store maintenance done", {
        rowsDeleted: result.rowsDeleted,
        deletedByType: Object.fromEntries(result.deletedByType.map((family) => [family.type, family.count])),
        reclaimableBytes: stats.reclaimableBytes,
        ...(shouldVacuum(stats) ? { vacuumAdvised: "run `flywheel events maintain --vacuum` with no session open" } : {}),
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
