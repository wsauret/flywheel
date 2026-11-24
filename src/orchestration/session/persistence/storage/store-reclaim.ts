import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { openExistingContainedDirectory } from "../../../../infra/descriptor-directory.js"
import { FLYWHEEL_DIR_NAME } from "../../../../infra/directory-authorities.js"
import { resolveEventStoreDbFile } from "../../../../infra/paths.js"
import { formatStorageBytes, type StorageReclaimOutcome } from "../../../../protocol/store-reclaim.js"
import { acquireProjectStateGeneration } from "../../../project-state-lease.js"
import { pruneRetiredFactFamilies, pruneSupersededFacts, readStoreUsage, vacuumEventStore, type StoreUsage } from "./event-store-maintenance.js"

/** Free space kept beyond what a VACUUM writes, so the rebuild never fills
 *  the disk to its last byte. */
const VACUUM_MARGIN_BYTES = 256 * 1024 * 1024

/** One volume a VACUUM writes to, and the space it needs there. */
interface VolumeNeed {
  readonly directory: string
  readonly neededBytes: number
  readonly freeBytes: number
}

/** The directory SQLite builds a VACUUM's copy in, chosen as SQLite's Unix
 *  VFS chooses it: SQLITE_TMPDIR, then TMPDIR, then the first writable of
 *  /var/tmp, /usr/tmp, and /tmp, then the working directory. This differs
 *  from `os.tmpdir()`, which falls back to /tmp, so a Linux host with TMPDIR
 *  unset builds the copy in /var/tmp. On Windows SQLite asks the system for
 *  its temporary path, as `os.tmpdir()` does. */
export function sqliteTemporaryDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return os.tmpdir()
  const candidates = [env.SQLITE_TMPDIR, env.TMPDIR, "/var/tmp", "/usr/tmp", "/tmp"]
  return candidates.find((candidate) => candidate !== undefined && candidate !== "" && writableDirectory(candidate)) ?? process.cwd()
}

function writableDirectory(directory: string): boolean {
  try {
    if (!fs.statSync(directory).isDirectory()) return false
    fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The free space a full VACUUM of this store needs, per volume. SQLite
 *  builds the rebuilt copy in its temporary directory, then writes it back
 *  through the WAL beside the store, so each holds about the live data at
 *  once. When both are on one volume, that volume needs both. The bytes free
 *  are read now. */
export function vacuumSpaceNeeds(dbPath: string, usage: Pick<StoreUsage, "liveBytes">, temporaryDirectory = sqliteTemporaryDirectory()): readonly VolumeNeed[] {
  const storeDirectory = path.dirname(dbPath)
  const share = usage.liveBytes + VACUUM_MARGIN_BYTES
  if (fs.statSync(storeDirectory).dev === fs.statSync(temporaryDirectory).dev) {
    return [{ directory: storeDirectory, neededBytes: 2 * share, freeBytes: freeBytes(storeDirectory) }]
  }
  return [
    { directory: storeDirectory, neededBytes: share, freeBytes: freeBytes(storeDirectory) },
    { directory: temporaryDirectory, neededBytes: share, freeBytes: freeBytes(temporaryDirectory) },
  ]
}

/** The refusal a run that met a short volume earns, naming how much more
 *  space it needs, or undefined when every volume has room. */
export function vacuumSpaceRefusal(needs: readonly VolumeNeed[]): string | undefined {
  const short = shortVolumes(needs)
  if (short.length === 0) return undefined
  return short.map((need) =>
    `Reclaim storage needs ${formatStorageBytes(need.neededBytes)} free on the disk that holds ${need.directory}, and ${formatStorageBytes(need.freeBytes)} is free. Free ${formatStorageBytes(need.neededBytes - need.freeBytes)} more, then run it again. Nothing was changed.`,
  ).join(" ")
}

/** What the preview tells the person before a run when a volume is short,
 *  or undefined when every volume has room. The preview rows already show
 *  the free and needed sizes, so it names only what to free and where. */
export function vacuumSpaceShortfall(needs: readonly VolumeNeed[]): string | undefined {
  const short = shortVolumes(needs)
  if (short.length === 0) return undefined
  return short.map((need) => `Free ${formatStorageBytes(need.neededBytes - need.freeBytes)} more on the disk that holds ${need.directory} to reclaim storage.`).join(" ")
}

function shortVolumes(needs: readonly VolumeNeed[]): readonly VolumeNeed[] {
  return needs.filter((need) => need.freeBytes < need.neededBytes)
}

/** The space the person can see as free on the volume of `directory`. */
function freeBytes(directory: string): number {
  const stats = fs.statfsSync(directory)
  return stats.bavail * stats.bsize
}

/** Runs the whole reclaim on a store no runtime has open: takes the project's
 *  state generation exclusively, checks the space again, deletes the retired
 *  and the superseded rows, and rebuilds the file, which also moves it to
 *  incremental auto-vacuum. Another process that holds the generation, such
 *  as a headless run, refuses it with nothing changed. Synchronous and
 *  minutes long on a large store, so only a Worker calls it. */
export async function reclaimStoreExclusively(projectRoot: string): Promise<StorageReclaimOutcome> {
  const flywheel = openExistingContainedDirectory(projectRoot, [FLYWHEEL_DIR_NAME])
  if (!flywheel) return { kind: "refused", reason: "no-store", message: "This project holds no Flywheel store." }
  const generation = acquireProjectStateGeneration(flywheel)
  try {
    if (generation.otherOwnersLive) {
      return { kind: "refused", reason: "busy", message: "Another Flywheel process has this project open. Close it, then run Reclaim storage again. Nothing was changed." }
    }
    const dbPath = resolveEventStoreDbFile(projectRoot)
    // Only the sizes are read here; the run itself deletes every superseded row.
    const usage = readStoreUsage(dbPath, 0)
    if (!usage) return { kind: "refused", reason: "no-store", message: "This project holds no Flywheel store." }
    const refusal = vacuumSpaceRefusal(vacuumSpaceNeeds(dbPath, usage))
    if (refusal) return { kind: "refused", reason: "disk-space", message: refusal }
    const retired = await pruneRetiredFactFamilies(dbPath)
    const superseded = pruneSupersededFacts(dbPath)
    vacuumEventStore(dbPath, { force: true })
    return {
      kind: "reclaimed",
      beforeBytes: usage.storeBytes,
      afterBytes: readStoreUsage(dbPath, 0)?.storeBytes ?? 0,
      rowsDeleted: retired.rowsDeleted + superseded.rowsDeleted,
    }
  } finally {
    generation.release()
  }
}
