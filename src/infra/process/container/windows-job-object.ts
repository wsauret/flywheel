import { dlopen, FFIType, ptr } from "bun:ffi"
import type { ProcessPriority } from "./process-priority.js"

/** Windows job objects: the platform's real process container.
 *
 *  A job is what a POSIX process group is: a set the kernel tracks, that every
 *  process started by a member joins automatically, and that one decision ends
 *  as a whole. It is strictly stronger than the parent-pid tree walk it
 *  replaces. A walk reads a snapshot and infers membership from parenthood, so
 *  a process that re-parents leaves the set it was owned in, and a pid recycled
 *  between the snapshot and the kill names a stranger. A job has neither
 *  problem: membership is not inferred, and a job holds a member until it
 *  exits.
 *
 *  A job is named, and the name is the launch's ownership token. That is what
 *  lets the guardian own a container it never launched: it opens the container
 *  by the name it was told, with no handle to inherit and no pid to trust. A
 *  token names one launch, so a name identifies exactly one container for all
 *  time and the recycled-identity question does not arise here at all.
 *
 *  Ownership is a handle. `KILL_ON_JOB_CLOSE` makes Windows itself end the
 *  container when the last handle to it closes, so a host and a guardian that
 *  both die take the container with them without either one running any code.
 *  That is a stronger crash guarantee than a supervising process can give. */

/** One container, addressed through one handle this side holds. */
export interface WindowsJob {
  /** Puts `pid` in this container, along with every process it starts from then
   *  on. False when the process could not be admitted, which includes a process
   *  that already exited. */
  admit(pid: number): boolean
  /** From now on, a process a member starts is not put in this container.
   *  The container of a project executor is made so once the executor runs:
   *  every command the executor launches has a container of its own, and only
   *  that container may decide the command's end, as each POSIX launch leads
   *  its own session. False when the limit could not be set and read back. */
  letChildrenLeave(): boolean
  /** Ends every process the container holds, at once. Windows offers no
   *  graceful group signal, so this is a kill and is named as one. */
  terminate(): void
  /** The pids the container still holds, or nothing when the query failed.
   *  Nothing is not an empty container: a failed query proves no absence. */
  pids(): readonly number[] | undefined
  /** Suspends every thread of member `pid`, for processor admission
   *  (ARCH-TOOLS-051). Each suspension needs its own `resume`. False when the
   *  process could not be opened or suspended. */
  suspend(pid: number): boolean
  /** Undoes one `suspend` of member `pid`. */
  resume(pid: number): boolean
  /** Releases this side's handle. When it was the last one, the container dies
   *  with it. */
  close(): void
}

/** What one open by name proved. `not-found` proves that no container holds
 *  the name, which is the one answer that lets an owner treat it as never
 *  created or already gone. `unavailable` is an open that failed for any
 *  other reason, such as a refused access right, and proves nothing about
 *  the container or the processes it may hold. */
export type WindowsJobOpen =
  | { readonly kind: "opened"; readonly job: WindowsJob }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly code: number }

/** What a container allows beyond ending with its last handle. */
interface WindowsJobLimits {
  readonly priority?: ProcessPriority
}

export interface WindowsJobApi {
  /** Creates the container named `name`. An existing name yields nothing, so a
   *  reused name is a launch that never starts rather than two owners of one
   *  set of processes. */
  create(name: string, limits?: WindowsJobLimits): WindowsJob | undefined
  /** Opens a container someone else created, by the name they used. */
  open(name: string): WindowsJobOpen
}

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000
const JOB_OBJECT_LIMIT_PRIORITY_CLASS = 0x20
const BELOW_NORMAL_PRIORITY_CLASS = 0x4000
const NORMAL_PRIORITY_CLASS = 0x20
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

