const STORAGE_FAILURE_CODE = /^(?:SQLITE_(?:BUSY|LOCKED|FULL|IOERR|READONLY|CANTOPEN)|ENOSPC|EDQUOT|EROFS|EIO)/
const STORAGE_FAILURE_MESSAGE = /database is locked|database table is locked|database or disk is full|disk I\/O error|attempt to write a readonly database|unable to open database file|no space left on device|\b(?:ENOSPC|EDQUOT|EROFS)\b/i

/** True when a write failed because of the place it writes to, not because
 *  of what it wrote: the disk is full or over quota, the file system or the
 *  database file is read-only or cannot be opened, an I/O call failed, or
 *  another connection held the database lock. The remedy is then outside
 *  Flywheel's data, so a person must free the disk or the lock rather than
 *  repair history. A wrapped error is checked through its causes and, for an
 *  AggregateError, its members; an error that crossed a process boundary as
 *  text is checked by its message. */
export function isStorageFailure(error: unknown): boolean {
  const pending: unknown[] = [error]
  for (let checked = 0; pending.length > 0 && checked < 32; checked += 1) {
    const current = pending.pop()
    if (!(current instanceof Error)) continue
    const code = "code" in current ? current.code : undefined
    if (typeof code === "string" && STORAGE_FAILURE_CODE.test(code)) return true
    if (STORAGE_FAILURE_MESSAGE.test(current.message)) return true
    pending.push(current.cause)
    if (current instanceof AggregateError) pending.push(...current.errors)
  }
  return false
}
