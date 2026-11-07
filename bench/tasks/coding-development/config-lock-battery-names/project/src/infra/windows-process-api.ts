import { dlopen, FFIType, ptr } from "bun:ffi"

import { openKernelApiOnce } from "./kernel-api-open.js"

/** Windows process facts, read from the kernel rather than from a program.
 *
 *  Every other platform answers container questions without starting anything:
 *  Linux reads `/proc`, and macOS asks libproc. Windows has no
 *  `/proc`, and no native Windows command reports a process creation time,
 *  which is the one fact a container decision cannot do without - pids are
 *  recycled, and a recycled pid must never be mistaken for the process that
 *  held the number before it. Asking PowerShell for it costs most of a second,
 *  because starting the host dominates the query, and that cost is not
 *  incidental: the guardian may only lease a pid it can prove leads a
 *  container, so a probe slow enough to be abandoned makes every adoption fail.
 *
 *  These are the calls PowerShell would have made. They answer in microseconds,
 *  start no process, need no trusted program directory, and open no console
 *  window. `kernel32.dll` is not a dependency in any meaningful sense: it is
 *  the interface a Windows process is already running on top of. The one
 *  kill here goes through the same kernel surface, for the same reason: a
 *  program such as `taskkill` addresses a bare pid, and a handle can carry the
 *  identity check and the kill together. */

/** What one process query proved.
 *
 *  The three answers carry different rights, which is why an error code is read
 *  rather than treated as one failure. `absent` proves the pid holds no running
 *  process. `denied` is a process that exists and refuses to be examined, which
 *  is not an absence and never licenses a kill. `unavailable` is this side
 *  being unable to ask at all.
 *
 *  A pid whose process has exited but whose handle someone still holds reads as
 *  `absent`. Windows keeps such a process openable until its last handle
 *  closes, so opening one proves a process object survives and not that anything
 *  is running; a container asking whether it is empty would otherwise be told
 *  its own terminated members are alive. */
export type WindowsProcessQuery =
  | { readonly kind: "process"; readonly createdFileTime: bigint }
  | { readonly kind: "absent" }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" }

/** What one kill by creation time did. `ended` is a process the kernel took
 *  the kill for, through a handle whose creation time matched. `other` is a
 *  pid that now holds another process and `absent` a pid that holds none, and
 *  neither ends anything. `unproven` is a pid this side could not examine, or
 *  a kill the kernel refused: nothing this side can prove was ended. */
type WindowsTermination =
  | { readonly kind: "ended" }
  | { readonly kind: "other" }
  | { readonly kind: "absent" }
  | { readonly kind: "unproven" }

const ENDED = { kind: "ended" } as const satisfies WindowsTermination
const OTHER = { kind: "other" } as const satisfies WindowsTermination
const ABSENT = { kind: "absent" } as const satisfies WindowsTermination
const UNPROVEN = { kind: "unproven" } as const satisfies WindowsTermination

/** One row of the process table: a pid and the pid that started it. */
interface WindowsProcessRow {
  readonly pid: number
  readonly parentPid: number
}

export interface WindowsProcessApi {
  /** The creation time of `pid`, which with the pid forms a stable identity. */
  query(pid: number): WindowsProcessQuery
  /** The system time now, as a FILETIME: the unit and clock a creation time
   *  is stated in. */
  now(): bigint
  /** Ends `pid` only when the process it holds was created at
   *  `createdFileTime`. The creation time is read through the handle the kill
   *  uses, so a pid recycled between the check and the kill is never the
   *  process that is ended. The handle is always closed. */
  terminate(pid: number, createdFileTime: bigint): WindowsTermination
  /** Every process the system currently holds, or nothing when the snapshot
   *  itself failed. Nothing is not an empty table: a failed snapshot proves no
   *  absence. */
  list(): readonly WindowsProcessRow[] | undefined
  /** The bytes of `pid` that are resident in physical memory right now, the
   *  working set, which is what `ps` reports as RSS elsewhere; nothing when
   *  the process cannot be opened or examined. */
  workingSetBytes(pid: number): number | undefined
  /** The environment `pid` holds now, as `NAME=value` entries, or nothing
   *  when the process cannot be opened or its memory read. The kernel lets a
   *  process read the memory of a process of the same user only. */
  environment(pid: number): readonly string[] | undefined
}

/** `PROCESS_QUERY_LIMITED_INFORMATION`: enough to read a creation time, and
 *  the least authority that can. It succeeds against processes at a higher
 *  integrity level that `PROCESS_QUERY_INFORMATION` would be refused for. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
/** `PROCESS_TERMINATE`: added to the query right only to end a process. */
const PROCESS_TERMINATE = 0x0001
/** `PROCESS_VM_READ`: added to the query right only to read an environment. */
const PROCESS_VM_READ = 0x0010
const TH32CS_SNAPPROCESS = 0x2
const ERROR_ACCESS_DENIED = 5
const ERROR_INVALID_PARAMETER = 87