const POINTER_SIZE = process.arch === "ia32" ? 4 : 8
const align = (offset: number, alignment: number): number => Math.ceil(offset / alignment) * alignment
const MINIMUM_WORKING_SET_OFFSET = align(20, POINTER_SIZE)
const ACTIVE_PROCESS_LIMIT_OFFSET = MINIMUM_WORKING_SET_OFFSET + POINTER_SIZE * 2
const AFFINITY_OFFSET = align(ACTIVE_PROCESS_LIMIT_OFFSET + 4, POINTER_SIZE)
const PRIORITY_CLASS_OFFSET = AFFINITY_OFFSET + POINTER_SIZE
const BASIC_LIMIT_SIZE = PRIORITY_CLASS_OFFSET + 8
const IO_COUNTERS_SIZE = 48
const EXTENDED_LIMIT_SIZE = align(BASIC_LIMIT_SIZE, 8) + IO_COUNTERS_SIZE + POINTER_SIZE * 4
const LIMIT_FLAGS_OFFSET = 16

/** `JOBOBJECT_BASIC_PROCESS_ID_LIST`: two counts, then one pointer-sized pid per
 *  entry. A job holding more than this many fails the query rather than
 *  reporting a truncated list, so a short list is never read as a small job. */
const PID_LIST_HEADER_SIZE = 8
const PID_LIST_COUNT_OFFSET = 4
const PID_LIST_CAPACITY = 4096

/** The rights an owner needs: assign into the container, read its membership,
 *  set its limits, and end it. Deliberately not `JOB_OBJECT_ALL_ACCESS`. */
const JOB_OBJECT_RIGHTS = 0x0001 | 0x0002 | 0x0004 | 0x0008

/** The rights needed to put one process in a container. */
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
/** The right to suspend and resume one process. */
const PROCESS_SUSPEND_RESUME = 0x0800

const ERROR_FILE_NOT_FOUND = 2
const ERROR_ALREADY_EXISTS = 183

type Kernel32 = ReturnType<typeof openKernel32>
type Ntdll = ReturnType<typeof openNtdll>

function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
}

/** `NtSuspendProcess` and `NtResumeProcess` suspend every thread of a process
 *  in one call, threads it starts during the call included, which a walk of
 *  its threads through kernel32 cannot promise. */
