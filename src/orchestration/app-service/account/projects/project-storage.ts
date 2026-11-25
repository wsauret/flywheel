import type { StartupDirectories } from "../../../../infra/directory-authorities.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import type { StoreUsage } from "../../../session/persistence/storage/event-store-maintenance.js"
import type { AccountService } from "../account-service.js"
import type { MaintenanceQueue } from "../../background/runtime-maintenance-owner.js"
import { readStoreUsage } from "../../../session/persistence/storage/event-store-maintenance.js"
import { vacuumSpaceNeeds, vacuumSpaceShortfall } from "../../../workspace-state/store-reclaim.js"
import type { StorageReclaimOutcome, StorageReclaimPreview } from "../../../../protocol/store-reclaim.js"

const log = Log.create({ service: "storage-reclaim" })

/** The largest store the service converts to incremental auto-vacuum by
 *  itself. A conversion is a full VACUUM with the project closed, and below
 *  this size it ends within about half a minute: a 1.95 GiB store with
 *  1.5 GiB live took 22 s on a loaded Mac. A larger store converts only when
 *  the person runs Reclaim storage. */
export const AUTOMATIC_CONVERSION_MAX_STORE_BYTES = 2 * 1024 ** 3

/** Who started a Reclaim storage run: the person's command, or the service's
 *  automatic conversion of a small store from an older release. */
type ReclaimTrigger = "command" | "automatic"

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
   *  reopened it yet. An automatic run raises no notification. */
  start(trigger: ReclaimTrigger): "started" | "running"
  /** True the first time this open asks, so the automatic conversion is
   *  tried at most once per open; always false in the open that an automatic
   *  run's own reopen made, so a run that was refused or failed after the
   *  close never closes the project again and again. */
  claimAutomaticTry(): boolean
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
  /** Converts a store that an older release created to incremental
   *  auto-vacuum through the command's own run, without a notification: only
   *  once per open, only when the live usage shows a store under
   *  `AUTOMATIC_CONVERSION_MAX_STORE_BYTES` not in incremental mode, and only
   *  when the space check the command refuses on passes. The caller asks only
   *  while the project runs no work. Answers whether the run started. */
  convertIfSmall(): boolean
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
  // A root stays here from an automatic run's reopen until that open settles,
  // so the open the run made never tries the conversion again.
  const automaticReopens = new Set<string>()
  const run = (projectRoot: string, directories: StartupDirectories, trigger: ReclaimTrigger): void => {
    const started = performance.now()
    const projects = options.projects()
    void projects.closeFor(projectRoot, "storage reclaim", { step: "storage-reclaim" }, () => options.maintenance.reclaim(directories))
      .catch((error: unknown): StorageReclaimOutcome => ({ kind: "failed", message: errorMessage(error) }))
      .then((outcome) => {
        records.set(projectRoot, { outcome, at: Date.now() })
        // The person did not ask for an automatic run, and nothing they ran
        // was cut, so only the Storage status row shows it.
        if (trigger === "command") unannounced.add(projectRoot)
        else automaticReopens.add(projectRoot)
        log.info("storage reclaim done", {
          projectRoot, trigger, outcome: outcome.kind, durationMs: Math.round(performance.now() - started),
          ...(outcome.kind === "reclaimed" ? { beforeBytes: outcome.beforeBytes, afterBytes: outcome.afterBytes, rowsDeleted: outcome.rowsDeleted } : {}),
          ...(outcome.kind === "refused" ? { reason: outcome.reason } : {}),
        })
        return projects.open(projectRoot, "storage reclaim")
      })
      .catch((error: unknown) => { log.warn("storage reclaim reopen failed", { projectRoot, error: errorMessage(error) }) })
      .finally(() => {
        running.delete(projectRoot)
        automaticReopens.delete(projectRoot)
      })
  }
  return {
    host: (projectRoot: string, directories: StartupDirectories): StorageReclaimHost => {
      let automaticTry = !automaticReopens.has(projectRoot)
      return {
        start(trigger) {
          if (running.has(projectRoot)) return "running"
          running.add(projectRoot)
          // The close ends the connection the starting call came on. Its
          // answer travels from this call to the socket in the promise jobs of
          // this task, with no I/O between, so a close begun on a later task
          // never cuts it. No call waits on an automatic run, which closes at
          // once, in the task that found the project idle.
          if (trigger === "automatic") run(projectRoot, directories, trigger)
          else setImmediate(() => { run(projectRoot, directories, trigger) })
          return "started"
        },
        claimAutomaticTry() {
          const claimed = automaticTry
          automaticTry = false
          return claimed
        },
        last: () => records.get(projectRoot),
        takeAnnouncement() {
          if (!unannounced.delete(projectRoot)) return undefined
          return records.get(projectRoot)
        },
      }
    },
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
    convertIfSmall() {
      if (!host?.claimAutomaticTry() || usage === undefined || usage.incremental) return false
      if (usage.storeBytes >= AUTOMATIC_CONVERSION_MAX_STORE_BYTES) {
        log.debug("automatic store conversion skipped", { dbPath, reason: "store-size", storeBytes: usage.storeBytes })
        return false
      }
      // The usage the last job reported is enough here: the run reads the
      // store again and checks the space again before it deletes anything.
      const needs = vacuumSpaceNeeds(dbPath, usage)
      if (vacuumSpaceShortfall(needs) !== undefined) {
        log.info("automatic store conversion skipped", { dbPath, reason: "disk-space", storeBytes: usage.storeBytes, volumes: needs.map((need) => ({ neededBytes: need.neededBytes, freeBytes: need.freeBytes })) })
        return false
      }
      // The close this starts makes an open that arrives meanwhile wait on
      // the storage-reclaim step, as for the command. That wait is acceptable
      // because the project was idle, the store is small, so the VACUUM ends
      // within about half a minute, and it happens once per store.
      return host.start("automatic") === "started"
    },
    reclaim() {
      if (!host) return { kind: "refused", message: "Reclaim storage runs only in the account service." }
      const preview = storage.preview()
      if (!preview) return { kind: "refused", message: "This project holds no Flywheel store." }
      if (preview.refusal !== undefined) return { kind: "refused", message: preview.refusal }
      if (host.start("command") === "running") return { kind: "refused", message: RUNNING }
      return { kind: "started" }
    },
  }
  return storage
}
