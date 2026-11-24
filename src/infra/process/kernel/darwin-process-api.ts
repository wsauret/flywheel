import * as bunFfi from "bun:ffi"

import { openKernelApiOnce } from "./kernel-api-open.js"

/** macOS process facts, read from the kernel rather than from a program.
 *
 *  Linux answers process questions from `/proc` and Windows asks kernel32, so
 *  neither starts a process to observe one. macOS has no `/proc`, and its
 *  process tools are programs: a question asked through `ps` or `pgrep` costs a
 *  process start, and under load that start can take longer than any budget a
 *  caller can wait for. A probe that ran out of time proves nothing, and a
 *  decision that waits on it either stalls or guesses. libproc is what those
 *  programs read. It answers in microseconds, starts nothing, and is part of
 *  `libSystem`, the library every macOS process already runs on. */

/** What one process query proved.
 *
 *  `absent` proves that no process runs under the pid: either nothing holds
 *  the number, or the process exited and only its unreaped status remains.
 *  `unavailable` is a query that did not answer, and proves nothing at all.
 *  Every call the query makes answers for a process of any user, so a process
 *  that exists never reads as absent for lack of permission.
 *
 *  `identity` is `pid pgid uniqueid`. The unique id is the kernel's own number
 *  for the process, which it never gives to another process within one boot,
 *  so a recycled pid cannot match it. `start` is the unique id alone, as a
 *  decimal: the start stamp a durable holder record keeps beside the boot.
 *  `ppid` is the pid of the process's parent now: launchd (pid 1) adopts a
 *  process whose parent exited. */