/** `PROCESSENTRY32W` on x64. Only two fields are read, so the rest of the
 *  structure is a size the kernel checks rather than a layout this file
 *  interprets. `dwSize` must be set before every call, because the kernel
 *  rejects a structure that does not declare its own size. */
const PROCESS_ENTRY_SIZE = 568
const PROCESS_ENTRY_OFFSET_SIZE = 0
const PROCESS_ENTRY_OFFSET_PID = 8
const PROCESS_ENTRY_OFFSET_PARENT_PID = 32

/** `INVALID_HANDLE_VALUE`, which the snapshot call returns instead of null. */
const INVALID_HANDLE = -1

/** `PROCESS_MEMORY_COUNTERS` on x64: `cb` first, and the working set at the
 *  fourth field. Only that one field is read. */
const MEMORY_COUNTERS_SIZE = 72
const MEMORY_COUNTERS_OFFSET_SIZE = 0
const MEMORY_COUNTERS_OFFSET_WORKING_SET = 16

/** The x64 layout that leads from a process to its environment block, which
 *  arm64 shares: `PROCESS_BASIC_INFORMATION` names the PEB at 8, the PEB
 *  names `RTL_USER_PROCESS_PARAMETERS` at 0x20, and those name the block at
 *  0x80 and its size in bytes at 0x3f0. The block is UTF-16 `NAME=value`
 *  strings, each ended by a NUL, and the list is ended by an empty string. */
const PROCESS_BASIC_INFORMATION_CLASS = 0
const BASIC_INFORMATION_SIZE = 48
const BASIC_INFORMATION_OFFSET_PEB = 8
const PEB_OFFSET_PROCESS_PARAMETERS = 0x20n
const PARAMETERS_OFFSET_ENVIRONMENT = 0x80n
const PARAMETERS_OFFSET_ENVIRONMENT_SIZE = 0x3f0n
/** Far above any real block. A stated size past it is not a block this side
 *  reads, so a corrupt parameters record cannot ask for an arbitrary buffer. */
const ENVIRONMENT_LIMIT_BYTES = 4 * 1024 * 1024

type Kernel32 = ReturnType<typeof openKernel32>
type Ntdll = ReturnType<typeof openNtdll>

function openKernel32() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    GetSystemTimeAsFileTime: { args: [FFIType.ptr], returns: FFIType.void },
    GetLastError: { args: [], returns: FFIType.u32 },
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
    Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    // The address is the target's, not this process's, so it is a number and
    // never a pointer this side dereferences.
    ReadProcessMemory: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  })
}

/** `ntdll.dll` holds the one call that names another process's PEB. Like
 *  kernel32 it is mapped into every Windows process before any code runs. */
function openNtdll() {
  return dlopen("ntdll.dll", {
    NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  })
}

/** Builds the API over already-opened libraries. Exported so the mapping from
 *  return values and error codes to answers can be tested without Windows. */