function openNtdll() {
  return dlopen("ntdll.dll", {
    NtSuspendProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
    NtResumeProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
}

/** A NUL-terminated UTF-16 string, which is what the wide entry points read. */
function wideString(text: string): Uint8Array {
  const buffer = new Uint8Array((text.length + 1) * 2)
  const view = new DataView(buffer.buffer)
  for (let index = 0; index < text.length; index += 1) view.setUint16(index * 2, text.charCodeAt(index), true)
  return buffer
}

/** Builds the API over an already-opened library. Exported so the mapping from
 *  return values and error codes to answers can be tested without Windows. */
export function createWindowsJobApi(kernel32: Kernel32, ntdll: Ntdll): WindowsJobApi {
  const symbols = kernel32.symbols
  const lastError = symbols.GetLastError

  type JobHandle = Parameters<typeof symbols.CloseHandle>[0]

  /** The container's extended limits, or nothing when the query failed. */
  const readLimits = (handle: JobHandle): DataView | undefined => {
    const limits = new Uint8Array(EXTENDED_LIMIT_SIZE)
    return symbols.QueryInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limits), EXTENDED_LIMIT_SIZE, null) ? new DataView(limits.buffer) : undefined
  }

  /** Runs one ntdll call against `pid`. An NTSTATUS of zero or more is a
   *  success. */
  const suspension = (pid: number, call: typeof ntdll.symbols.NtSuspendProcess): boolean => {
    const target = symbols.OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid)
    if (!target) return false
    try {
      return call(target) >= 0
    } finally {
      symbols.CloseHandle(target)
    }
  }

  const held = (handle: JobHandle): WindowsJob => {
    let live = true
    return {
      admit(pid) {
        if (!live) return false
        const target = symbols.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
        if (!target) return false
        try {
          return Boolean(symbols.AssignProcessToJobObject(handle, target))
        } finally {
          symbols.CloseHandle(target)
        }
      },
      letChildrenLeave() {
        if (!live) return false
        const limits = readLimits(handle)
        if (limits === undefined) return false
        limits.setUint32(LIMIT_FLAGS_OFFSET, limits.getUint32(LIMIT_FLAGS_OFFSET, true) | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, true)
        if (!symbols.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limits), EXTENDED_LIMIT_SIZE)) return false
        return ((readLimits(handle)?.getUint32(LIMIT_FLAGS_OFFSET, true) ?? 0) & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) !== 0
      },
      terminate() {
        if (!live) return
        // A process ends only when its threads run, and under load a thread
        // at background priority waits seconds for the processor. So the
        // members run at normal priority for the little that is left of them.
        const limits = readLimits(handle)
        if (limits !== undefined && (limits.getUint32(LIMIT_FLAGS_OFFSET, true) & JOB_OBJECT_LIMIT_PRIORITY_CLASS) !== 0) {
          limits.setUint32(PRIORITY_CLASS_OFFSET, NORMAL_PRIORITY_CLASS, true)
          symbols.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limits), EXTENDED_LIMIT_SIZE)
        }
        symbols.TerminateJobObject(handle, 1)
      },
      pids() {
        if (!live) return undefined
        const size = PID_LIST_HEADER_SIZE + PID_LIST_CAPACITY * POINTER_SIZE
        const buffer = new Uint8Array(size)
        if (!symbols.QueryInformationJobObject(handle, JOB_OBJECT_BASIC_PROCESS_ID_LIST, ptr(buffer), size, null)) return undefined
        const view = new DataView(buffer.buffer)
        const count = view.getUint32(PID_LIST_COUNT_OFFSET, true)
        if (count > PID_LIST_CAPACITY) return undefined
        const pids: number[] = []
        for (let index = 0; index < count; index += 1) {
          const offset = PID_LIST_HEADER_SIZE + index * POINTER_SIZE
          pids.push(POINTER_SIZE === 8 ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true))
        }
        return pids
      },
      suspend: (pid) => live && suspension(pid, ntdll.symbols.NtSuspendProcess),
      resume: (pid) => live && suspension(pid, ntdll.symbols.NtResumeProcess),
      close() {
        if (!live) return
        live = false
        symbols.CloseHandle(handle)
      },
    }
  }

  return {
    create(name, { priority } = {}) {
      const wide = wideString(name)
      const handle = symbols.CreateJobObjectW(null, ptr(wide))
      if (!handle) return undefined
      // An existing name means somebody already owns this container. Keeping
      // the handle would make two owners of one set of processes.
      if (lastError() === ERROR_ALREADY_EXISTS) {
        symbols.CloseHandle(handle)
        return undefined
      }
      // Set before anything is admitted, so no member is ever held by a
      // container Windows would not clean up.
      const limits = new Uint8Array(EXTENDED_LIMIT_SIZE)
      const view = new DataView(limits.buffer)
      view.setUint32(
        LIMIT_FLAGS_OFFSET,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | (priority === "background" ? JOB_OBJECT_LIMIT_PRIORITY_CLASS : 0),
        true,
      )
      if (priority === "background") view.setUint32(PRIORITY_CLASS_OFFSET, BELOW_NORMAL_PRIORITY_CLASS, true)
      const configured = symbols.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limits), EXTENDED_LIMIT_SIZE)
      const readback = configured ? readLimits(handle) : undefined
      const expectedFlags = view.getUint32(LIMIT_FLAGS_OFFSET, true)
      if (
        readback === undefined
        || (readback.getUint32(LIMIT_FLAGS_OFFSET, true) & expectedFlags) !== expectedFlags
        || (priority === "background" && readback.getUint32(PRIORITY_CLASS_OFFSET, true) !== BELOW_NORMAL_PRIORITY_CLASS)
      ) {
        symbols.CloseHandle(handle)
        return undefined
      }
      return held(handle)
    },
    open(name) {
      const wide = wideString(name)
      const handle = symbols.OpenJobObjectW(JOB_OBJECT_RIGHTS, 0, ptr(wide))
      if (handle) return { kind: "opened", job: held(handle) }
      const code = lastError()
      return code === ERROR_FILE_NOT_FOUND ? { kind: "not-found" } : { kind: "unavailable", code }
    },
  }
}

let opened: WindowsJobApi | undefined
let openFailed = false

/** The job API for this platform, opened once on first use. `undefined` off
 *  Windows, and in the unreachable case that kernel32 cannot be opened. */
export function windowsJobApi(): WindowsJobApi | undefined {
  if (process.platform !== "win32" || openFailed) return undefined
  if (opened) return opened
  try {
    opened = createWindowsJobApi(openKernel32(), openNtdll())
    return opened
  } catch {
    openFailed = true
    return undefined
  }
}
