import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"

import { applySqliteDurabilityPragmas, isSqliteBusyError } from "../../../src/infra/sqlite-durability.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const tempDir = temporaryDirectories()

/** How long the peer keeps the new database locked after the switch starts.
 *  The switch meets the lock on its first attempt, and the case stays fast. */
const PEER_HOLD_MS = 20

/** A new, empty store file, as `ensurePrivateFile` leaves it before the first
 *  connection configures it. */
function newStoreFile(): string {
  const file = join(tempDir("sqlite-durability-"), "store.sqlite")
  writeFileSync(file, "")
  return file
}

function nextMessage(worker: Worker, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      worker.off("error", onError)
      if (message === expected) resolve()
      else reject(new Error(`expected ${expected}, got ${String(message)}`))
    }
    const onError = (error: Error) => {
      worker.off("message", onMessage)
      reject(error)
    }
    worker.once("message", onMessage)
    worker.once("error", onError)
  })
}

describe("applySqliteDurabilityPragmas", () => {
  test("waits for a peer that holds a new database's write lock, then switches it to WAL", async () => {
    const file = newStoreFile()
    const started = new SharedArrayBuffer(4)
    const peer = new Worker(new URL("fixtures/sqlite-write-lock-peer.ts", import.meta.url), {
      workerData: { file, started, holdMs: PEER_HOLD_MS },
    })
    try {
      await nextMessage(peer, "held")
      const released = nextMessage(peer, "released")
      const db = new Database(file)
      try {
        const flag = new Int32Array(started)
        Atomics.store(flag, 0, 1)
        Atomics.notify(flag, 0)
        applySqliteDurabilityPragmas(db, 5_000)
        expect(db.query("pragma journal_mode").get()).toEqual({ journal_mode: "wal" })
      } finally {
        db.close()
      }
      await released
    } finally {
      await peer.terminate()
    }
  })

  test("gives up with the busy error once its busy timeout passes", () => {
    const file = newStoreFile()
    const holder = new Database(file)
    const db = new Database(file)
    try {
      holder.exec("BEGIN IMMEDIATE")
      let failure: unknown
      try {
        applySqliteDurabilityPragmas(db, 10)
      } catch (error) {
        failure = error
      }
      expect(isSqliteBusyError(failure)).toBe(true)
    } finally {
      db.close()
      holder.exec("ROLLBACK")
      holder.close()
    }
  })
})