export type DarwinProcessQuery =
  | { readonly kind: "process"; readonly pgid: number; readonly ppid: number; readonly identity: string; readonly start: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" }

/** The boot this host runs, named by the kernel's boot session UUID as 32
 *  lowercase hex characters, or `none` when the kernel names no such value.
 *  The unique id counts from the start of each boot, so a start stamp is
 *  unique only together with the boot. */
export type DarwinBootSession = { readonly kind: "boot"; readonly id: string } | { readonly kind: "none" }

/** The executable a process runs, as the kernel names it. `absent` proves
 *  that no process runs under the pid; `unavailable` is a call that failed
 *  for another reason, such as a process of another user, and proves
 *  nothing. */
export type DarwinExecutable =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" }

export interface DarwinProcessApi {
  query(pid: number): DarwinProcessQuery
  /** Every pid the kernel holds in process group `pgid`, unreaped members
   *  included, or nothing when the listing did not answer. An empty list
   *  proves that the group holds no process. */
  group(pgid: number): readonly number[] | undefined
  /** Every pid the kernel holds, of every user, or nothing when the listing
   *  did not answer. */
  pids(): readonly number[] | undefined
  /** Every pid whose parent is `pid` now, or nothing when the listing did
   *  not answer. */
  children(pid: number): readonly number[] | undefined
  /** The path of the executable that `pid` runs. */
  executable(pid: number): DarwinExecutable
  /** The arguments and environment `pid` was started with, from one kernel
   *  read, or nothing when the kernel did not answer or its bytes do not hold
   *  the arguments. The environment contains `NAME=value` entries. The kernel
   *  answers only for a process of the same user. */
  processArguments(pid: number): { readonly argv: readonly string[]; readonly environment: readonly string[] } | undefined
  /** The environment `pid` was started with, as `NAME=value` entries, or
   *  nothing when the kernel did not answer. The kernel keeps the copy it
   *  handed the process at exec, and answers only for a process of the same
   *  user. */
  environment(pid: number): readonly string[] | undefined
  /** The boot this host runs, or nothing when the kernel did not answer. */
  bootSession(): DarwinBootSession | undefined
  /** The bytes of memory the kernel charges to `pid`, its physical
   *  footprint, or nothing when the kernel did not answer. This is the value
   *  `top` and Activity Monitor show as memory: resident and compressed
   *  memory, and compressed memory the kernel moved out to swap, so a process
   *  whose memory was swapped out still shows its whole size. */
  footprintBytes(pid: number): number | undefined
  /** How many threads of `pid` are ready to run right now, running or
   *  waiting for a processor, or nothing when the kernel did not answer. */
  runnableThreads(pid: number): number | undefined
}

/** The libproc and libc calls the API is built from, injected so that the
 *  mapping from return values and error codes to answers is testable on a host
 *  that is not macOS. */
export interface LibprocCalls {
  /** `proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, buffer, buffer.byteLength)`:
   *  the bytes written, or 0 with `errno` set. */
  shortInfo(pid: number, buffer: Uint8Array): number
  /** `proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, buffer,
   *  buffer.byteLength)`: the bytes written, or 0 with `errno` set. */
  uniqueInfo(pid: number, buffer: Uint8Array): number
  /** `proc_listpgrppids(pgid, buffer, buffer.byteLength)`: the number of pids
   *  written. A failed call returns 0 with `errno` set; a group that holds no
   *  process, or does not exist, returns 0 and leaves `errno` alone. */
  groupPids(pgid: number, buffer: Int32Array): number
  /** `proc_listallpids(buffer, buffer.byteLength)`: the number of pids
   *  written, or -1 when the call failed. */
  allPids(buffer: Int32Array): number
  /** `proc_listchildpids(ppid, buffer, buffer.byteLength)`: the number of
   *  pids written, or -1 when the call failed. */
  childPids(ppid: number, buffer: Int32Array): number
  /** `proc_pidpath(pid, buffer, buffer.byteLength)`: the bytes of the path
   *  written, without a terminator, or 0 with `errno` set. */
  executablePath(pid: number, buffer: Uint8Array): number
  /** `sysctl(CTL_KERN, KERN_PROCARGS2, pid)`: the bytes the kernel wrote,
   *  which are `argc`, the executable path, padding, the arguments, and the
   *  environment, or nothing when the call failed. The bytes stay valid only
   *  until the next call. */
  processArguments(pid: number): Uint8Array | undefined
  /** `sysctlbyname("kern.bootsessionuuid", buffer, &size, NULL, 0)`: the
   *  bytes written, the terminator included, or 0 with `errno` set. */
  bootSession(buffer: Uint8Array): number
  /** `proc_pid_rusage(pid, RUSAGE_INFO_V0, buffer)`: 0 when the kernel wrote
   *  the struct, or -1 with `errno` set. */
  resourceUsage(pid: number, buffer: Uint8Array): number
  /** `proc_pidinfo(pid, PROC_PIDTASKINFO, 0, buffer, buffer.byteLength)`:
   *  the bytes written, or 0 with `errno` set. */
  taskInfo(pid: number, buffer: Uint8Array): number
  /** The calling thread's `errno`. */
  errno(): number
  clearErrno(): void
}

type FfiModule = Pick<typeof bunFfi, "dlopen" | "FFIType" | "toArrayBuffer">

/** Builds the API over the calls.
 *
 *  Self-contained by contract: the process watchdog serializes this function
 *  into a Worker built from source text, so it closes over nothing outside its
 *  own body. That is also why the struct layouts are declared here and not at
 *  module scope. */
export function createDarwinProcessApi(calls: LibprocCalls): DarwinProcessApi {
  // `struct proc_bsdshortinfo` and `struct proc_uniqidentifierinfo` from
  // <sys/proc_info.h>. Every Mac is little-endian.
  const SHORT_INFO_SIZE = 64
  const OFFSET_PID = 0
  const OFFSET_PPID = 4
  const OFFSET_PGID = 8
  const OFFSET_STATUS = 12
  const UNIQUE_INFO_SIZE = 56
  const OFFSET_UNIQUE_ID = 16
  const STATUS_ZOMBIE = 5
  const ENOENT = 2
  const ESRCH = 3
  // The group listing grows until it is not full, because a full buffer can
  // hide members. The ceiling is far above the system's process limit, so a
  // listing that reaches it did not answer.
  const MAX_GROUP_PIDS = 1 << 20
  // PROC_PIDPATHINFO_MAXSIZE from <libproc.h>.
  const PATH_MAX_SIZE = 4 * 1024
  // A UUID string is 36 characters and a terminator.
  const BOOT_SESSION_SIZE = 64
  // `struct rusage_info_v0` from <sys/resource.h>: a 16-byte UUID, then ten
  // 64-bit counters, of which the eighth is `ri_phys_footprint`.
  const RESOURCE_USAGE_SIZE = 96
  const OFFSET_PHYS_FOOTPRINT = 72
  // `struct proc_taskinfo` from <sys/proc_info.h>: six 64-bit fields, then
  // 32-bit fields, of which `pti_numrunning` is at 88.
  const TASK_INFO_SIZE = 96
  const OFFSET_RUNNING_THREADS = 88
  const absent: DarwinProcessQuery = { kind: "absent" }
  const unavailable: DarwinProcessQuery = { kind: "unavailable" }
  const shortInfo = new Uint8Array(SHORT_INFO_SIZE)
  const shortView = new DataView(shortInfo.buffer)
  const uniqueInfo = new Uint8Array(UNIQUE_INFO_SIZE)
  const uniqueView = new DataView(uniqueInfo.buffer)
  let pids = new Int32Array(1024)
  let allPids = new Int32Array(4096)
  const pathBuffer = new Uint8Array(PATH_MAX_SIZE)
  const bootBuffer = new Uint8Array(BOOT_SESSION_SIZE)
  const resourceUsage = new Uint8Array(RESOURCE_USAGE_SIZE)
  const resourceUsageView = new DataView(resourceUsage.buffer)
  const taskInfo = new Uint8Array(TASK_INFO_SIZE)
  const taskView = new DataView(taskInfo.buffer)
  /** One `proc_pidinfo` call. A failed call reports its cause only through
   *  errno, which is cleared first, so a code left by an earlier call can
   *  never read as this call's answer. Only ESRCH proves an absence. */
  const read = (fill: () => number, size: number): "filled" | DarwinProcessQuery => {
    calls.clearErrno()
    const written = fill()
    if (written === size) return "filled"
    return written === 0 && calls.errno() === ESRCH ? absent : unavailable
  }
  const uniqueId = (pid: number): bigint | DarwinProcessQuery => {
    const unique = read(() => calls.uniqueInfo(pid, uniqueInfo), UNIQUE_INFO_SIZE)
    return unique === "filled" ? uniqueView.getBigUint64(OFFSET_UNIQUE_ID, true) : unique
  }
  /** The layout is a 32-bit `argc`, then NUL-terminated strings: the
   *  executable path, NUL padding, `argc` arguments, and the environment,
   *  which ends at an empty string before the loader's own strings. Bytes
   *  that end before the arguments do prove nothing. */
  const processArguments: DarwinProcessApi["processArguments"] = (pid) => {
    const bytes = calls.processArguments(pid)
    if (bytes === undefined || bytes.byteLength < 4) return undefined
    const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true)
    if (argc < 0) return undefined
    const decoder = new TextDecoder()
    let offset = 4
    const readString = (): string | undefined => {
      const end = bytes.indexOf(0, offset)
      if (end < 0) return undefined
      const text = decoder.decode(bytes.subarray(offset, end))
      offset = end + 1
      return text
    }
    if (readString() === undefined) return undefined
    while (offset < bytes.byteLength && bytes[offset] === 0) offset += 1
    const argv: string[] = []
    for (let index = 0; index < argc; index += 1) {
      const argument = readString()
      if (argument === undefined) return undefined
      argv.push(argument)
    }
    const environment: string[] = []
    for (let entry = readString(); entry !== undefined && entry.length > 0; entry = readString()) environment.push(entry)
    return { argv, environment }
  }
  return {
    /** The two structs come from two calls, and the pid can pass to another
     *  process between them. The unique id is read before and after the short
     *  info: the kernel never gives a unique id to a second process within one
     *  boot, so two equal reads prove that the short info between them came
     *  from the same process. Two different reads prove nothing about the pid. */
    query(pid) {
      const before = uniqueId(pid)
      if (typeof before !== "bigint") return before
      const short = read(() => calls.shortInfo(pid, shortInfo), SHORT_INFO_SIZE)
      if (short !== "filled") return short
      if (shortView.getUint32(OFFSET_PID, true) !== pid) return unavailable
      if (shortView.getUint32(OFFSET_STATUS, true) === STATUS_ZOMBIE) return absent
      const pgid = shortView.getUint32(OFFSET_PGID, true)
      const ppid = shortView.getUint32(OFFSET_PPID, true)
      const after = uniqueId(pid)
      if (typeof after !== "bigint") return after
      if (after !== before) return unavailable
      return { kind: "process", pgid, ppid, identity: `${pid} ${pgid} ${before}`, start: String(before) }
    },
    group(pgid) {
      for (;;) {
        calls.clearErrno()
        const count = calls.groupPids(pgid, pids)
        if (count === 0 && calls.errno() !== 0) return undefined
        if (count < pids.length) return Array.from(pids.subarray(0, count))
        if (pids.length >= MAX_GROUP_PIDS) return undefined
        pids = new Int32Array(pids.length * 2)
      }
    },
    /** Each listing grows until it is not full, as the group listing does. */
    pids() {
      for (;;) {
        const count = calls.allPids(allPids)
        if (count < 0) return undefined
        if (count < allPids.length) return Array.from(allPids.subarray(0, count))
        if (allPids.length >= MAX_GROUP_PIDS) return undefined
        allPids = new Int32Array(allPids.length * 2)
      }
    },
    children(pid) {
      for (;;) {
        const count = calls.childPids(pid, pids)
        if (count < 0) return undefined
        if (count < pids.length) return Array.from(pids.subarray(0, count))
        if (pids.length >= MAX_GROUP_PIDS) return undefined
        pids = new Int32Array(pids.length * 2)
      }
    },
    /** errno is cleared first, as for `proc_pidinfo`, so a code an earlier
     *  call left never reads as this call's. Only ESRCH proves an absence. */
    executable(pid) {
      calls.clearErrno()
      const written = calls.executablePath(pid, pathBuffer)
      if (written > 0) return { kind: "path", path: new TextDecoder().decode(pathBuffer.subarray(0, written)) }
      return written === 0 && calls.errno() === ESRCH ? { kind: "absent" } : { kind: "unavailable" }
    },
    processArguments,
    environment(pid) {
      return processArguments(pid)?.environment
    },
    /** Only ENOENT, the kernel stating it has no such value, is `none`. Any
     *  other failure, and bytes that are not a UUID, prove nothing. */
    bootSession() {
      calls.clearErrno()
      const written = calls.bootSession(bootBuffer)
      if (written === 0) return calls.errno() === ENOENT ? { kind: "none" } : undefined
      const bytes = bootBuffer.subarray(0, written)
      const end = bytes.indexOf(0)
      const id = new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)).replaceAll("-", "").toLowerCase()
      return /^[0-9a-f]{32}$/.test(id) ? { kind: "boot", id } : undefined
    },
    footprintBytes(pid) {
      if (calls.resourceUsage(pid, resourceUsage) !== 0) return undefined
      return Number(resourceUsageView.getBigUint64(OFFSET_PHYS_FOOTPRINT, true))
    },
    runnableThreads(pid) {
      return calls.taskInfo(pid, taskInfo) === TASK_INFO_SIZE ? taskView.getInt32(OFFSET_RUNNING_THREADS, true) : undefined
    },
  }
}

