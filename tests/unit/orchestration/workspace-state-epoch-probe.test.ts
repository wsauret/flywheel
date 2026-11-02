/** The generation epoch probe's openability contract.
 *
 *  Startup classifies a workspace by reading the store's user_version. That
 *  probe must classify every store SQLite can recover, because a refusal
 *  makes the runtime worker respawn against the same refusal forever. */

import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { WORKSPACE_STATE_EPOCH } from "../../../src/orchestration/workspace-state-retirement.js"
import { testDirectories } from "../../helpers/directories.js"
import type { ProjectDirectories } from "../../../src/infra/directory-authorities.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-epoch-probe-${process.pid}-${Date.now()}`)

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function makeWorkspace(): ProjectDirectories {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return testDirectories(dir)
}

function prepareAndRelease(directories: ProjectDirectories): void {
  prepareWorkspaceState(directories).generation.release()
}

function readEpoch(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true })
  try {
    const row = db.query<{ user_version?: unknown }, []>("PRAGMA user_version").get()
    return typeof row?.user_version === "number" ? row.user_version : 0
  } finally {
    db.close()
  }
}

describe("the generation epoch probe", () => {
  it("classifies a WAL store whose stale shm blocks a readonly open instead of refusing the workspace", () => {
    const directories = makeWorkspace()
    prepareAndRelease(directories)
    const dbFile = resolveEventStoreDbFile(directories.projectRoot)

    // Rebuild the state a crash or copy leaves: a WAL-flagged main file with
    // a stale -shm and no -wal. SQLite then refuses a readonly open with
    // SQLITE_CANTOPEN because WAL-index recovery must write the sidecars.
    const db = new Database(dbFile)
    try {
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("CREATE TABLE probe (id integer primary key)")
    } finally {
      db.close()
    }
    fs.rmSync(`${dbFile}-wal`, { force: true })
    fs.writeFileSync(`${dbFile}-shm`, Buffer.alloc(32768))

    // Precondition where the platform's SQLite enforces it: the readonly
    // probe cannot open this state (SQLITE_CANTOPEN, WAL-index recovery must
    // write the sidecars). Some builds recover the sidecars even readonly;
    // there the fallback fixture does not exist and only classification is
    // assertable.
    try {
      readEpoch(dbFile)
    } catch (err) {
      expect(String(err)).toContain("unable to open database file")
    }

    // The epoch probe falls back to a write-capable open, which recovers
    // only the sidecars, never database content. It must classify the store,
    // not refuse it: a refusal makes the runtime worker respawn forever.
    expect(() => prepareAndRelease(directories)).not.toThrow()
    expect(readEpoch(dbFile)).toBe(WORKSPACE_STATE_EPOCH)
  })
})
