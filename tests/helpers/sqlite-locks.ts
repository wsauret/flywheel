import { FFIType, ptr } from "bun:ffi"
import { closeSync, openSync } from "node:fs"

import { bindLibc } from "../../src/infra/libc.js"

/** Linux open-file-description locks conflict with the classic record locks
 *  that SQLite takes, even inside the process that holds them. So only Linux
 *  can show, from inside one test process, what another process sees. */
export const canObserveSqliteLocks = process.platform === "linux"

const F_OFD_GETLK = 36
const F_WRLCK = 1
const F_UNLCK = 2

/** SQLite's lock bytes: the SHARED range of the database file, which every
 *  open WAL connection holds, and the DMS byte of the -shm file, which tells
 *  the next connection that the shared memory is live and must not be reset. */
const DATABASE_SHARED_FIRST = 0x40000002
const DATABASE_SHARED_SIZE = 510
const SHARED_MEMORY_DMS = 128

/** What another process sees of the open connections on `dbFile`. The two
 *  probe descriptors stay open until both answers are read, because the close
 *  of a descriptor itself releases the locks that it reports. So call this
 *  last, after every other check of the connection. */
export function sqliteLocksSeenByOtherProcesses(dbFile: string) {
  const libc = bindLibc({ fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
  if (!canObserveSqliteLocks || libc === undefined) throw new Error("SQLite lock observation needs Linux open-file-description locks")
  const databaseFd = openSync(dbFile, "r")
  const sharedMemoryFd = openSync(`${dbFile}-shm`, "r")
  try {
    return {
      database: heldByAnyone(libc.fcntl, databaseFd, DATABASE_SHARED_FIRST, DATABASE_SHARED_SIZE),
      sharedMemory: heldByAnyone(libc.fcntl, sharedMemoryFd, SHARED_MEMORY_DMS, 1),
    }
  } finally {
    closeSync(databaseFd)
    closeSync(sharedMemoryFd)
  }
}

/** The 64-bit Linux `struct flock`: l_type and l_whence as shorts, l_start and
 *  l_len as 64-bit offsets, then l_pid. */
function heldByAnyone(fcntl: (fd: number, command: number, lock: ReturnType<typeof ptr>) => number, fd: number, start: number, length: number): boolean {
  const lock = new DataView(new ArrayBuffer(32))
  lock.setInt16(0, F_WRLCK, true)
  lock.setBigInt64(8, BigInt(start), true)
  lock.setBigInt64(16, BigInt(length), true)
  if (fcntl(fd, F_OFD_GETLK, ptr(lock)) !== 0) throw new Error("fcntl(F_OFD_GETLK) failed")
  return lock.getInt16(0, true) !== F_UNLCK
}