/** Opens the calls on the running thread. Throws when the library or a symbol
 *  cannot be loaded.
 *
 *  Self-contained by contract, like the builder above, and given the FFI module
 *  rather than importing it: a Worker built from source text imports it itself.
 *  `errno` is thread-local, so its address is read on the thread that makes the
 *  calls and is fixed for that thread's life. One view over that address both
 *  clears and reads it. */
export function openLibprocCalls(ffi: FfiModule): LibprocCalls {
  const PROC_PIDTASKINFO = 4
  const PROC_PIDT_SHORTBSDINFO = 13
  const PROC_PIDUNIQIDENTIFIERINFO = 17
  const RUSAGE_INFO_V0 = 0
  const CTL_KERN = 1
  const KERN_ARGMAX = 8
  const KERN_PROCARGS2 = 49
  const BOOT_SESSION_NAME = new TextEncoder().encode("kern.bootsessionuuid\0")
  const { FFIType } = ffi
  // libproc is part of libSystem, which also exports errno's location.
  const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_listpgrppids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  })
  const symbols = library.symbols
  const errnoAddress = symbols.__error()
  if (errnoAddress === null) throw new Error("errno has no address on this thread")
  const errnoCell = new Int32Array(ffi.toArrayBuffer(errnoAddress, 0, 4))
  // One buffer of `kern.argmax` bytes serves every read on this thread: a
  // scan for a container's mark reads the arguments of every process, and a
  // new buffer of that size for each one would cost far more than the call.
  let argumentBuffer: Uint8Array | undefined
  return {
    shortInfo: (pid, buffer) => symbols.proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0n, buffer, buffer.byteLength),
    uniqueInfo: (pid, buffer) => symbols.proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0n, buffer, buffer.byteLength),
    groupPids: (pgid, buffer) => symbols.proc_listpgrppids(pgid, buffer, buffer.byteLength),
    allPids: (buffer) => symbols.proc_listallpids(buffer, buffer.byteLength),
    childPids: (ppid, buffer) => symbols.proc_listchildpids(ppid, buffer, buffer.byteLength),
    executablePath: (pid, buffer) => symbols.proc_pidpath(pid, buffer, buffer.byteLength),
    // The arguments and environment together never exceed `kern.argmax`, so
    // a buffer of that size always holds the whole answer.
    processArguments: (pid) => {
      if (argumentBuffer === undefined) {
        const argmax = new Int32Array(1)
        if (symbols.sysctl(new Int32Array([CTL_KERN, KERN_ARGMAX]), 2, argmax, new BigUint64Array([4n]), null, 0n) !== 0) return undefined
        const size = argmax[0] ?? 0
        if (size <= 0) return undefined
        argumentBuffer = new Uint8Array(size)
      }
      const buffer = argumentBuffer
      const size = buffer.byteLength
      const written = new BigUint64Array([BigInt(size)])
      if (symbols.sysctl(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]), 3, buffer, written, null, 0n) !== 0) return undefined
      return buffer.subarray(0, Number(written[0]))
    },
    bootSession: (buffer) => {
      const written = new BigUint64Array([BigInt(buffer.byteLength)])
      return symbols.sysctlbyname(BOOT_SESSION_NAME, buffer, written, null, 0n) === 0 ? Number(written[0]) : 0
    },
    resourceUsage: (pid, buffer) => symbols.proc_pid_rusage(pid, RUSAGE_INFO_V0, buffer),
    taskInfo: (pid, buffer) => symbols.proc_pidinfo(pid, PROC_PIDTASKINFO, 0n, buffer, buffer.byteLength),
    errno: () => errnoCell[0] ?? 0,
    clearErrno: () => { errnoCell[0] = 0 },
  }
}

const openedApi = openKernelApiOnce("libproc", () => createDarwinProcessApi(openLibprocCalls(bunFfi)))

/** The libproc process API of this process on macOS.
 *
 *  The library opens on the first question rather than when this module
 *  loads, so a process that never asks one pays nothing at start-up. A library
 *  that cannot be opened answers every question as unanswered: a caller that
 *  could not ask has proven nothing, and never reports an absence. */
export const darwinProcess: DarwinProcessApi = {
  query: (pid) => openedApi()?.query(pid) ?? { kind: "unavailable" },
  group: (pgid) => openedApi()?.group(pgid),
  executable: (pid) => openedApi()?.executable(pid) ?? { kind: "unavailable" },
  pids: () => openedApi()?.pids(),
  children: (pid) => openedApi()?.children(pid),
  processArguments: (pid) => openedApi()?.processArguments(pid),
  environment: (pid) => openedApi()?.environment(pid),
  bootSession: () => openedApi()?.bootSession(),
  footprintBytes: (pid) => openedApi()?.footprintBytes(pid),
  runnableThreads: (pid) => openedApi()?.runnableThreads(pid),
}
