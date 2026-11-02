import { installedWorkspaceMigrations } from "./modules.js"
import * as fs from "node:fs"
import { ContainedDirectory } from "../infra/descriptor-directory.js"
import { FLYWHEEL_DIR_NAME, type ProjectDirectories } from "../infra/directory-authorities.js"
import { acquireProjectStateGeneration, type ProjectStateLease } from "./project-state-lease.js"
import { resolveEventStoreDbFile } from "../infra/paths.js"
import { buildMissingSessionTypeIndex } from "../infra/sqlite-event-store-core.js"
import { settleWorkspaceGeneration, readGenerationEpoch, WORKSPACE_STATE_EPOCH } from "./workspace-state-retirement.js"
import { migrateAgentInputAnswers } from "./migrations/agent-input-answer.js"
import { readFactPassSettlement, recordFactPassSettlement } from "./migrations/engine.js"
import { excludeStateFromGit } from "./state-git-exclude.js"
import type { StartupReached } from "../protocol/startup-steps.js"
import { observeReleaseMemoryPhase, startReleaseMemorySampler } from "../infra/startup-trace.js"

const PRIVATE = { privateDirectories: true } as const

/** What one start settled on: the event store it may open, and its ownership of
 *  the generation that store belongs to. */
export interface WorkspaceStatePreparation {
  readonly dbFile: string
  /** Shared ownership of the generation this preparation settled on. The caller
   *  releases it when it closes the store; while it is held, no start may
   *  replace the generation underneath it. */
  readonly generation: ProjectStateLease
}

/** Inspect this project's state generation and, when it is not the current
 *  epoch, retire it and stamp replacement state.
 *
 *  The whole lease is bound to one admitted `.flywheel` directory: it is created
 *  private, held open, and every step below resolves against that descriptor.
 *  The gate, the classification, the retirement, and the replacement are
 *  therefore operations on one directory, so a `.flywheel` replaced after the
 *  gate was acquired cannot split the lock from the generation it guards.
 *
 *  The one-time overlay definition migration runs in the same window, so a
 *  generation this release cannot classify refuses the start with this
 *  project's definitions exactly as they were. */
export function prepareWorkspaceState(directories: ProjectDirectories, onStartupStep?: (reached: StartupReached) => void, measurementRole = "workspace-preparation"): WorkspaceStatePreparation {
  const projectRoot = directories.projectRoot
  // Every contained operation below is rooted at this base, so the base must
  // exist before one can open it. A workspace opened for the first time need
  // not: the base is the user's own directory and keeps the user's own mode,
  // while everything Flywheel owns below it is private.
  fs.mkdirSync(projectRoot, { recursive: true })
  const flywheel = ContainedDirectory.open(projectRoot, [FLYWHEEL_DIR_NAME], PRIVATE)
  const generation = acquireProjectStateGeneration(flywheel)
  let downgraded: ProjectStateLease | undefined
  const measurement = startReleaseMemorySampler({ role: measurementRole })
  observeReleaseMemoryPhase("workspace.begin")
  try {
    const dbFile = resolveEventStoreDbFile(projectRoot)
    // Admission precedes every migration, including definition overlays.
    for (const phase of ["definition-overlays", "stored-facts", "startup-recovery"] as const) {
      installedWorkspaceMigrations(phase, generation.otherOwnersLive, undefined, { dbFile, directories })
    }
    const outcome = settleWorkspaceGeneration(flywheel, dbFile, generation.otherOwnersLive)
    // Overlay definitions are this project's own durable state, so they are
    // migrated only once the generation they belong to is admitted or retired,
    // and while the exclusive gate still holds every other start out. Nothing
    // has read a definition registry yet, including the fact upgrades below,
    // which capture the current definitions of this project.
    for (const migration of installedWorkspaceMigrations("definition-overlays", generation.otherOwnersLive, undefined, { dbFile, directories })) {
      migration.run({ dbFile, directories })
    }
    // A peer owner's writes would wait on the build's lock for its whole
    // length, so a shared start leaves the build to the next sole one.
    if (!generation.otherOwnersLive) buildMissingSessionTypeIndex(dbFile, () => onStartupStep?.({ step: "event-index" }))
    if (outcome.migrate) runMigrations(dbFile, directories, generation.otherOwnersLive, onStartupStep)
    for (const recovery of installedWorkspaceMigrations("startup-recovery", generation.otherOwnersLive, undefined, { dbFile, directories })) {
      recovery.run({ dbFile, directories })
    }
    downgraded = generation.downgrade()
    // Only once the workspace is settled: a start that refuses one leaves the
    // tree exactly as it found it, git's own ignores included.
    excludeStateFromGit(projectRoot)
    return { dbFile, generation: downgraded }
  } finally {
    observeReleaseMemoryPhase("workspace.end")
    measurement?.dispose()
    if (!downgraded) generation.release()
  }
}

/** The event store of the generation the owning start already prepared. An
 *  in-process participant (the background history Worker) uses this: the
 *  process that owns the generation holds it for the whole lifetime of every
 *  reader inside that process, so a participant takes no ownership of its own
 *  and never replaces anything. An epoch that is not current means the owning
 *  contract was broken, so this refuses rather than repairing it. */
export function openWorkspaceState(projectRoot: string): string {
  const dbFile = resolveEventStoreDbFile(projectRoot)
  const flywheel = ContainedDirectory.openExisting(projectRoot, [FLYWHEEL_DIR_NAME])
  if (!flywheel) throw new Error(`this project holds no prepared workspace state: ${projectRoot}`)
  try {
    const epoch = readGenerationEpoch(flywheel, dbFile)
    if (epoch !== WORKSPACE_STATE_EPOCH) {
      throw new Error(`workspace state epoch ${epoch} is not the current epoch ${WORKSPACE_STATE_EPOCH}; only the owning runtime replaces a generation`)
    }
    return dbFile
  } finally {
    flywheel.close()
  }
}

/** Historical facts are upgraded before any reader opens the store. Queue facts
 * are upgraded first because the identity chain's catalog pass rewrites the same
 * rows. Each migration isolates unreadable historical rows from healthy work.
 *
 * Every pass is incremental, so an open where nothing was appended since the
 * last complete run has no work: one read of the settled row decides that, and
 * the passes do not each open the store to find it out. The head is read
 * before the first pass, so a fact another owner appends while the passes run
 * lies above the recorded `through` and the next open looks again. */
function runMigrations(dbFile: string, directories: ProjectDirectories, otherOwnersLive: boolean, onStartupStep?: (reached: StartupReached) => void): void {
  const passes: ReadonlyArray<readonly [string, () => void]> = [
    ["agent input contracts", () => { migrateAgentInputAnswers(dbFile) }],
    ...installedWorkspaceMigrations("stored-facts", otherOwnersLive, undefined, { dbFile, directories }).map((migration) => [migration.label, () => migration.run({ dbFile, directories })] as const),
  ]
  const labels = passes.map(([label]) => label)
  const settlement = readFactPassSettlement(dbFile, labels)
  if (settlement.settled) return
  for (const [index, [label, run]] of passes.entries()) {
    onStartupStep?.({ step: "stored-facts", pass: { label, step: index + 1, total: passes.length } })
    run()
  }
  recordFactPassSettlement(dbFile, labels, settlement.head)
}