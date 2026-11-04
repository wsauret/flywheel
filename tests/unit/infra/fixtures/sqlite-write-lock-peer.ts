import { Database } from "bun:sqlite"
import { parentPort, workerData } from "node:worker_threads"

/** A second connection, on its own thread, that holds the write lock of a new
 *  database while the test thread switches that database to WAL, as a peer
 *  that creates the same store at the same moment does. It reports `held`
 *  once it holds the lock. When the test thread marks `started`, it keeps the
 *  lock for `holdMs` more and then reports `released`. The test thread blocks
 *  inside the switch, so the peer releases on its own clock. */
const data: unknown = workerData
if (typeof data !== "object" || data === null || !("file" in data) || !("started" in data) || !("holdMs" in data)) {
  throw new Error("worker data needs file, started, and holdMs")
}
const { file, started, holdMs } = data
if (typeof file !== "string" || !(started instanceof SharedArrayBuffer) || typeof holdMs !== "number") {
  throw new TypeError("worker data has the wrong types")
}

const db = new Database(file)
try {
  // The peer's commit needs the test thread's read lock gone, and the test
  // thread holds it for a moment on each attempt of its switch. A product
  // connection sets a busy timeout before it writes, and so does this peer.
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("BEGIN IMMEDIATE")
  parentPort?.postMessage("held", [])
  Atomics.wait(new Int32Array(started), 0, 0)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs)
  db.exec("COMMIT")
} finally {
  db.close()
}
parentPort?.postMessage("released", [])
