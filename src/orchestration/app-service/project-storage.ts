import type { StartupDirectories } from "../../infra/directory-authorities.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { StoreUsage } from "../session/event-store-maintenance.js"
import type { AccountService } from "./account-service.js"
import type { MaintenanceQueue } from "./runtime-maintenance-owner.js"
import { readStoreUsage } from "../session/event-store-maintenance.js"
import { vacuumSpaceNeeds, vacuumSpaceShortfall } from "../session/store-reclaim.js"
import type { StorageReclaimOutcome, StorageReclaimPreview } from "../../protocol/store-reclaim.js"

const log = Log.create({ service: "storage-reclaim" })

/** The last Reclaim storage run of a project, which the account keeps across
 *  the close and reopen the run causes. */
export interface StoreReclaimRecord {
  readonly outcome: StorageReclaimOutcome
  readonly at: number
}

/** The account's half of the command: closes the project, runs the reclaim,
 *  and opens the project again. Absent in a composition no account serves. */
export interface StorageReclaimHost {
  /** Starts a run, or answers "running" while the project's run has not
   *  reopened it yet. */
  start(): "started" | "running"
  last(): StoreReclaimRecord | undefined
  /** The last run once, for the reopened project to announce; undefined
   *  after that, and when no run ended since. */
  takeAnnouncement(): StoreReclaimRecord | undefined
}

/** One project's store usage and its Reclaim storage command, as the
 *  project's control composition owns them (ARCH-RUNTIME-083). The usage is
 *  live state: each maintenance job reports it when its work is done, and
 *  readers are told each new value; nothing reads the store per render. */
export interface ProjectStorage {
  usage(): StoreUsage | undefined
  onUsage(listener: (usage: StoreUsage) => void): () => void
  report(usage: StoreUsage): void
  last(): StoreReclaimRecord | undefined
  takeAnnouncement(): StoreReclaimRecord | undefined
  /** Reads the store's usage and the free space now, for the person's
   *  confirmation. A one-shot read: page headers and one index walk. The
   *  superseded bytes are the last idle plan's, never a plan of its own. */
  preview(): StorageReclaimPreview
  /** Starts the reclaim when the space check passes; a refusal changes nothing. */
  reclaim(): { readonly kind: "started" } | { readonly kind: "refused"; readonly message: string }
}

/** The account's Reclaim storage runs: one per project at a time, each a
 *  close of the project, the reclaim job in the maintenance queue, and an
 *  open of the project again. It keeps the last run of each project across
 *  the close and reopen the run causes, so the reopened project shows it. */
export function createStorageReclaims(options: {
  readonly projects: () => Pick<AccountService<{ dispose(): Promise<void> }>, "closeFor" | "open">
  readonly maintenance: Pick<MaintenanceQueue, "reclaim">
}) {
  const records = new Map<string, StoreReclaimRecord>()
  const unannounced = new Set<string>()
  // A root stays here from the start of its run until the reopen settles, so
  // a second confirm never chains a second close and VACUUM.
  const running = new Set<string>()
  const run = (projectRoot: string, directories: StartupDirectories): void => {
    const started = performance.now()
    const projects = options.projects()
    void projects.closeFor(projectRoot, "storage reclaim", { step: "storage-reclaim" }, () => options.maintenance.reclaim(directories))
      .catch((error: unknown): StorageReclaimOutcome => ({ kind: "failed", message: errorMessage(error) }))
      .then((outcome) => {
        records.set(projectRoot, { outcome, at: Date.now() })
        unannounced.add(projectRoot)
        log.info("storage reclaim done", {
          projectRoot, outcome: outcome.kind, durationMs: Math.round(performance.now() - started),
          ...(outcome.kind === "reclaimed" ? { beforeBytes: outcome.beforeBytes, afterBytes: outcome.afterBytes, rowsDeleted: outcome.rowsDeleted } : {}),
          ...(outcome.kind === "refused" ? { reason: outcome.reason } : {}),
        })
        return projects.open(projectRoot, "storage reclaim")
      })
      .catch((error: unknown) => { log.warn("storage reclaim reopen failed", { projectRoot, error: errorMessage(error) }) })
      .finally(() => { running.delete(projectRoot) })
  }
  return {
    host: (projectRoot: string, directories: StartupDirectories): StorageReclaimHost => ({
      start() {
        if (running.has(projectRoot)) return "running"
        running.add(projectRoot)
        // The close ends the connection the starting call came on. Its
        // answer travels from this call to the socket in the promise jobs of
        // this task, with no I/O between, so a close begun on a later task
        // never cuts it.
        setImmediate(() => { run(projectRoot, directories) })
        return "started"
      },
      last: () => records.get(projectRoot),
      takeAnnouncement() {
        if (!unannounced.delete(projectRoot)) return undefined
        return records.get(projectRoot)
      },
    }),
  }
}

const RUNNING = "Reclaim storage already runs for this project."

export function createProjectStorage(dbPath: string, host: StorageReclaimHost | undefined): ProjectStorage {
  let usage: StoreUsage | undefined
  const listeners = new Set<(usage: StoreUsage) => void>()
  const storage: ProjectStorage = {
    usage: () => usage,
    onUsage(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    report(next) {
      usage = next
      for (const listener of listeners) listener(next)
    },
    last: () => host?.last(),
    takeAnnouncement: () => host?.takeAnnouncement(),
    preview() {
      // Planning the superseded rows walks their payloads, a minute on a
      // large store and on the account's own thread, past the preview's
      // deadline; idle reclaim plans them in its Worker after each open.
      const current = readStoreUsage(dbPath, usage?.supersededBytes ?? 0)
      if (!current) return null
      storage.report(current)
      const needs = vacuumSpaceNeeds(dbPath, current)
      const tightest = needs.reduce((least, need) => need.freeBytes - need.neededBytes < least.freeBytes - least.neededBytes ? need : least)
      const refusal = vacuumSpaceShortfall(needs)
      return {
        storeBytes: current.storeBytes,
        reclaimableBytes: current.reclaimableBytes,
        freeBytes: tightest.freeBytes,
        neededBytes: tightest.neededBytes,
        ...(refusal === undefined ? {} : { refusal }),
      }
    },
    reclaim() {
      if (!host) return { kind: "refused", message: "Reclaim storage runs only in the account service." }
      const preview = storage.preview()
      if (!preview) return { kind: "refused", message: "This project holds no Flywheel store." }
      if (preview.refusal !== undefined) return { kind: "refused", message: preview.refusal }
      if (host.start() === "running") return { kind: "refused", message: RUNNING }
      return { kind: "started" }
    },
  }
  return storage
}
