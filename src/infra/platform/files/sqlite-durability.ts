import type { Database } from "bun:sqlite"

/**
 * Durability contract shared by every Flywheel SQLite store: WAL lets
 * concurrent processes read while one writes, and NORMAL synchronous is the
 * WAL-safe fsync level. The busy timeout is each store's own lock posture, so
 * the caller states it: bun:sqlite blocks synchronously for the whole wait,
 * which an event store spends to land a write, an availability authority
 * spends only while it acquires its file, and a store the request path reads
 * through must not spend at all.
 *
 * The busy timeout goes first. `journal_mode = WAL` takes an exclusive lock,
 * so a handle that sets it before the timeout fails instantly whenever
 * another process holds the database, which is exactly the moment the timeout
 * exists for.
 */
export function applySqliteBusyTimeout(db: Database, busyTimeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
}

/** Pause between two attempts of the switch to WAL. */
const WAL_SWITCH_RETRY_MS = 5

export function applySqliteDurabilityPragmas(db: Database, busyTimeoutMs: number): void {
  applySqliteBusyTimeout(db, busyTimeoutMs)
  switchToWal(db, busyTimeoutMs)
  db.exec("PRAGMA synchronous = NORMAL")
}

/** The busy timeout does not cover the switch of a database that is not yet in
 *  WAL mode, which is every new store. SQLite reads the header in a read
 *  transaction and then upgrades it to a write. It never calls the busy
 *  handler for a connection that holds a read lock, because two such waiters
 *  can deadlock. So when two connections create one store at the same moment,
 *  the one that loses the upgrade fails at once with SQLITE_BUSY. After the
 *  winner commits, the file is in WAL mode and the same statement is a no-op.
 *  So the switch tries again until the caller's busy timeout passes. That is
 *  the wait the caller already accepts, and a zero timeout still fails at
 *  once. */
function switchToWal(db: Database, busyTimeoutMs: number): void {
  const deadline = performance.now() + busyTimeoutMs
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL")
      return
    } catch (error) {
      if (!isSqliteBusyError(error) || performance.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAL_SWITCH_RETRY_MS)
    }
  }
}

/** True when a failed statement lost a race for the database write lock rather
 *  than carrying a bad write. bun:sqlite raises this after `busy_timeout`
 *  expires, so the caller's own patience (an async retry that does not park the
 *  loop) decides what happens next: the statement is still valid and landing it
 *  later is correct. */
export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? error.code : undefined
  if (typeof code === "string") return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
  return error.message.includes("database is locked") || error.message.includes("database table is locked")
}