export function createWindowsProcessApi(kernel32: Kernel32, ntdll: Ntdll): WindowsProcessApi {
  const symbols = kernel32.symbols
  /** `size` bytes of the target's memory at `address`, or nothing when the
   *  kernel did not copy all of them. */
  const readRemote = (handle: NonNullable<ReturnType<typeof symbols.OpenProcess>>, address: bigint, size: number): Uint8Array | undefined => {
    const buffer = new Uint8Array(size)
    return symbols.ReadProcessMemory(handle, address, ptr(buffer), BigInt(size), null) ? buffer : undefined
  }
  const readAddress = (handle: NonNullable<ReturnType<typeof symbols.OpenProcess>>, address: bigint): bigint | undefined => {
    const bytes = readRemote(handle, address, 8)
    return bytes === undefined ? undefined : new DataView(bytes.buffer).getBigUint64(0, true)
  }
  /** The creation and exit time of the process `handle` names, or nothing
   *  when the kernel did not write them. One allocation holds the four
   *  FILETIME outputs: the creation time is the pid's identity and the exit
   *  time its liveness, and the last two exist because the call writes them.
   *  Each slot is addressed by its own byte offset rather than by pointer
   *  arithmetic, so the pointer type is never left behind. */
  const processTimes = (handle: NonNullable<ReturnType<typeof symbols.OpenProcess>>): { readonly created: bigint; readonly exited: bigint } | undefined => {
    const times = new BigUint64Array(4)
    if (!symbols.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return undefined
    const [created, exited] = times
    return created === undefined || exited === undefined ? undefined : { created, exited }
  }
  // Bound once and called through the alias: read directly, the Win32 name
  // trips a lint rule that reads any `...Error()` call as an error constructor.
  const lastError = symbols.GetLastError
  return {
    query(pid) {
      const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!handle) {
        const failure = lastError()
        if (failure === ERROR_INVALID_PARAMETER) return { kind: "absent" }
        return failure === ERROR_ACCESS_DENIED ? { kind: "denied" } : { kind: "unavailable" }
      }
      try {
        const times = processTimes(handle)
        if (times === undefined) return { kind: "unavailable" }
        // A running process has no exit time. One that has an exit time has
        // already ended, whatever still holds its handle open.
        if (times.exited !== 0n) return { kind: "absent" }
        return { kind: "process", createdFileTime: times.created }
      } finally {
        symbols.CloseHandle(handle)
      }
    },
    now() {
      const time = new Uint8Array(8)
      symbols.GetSystemTimeAsFileTime(ptr(time))
      return new DataView(time.buffer).getBigUint64(0, true)
    },
    terminate(pid, createdFileTime) {
      const handle = symbols.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!handle) return lastError() === ERROR_INVALID_PARAMETER ? ABSENT : UNPROVEN
      try {
        const times = processTimes(handle)
        if (times === undefined) return UNPROVEN
        if (times.exited !== 0n) return ABSENT
        if (times.created !== createdFileTime) return OTHER
        // Exit code 1, the code a terminated job gives each member.
        return symbols.TerminateProcess(handle, 1) ? ENDED : UNPROVEN
      } finally {
        symbols.CloseHandle(handle)
      }
    },
    list() {
      const snapshot = symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
      if (!snapshot || Number(snapshot) === INVALID_HANDLE) return undefined
      try {
        const entry = new Uint8Array(PROCESS_ENTRY_SIZE)
        const view = new DataView(entry.buffer)
        const address = ptr(entry)
        view.setUint32(PROCESS_ENTRY_OFFSET_SIZE, PROCESS_ENTRY_SIZE, true)
        if (!symbols.Process32FirstW(snapshot, address)) return undefined
        const rows: WindowsProcessRow[] = []
        do {
          rows.push({
            pid: view.getUint32(PROCESS_ENTRY_OFFSET_PID, true),
            parentPid: view.getUint32(PROCESS_ENTRY_OFFSET_PARENT_PID, true),
          })
          view.setUint32(PROCESS_ENTRY_OFFSET_SIZE, PROCESS_ENTRY_SIZE, true)
        } while (symbols.Process32NextW(snapshot, address))
        // A snapshot always holds the caller, so an empty table is a failed
        // walk rather than a system with no processes.
        return rows.length > 0 ? rows : undefined
      } finally {
        symbols.CloseHandle(snapshot)
      }
    },
    workingSetBytes(pid) {
      const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!handle) return undefined
      try {
        const counters = new Uint8Array(MEMORY_COUNTERS_SIZE)
        const view = new DataView(counters.buffer)
        view.setUint32(MEMORY_COUNTERS_OFFSET_SIZE, MEMORY_COUNTERS_SIZE, true)
        if (!symbols.K32GetProcessMemoryInfo(handle, ptr(counters), MEMORY_COUNTERS_SIZE)) return undefined
        return Number(view.getBigUint64(MEMORY_COUNTERS_OFFSET_WORKING_SET, true))
      } finally {
        symbols.CloseHandle(handle)
      }
    },
    environment(pid) {
      const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid)
      if (!handle) return undefined
      try {
        const information = new Uint8Array(BASIC_INFORMATION_SIZE)
        // An NTSTATUS of 0 is success; every other status is a failed query.
        if (ntdll.symbols.NtQueryInformationProcess(handle, PROCESS_BASIC_INFORMATION_CLASS, ptr(information), BASIC_INFORMATION_SIZE, null) !== 0) return undefined
        const peb = new DataView(information.buffer).getBigUint64(BASIC_INFORMATION_OFFSET_PEB, true)
        const parameters = peb === 0n ? undefined : readAddress(handle, peb + PEB_OFFSET_PROCESS_PARAMETERS)
        if (parameters === undefined || parameters === 0n) return undefined
        const block = readAddress(handle, parameters + PARAMETERS_OFFSET_ENVIRONMENT)
        const size = readAddress(handle, parameters + PARAMETERS_OFFSET_ENVIRONMENT_SIZE)
        if (block === undefined || block === 0n || size === undefined || size === 0n || size > BigInt(ENVIRONMENT_LIMIT_BYTES)) return undefined
        const bytes = readRemote(handle, block, Number(size))
        if (bytes === undefined) return undefined
        // A block without its ending empty string was cut short, and its
        // last entry may be a prefix of the value the process holds.
        const entries = new TextDecoder("utf-16le").decode(bytes).split("\0")
        const end = entries.indexOf("")
        return end < 0 ? undefined : entries.slice(0, end)
      } finally {
        symbols.CloseHandle(handle)
      }
    },
  }
}

const openedApi = openKernelApiOnce("kernel32 and ntdll", () => createWindowsProcessApi(openKernel32(), openNtdll()))

/** The kernel32 process API for this platform, opened once on first use.
 *
 *  `undefined` off Windows, and `undefined` in the unreachable case that the
 *  library cannot be opened. A caller that gets nothing has proven nothing, so
 *  it reports the question unanswered rather than reporting an absence. */
export function windowsProcessApi(): WindowsProcessApi | undefined {
  return process.platform === "win32" ? openedApi() : undefined
}
