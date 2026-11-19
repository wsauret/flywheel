import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { readStoreUsage } from "../../../../src/orchestration/session/event-store-maintenance.js"
import { reclaimStoreExclusively, sqliteTemporaryDirectory, vacuumSpaceRefusal, vacuumSpaceShortfall } from "../../../../src/orchestration/session/store-reclaim.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { canonicalTestDirectory, temporaryDirectories, testDirectories } from "../../../helpers/directories.js"

const temporary = temporaryDirectories()
const GiB = 1024 * 1024 * 1024

describe("Reclaim storage", () => {
  test("refuses a short volume with how much more space it needs, and passes one with room", () => {
    expect(vacuumSpaceRefusal([{ directory: "/data", neededBytes: 3 * GiB, freeBytes: 4 * GiB }])).toBeUndefined()
    expect(vacuumSpaceRefusal([{ directory: "/data", neededBytes: 3 * GiB, freeBytes: GiB }])).toBe(
      "Reclaim storage needs 3.0 GiB free on the disk that holds /data, and 1.0 GiB is free. Free 2.0 GiB more, then run it again. Nothing was changed.",
    )
    expect(vacuumSpaceShortfall([{ directory: "/data", neededBytes: 3 * GiB, freeBytes: GiB }])).toBe("Free 2.0 GiB more on the disk that holds /data to reclaim storage.")
  })

  test.skipIf(process.platform === "win32")("checks the directory SQLite builds the copy in, which is not the runtime's temporary directory", () => {
    const chosen = temporary("flywheel-sqlite-tmp-")
    expect(sqliteTemporaryDirectory({ SQLITE_TMPDIR: chosen, TMPDIR: "/scratch/absent" })).toBe(chosen)
    expect(sqliteTemporaryDirectory({ SQLITE_TMPDIR: "/scratch/absent", TMPDIR: chosen })).toBe(chosen)
    // With neither set SQLite uses /var/tmp, where `os.tmpdir()` answers /tmp.
    expect(sqliteTemporaryDirectory({})).toBe("/var/tmp")
  })

  test("prunes and rebuilds a store no runtime has open, and moves it to incremental mode", async () => {
    const projectRoot = canonicalTestDirectory(temporary("flywheel-store-reclaim-"))
    const directories = testDirectories(projectRoot)
    const prepared = prepareWorkspaceState(directories)
    prepared.generation.release()
    const dbPath = resolveEventStoreDbFile(projectRoot)
    const db = new Database(dbPath)
    try {
      // A store an older release created: no auto-vacuum mode.
      db.exec("PRAGMA auto_vacuum = NONE")
      db.exec("VACUUM")
      db.exec("insert into event_sequence (aggregate_id, seq) values ('session:old', 4)")
      db.query(`
        with recursive n(i) as (select 0 union all select i + 1 from n where i < 3)
        insert into event (id, aggregate_id, seq, type, version, timestamp, actor, session_id, payload)
        select 'old-' || i, 'session:old', i + 1, 'model.stream.event_observed', 1, 1000 + i, 'provider', 'old', $payload from n
      `).run({ $payload: JSON.stringify({ blob: "x".repeat(1024 * 1024) }) })
    } finally {
      db.close()
    }
    expect(readStoreUsage(dbPath, 0)?.incremental).toBe(false)

    const outcome = await reclaimStoreExclusively(projectRoot)

    expect(outcome).toMatchObject({ kind: "reclaimed", rowsDeleted: 4 })
    if (outcome.kind !== "reclaimed") throw new Error("not reclaimed")
    expect(outcome.afterBytes).toBeLessThan(outcome.beforeBytes / 2)
    expect(readStoreUsage(dbPath, 0)?.incremental).toBe(true)
  })

  test("refuses a project that holds no store and changes nothing", async () => {
    const projectRoot = canonicalTestDirectory(temporary("flywheel-store-reclaim-empty-"))
    expect(await reclaimStoreExclusively(projectRoot)).toMatchObject({ kind: "refused", reason: "no-store" })
  })
})
