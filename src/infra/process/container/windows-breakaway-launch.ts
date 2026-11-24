import { dlopen, FFIType, ptr } from "bun:ffi"

import { openKernelApiOnce } from "../kernel/kernel-api-open.js"
import { Log } from "../../diagnostics/log.js"
import { OUTSIDE_JOBS_POLL_MS, OutsideJobsLaunchError, watchHeldProcess, type OutsideJobsChild, type OutsideJobsLaunchRequest } from "./windows-outside-jobs.js"
import { windowsProcessApi, type WindowsProcessHold } from "../kernel/windows-process-api.js"

/** A process that this process starts itself, outside every job, when
 *  Windows lets it (ARCH-RUNTIME-085).
 *
 *  `CreateProcessW` creates the process suspended and asks to break away from
 *  the jobs of this process. A job that allows no breakaway refuses the
 *  create. A job that lets this process break away from it can still sit
 *  inside an outer job that does not, and this process sees only its
 *  innermost job, so only the created process shows where it landed. The
 *  launch asks the kernel whether that process is in any job before it runs:
 *  in none, it resumes; in one, it ends the process, which never ran, and
 *  WMI must start the process instead. That costs some milliseconds, where
 *  WMI costs hundreds.
 *
 *  The process inherits exactly three handles: `NUL` as its input and the two
 *  output files as its output and error output, as a spawn with ignored input
 *  gives it. No other handle of this process reaches it. */

const log = Log.create({ service: "windows-outside-jobs" })

/** Why a breakaway launch left the process to WMI. `refused`: a job of this
 *  process allows no breakaway, so Windows created nothing. `in-job`: the
 *  created process was still in a job, or the kernel did not show that it
 *  was in none, and it was ended before it ran. */
type BreakawayFallback = "refused" | "in-job"

/** What one breakaway launch did. `needs-wmi` leaves no process that ran. */
export type BreakawayLaunch =
  | { readonly kind: "started"; readonly child: OutsideJobsChild }
  | { readonly kind: "needs-wmi"; readonly reason: BreakawayFallback }

/** What `CreateProcessW` gets: a command line in the C runtime's quoting,
 *  the `NAME=value` entries of the environment in the order Windows keeps
 *  them, and the paths of the three standard handles. */
export interface BreakawayCreation {
  readonly commandLine: string
  readonly environment: readonly string[]
  readonly cwd: string | undefined
  readonly stdoutPath: string
  readonly stderrPath: string
}

/** A process created suspended, held through the handles of its creation. */
interface SuspendedProcess {
  readonly pid: number
  /** False only when the kernel showed that the process is in no job. */
  inAnyJob(): boolean
  /** Ends the process with exit code 1. */
  terminate(): void
  /** Closes the handles of the creation. Called once. */
  close(): void
}

type SuspendedCreation =
  | { readonly kind: "created"; readonly process: SuspendedProcess }
  | { readonly kind: "failed"; readonly code: number }

/** What a breakaway launch needs from Windows, replaceable so the launch can
 *  be tested on any host. */
export interface BreakawaySeams {
  /** Creates the process suspended and asks it out of every job, or answers
   *  the error code of the refused create. */
  readonly createSuspended: (creation: BreakawayCreation) => SuspendedCreation
  readonly hold: (pid: number) => WindowsProcessHold | undefined
  /** How often a held process is checked for its exit. */
  readonly pollMs: number
}

const ERROR_ACCESS_DENIED = 5

/** Starts `request.command` outside every job of this process when Windows
 *  lets this process do it, with exactly the environment `request.env` (this
 *  process's when absent), its working directory, and its output and error
 *  output written to the two files, and holds it. `needs-wmi` when a job
 *  allows no breakaway or the process is still in a job, and then no process
 *  ran. Throws `OutsideJobsLaunchError` when Windows refused the create for
 *  any other reason, or the created process could not be held or resumed;
 *  then too no process ran. Synchronous, so the process starts in the
 *  caller's turn. */
export function launchBreakaway(request: OutsideJobsLaunchRequest, seams: BreakawaySeams = BREAKAWAY_SEAMS): BreakawayLaunch {
  try {
    const launch = startBreakaway(request, seams)
    if (launch.kind === "started") log.info("a process started outside every job", { pid: launch.child.pid, path: "breakaway" })
    else log.info("a breakaway launch left the process to WMI", { reason: launch.reason })
    return launch
  } catch (error) {
    if (error instanceof OutsideJobsLaunchError) log.warn("a process could not start outside every job", { stage: error.stage, path: "breakaway", outcome: "refused" })
    throw error
  }
}

function startBreakaway(request: OutsideJobsLaunchRequest, seams: BreakawaySeams): BreakawayLaunch {
  const created = seams.createSuspended(breakawayCreation(request))
  if (created.kind === "failed") {
    if (created.code === ERROR_ACCESS_DENIED) return { kind: "needs-wmi", reason: "refused" }
    throw new OutsideJobsLaunchError("create", `CreateProcessW failed with error ${created.code}`)
  }
  const suspended = created.process
  try {
    if (suspended.inAnyJob()) {
      suspended.terminate()
      return { kind: "needs-wmi", reason: "in-job" }
    }
    // The creation handle keeps the pid from naming another process, so the
    // hold opened while it is open holds the created process.
    const hold = seams.hold(suspended.pid)
    if (hold === undefined) {
      suspended.terminate()
      throw new OutsideJobsLaunchError("hold", `the created process, pid ${suspended.pid}, could not be opened`)
    }
    if (!hold.resume()) {
      hold.terminate()
      hold.close()
      throw new OutsideJobsLaunchError("resume", `the created process, pid ${suspended.pid}, could not be resumed`)
    }
    return { kind: "started", child: watchHeldProcess(suspended.pid, hold, seams.pollMs) }
  } finally {
    suspended.close()
  }
}

function breakawayCreation(request: OutsideJobsLaunchRequest): BreakawayCreation {
  const environment = Object.entries(request.env ?? process.env)
    .flatMap(([name, value]) => value === undefined ? [] : [{ key: name.toUpperCase(), entry: `${name}=${value}` }])
    // Windows keeps an environment sorted by name without regard to case.
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    .map(({ entry }) => entry)
  return { commandLine: request.command.map(quoteArgument).join(" "), environment, cwd: request.cwd, stdoutPath: request.stdoutPath, stderrPath: request.stderrPath }
}

/** One argument as the C runtime reads it back: quoted when it is empty or
 *  holds white space or a quote, with each quote escaped and the backslashes
 *  before an escaped or the closing quote doubled. */
function quoteArgument(argument: string): string {
  if (argument !== "" && !/[\s"]/u.test(argument)) return argument
  return `"${argument.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`
}

/** `CREATE_SUSPENDED`, `DETACHED_PROCESS`, `CREATE_NEW_PROCESS_GROUP`,
 *  `CREATE_UNICODE_ENVIRONMENT`, `EXTENDED_STARTUPINFO_PRESENT`, and
 *  `CREATE_BREAKAWAY_FROM_JOB`: the detached start that a spawn gives a
 *  persistent process, held before it runs and asked out of every job. */
const BREAKAWAY_CREATE_FLAGS = 0x4 | 0x8 | 0x200 | 0x400 | 0x80000 | 0x0100_0000
const STARTF_USESHOWWINDOW = 0x1
const STARTF_USESTDHANDLES = 0x100
const SW_HIDE = 0
const GENERIC_READ = 0x8000_0000
const GENERIC_WRITE = 0x4000_0000
/** Read, write, and delete sharing: the launcher still holds the output
 *  files open, and a sweep may remove them while the process writes. */
const FILE_SHARE_ALL = 0x1 | 0x2 | 0x4
const OPEN_EXISTING = 3
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x2_0002n

/** x64 layouts, which arm64 shares. `SECURITY_ATTRIBUTES`: the length, the
 *  descriptor pointer at 8, and the inherit flag at 16. `STARTUPINFOEXW`:
 *  `STARTUPINFOW` of 104 bytes, with the flags at 60, the show state at 64,
 *  and the three standard handles from 80, then the attribute list pointer.
 *  `PROCESS_INFORMATION`: the process and thread handles, then the pid. */
const SECURITY_ATTRIBUTES_SIZE = 24
const SECURITY_ATTRIBUTES_OFFSET_INHERIT = 16
const STARTUP_INFO_EX_SIZE = 112
const STARTUP_OFFSET_FLAGS = 60
const STARTUP_OFFSET_SHOW_WINDOW = 64
const STARTUP_OFFSET_STD_INPUT = 80
const STARTUP_OFFSET_STD_OUTPUT = 88
const STARTUP_OFFSET_STD_ERROR = 96
const STARTUP_OFFSET_ATTRIBUTE_LIST = 104
const PROCESS_INFORMATION_SIZE = 24
const PROCESS_INFORMATION_OFFSET_THREAD = 8
const PROCESS_INFORMATION_OFFSET_PID = 16

type Kernel32 = ReturnType<typeof openKernel32>

/** Handles are `u64`, so a handle is a `bigint` this side compares and
 *  passes back exactly, the invalid handle included. */
function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    InitializeProcThreadAttributeList: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UpdateProcThreadAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
    CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
}

const openedKernel = openKernelApiOnce("kernel32 breakaway launch", openKernel32)

const BREAKAWAY_SEAMS: BreakawaySeams = {
  createSuspended(creation) {
    const kernel = openedKernel()
    if (kernel === undefined) throw new OutsideJobsLaunchError("create", "kernel32 could not be opened")
    return createSuspended(kernel, creation)
  },
  hold: (pid) => windowsProcessApi()?.hold(pid),
  pollMs: OUTSIDE_JOBS_POLL_MS,
}

/** A NUL-terminated UTF-16 string, which is what the wide entry points read. */
function wideString(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le")
}

function createSuspended(kernel: Kernel32, creation: BreakawayCreation): SuspendedCreation {
  const symbols = kernel.symbols
  // Bound once and called through the alias: read directly, the Win32 name
  // trips a lint rule that reads any `...Error()` call as an error constructor.
  const lastError = symbols.GetLastError
  const inheritable = Buffer.alloc(SECURITY_ATTRIBUTES_SIZE)
  inheritable.writeUInt32LE(SECURITY_ATTRIBUTES_SIZE, 0)
  inheritable.writeInt32LE(1, SECURITY_ATTRIBUTES_OFFSET_INHERIT)
  const opened: bigint[] = []
  const open = (path: string, access: number, role: string): bigint => {
    const widePath = wideString(path)
    const handle = symbols.CreateFileW(ptr(widePath), access, FILE_SHARE_ALL, ptr(inheritable), OPEN_EXISTING, 0, 0)
    if (handle === INVALID_HANDLE) throw new OutsideJobsLaunchError("create", `the ${role} of the process could not be opened (error ${lastError()})`)
    opened.push(handle)
    return handle
  }
  try {
    const input = open("NUL", GENERIC_READ, "input")
    const output = open(creation.stdoutPath, GENERIC_WRITE, "output file")
    const errorOutput = open(creation.stderrPath, GENERIC_WRITE, "error output file")
    const standard = new BigUint64Array([input, output, errorOutput])
    // The first call only answers the size of a list of one attribute.
    const size = new BigUint64Array(1)
    symbols.InitializeProcThreadAttributeList(null, 1, 0, ptr(size))
    const attributes = Buffer.alloc(Number(size[0]))
    if (!symbols.InitializeProcThreadAttributeList(ptr(attributes), 1, 0, ptr(size))) throw new OutsideJobsLaunchError("create", `the attribute list could not be built (error ${lastError()})`)
    try {
      // The list names the inherited handles, so no other inheritable
      // handle of this process reaches the child. The kernel reads `standard`
      // at the create, so it stays referenced until then.
      if (!symbols.UpdateProcThreadAttribute(ptr(attributes), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ptr(standard), BigInt(standard.byteLength), null, null)) {
        throw new OutsideJobsLaunchError("create", `the inherited handles could not be listed (error ${lastError()})`)
      }
      const startup = Buffer.alloc(STARTUP_INFO_EX_SIZE)
      startup.writeUInt32LE(STARTUP_INFO_EX_SIZE, 0)
      startup.writeUInt32LE(STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES, STARTUP_OFFSET_FLAGS)
      startup.writeUInt16LE(SW_HIDE, STARTUP_OFFSET_SHOW_WINDOW)
      startup.writeBigUInt64LE(input, STARTUP_OFFSET_STD_INPUT)
      startup.writeBigUInt64LE(output, STARTUP_OFFSET_STD_OUTPUT)
      startup.writeBigUInt64LE(errorOutput, STARTUP_OFFSET_STD_ERROR)
      startup.writeBigUInt64LE(BigInt(ptr(attributes)), STARTUP_OFFSET_ATTRIBUTE_LIST)
      const information = Buffer.alloc(PROCESS_INFORMATION_SIZE)
      const environment = Buffer.from(`${creation.environment.join("\0")}\0\0`, "utf16le")
      const commandLine = wideString(creation.commandLine)
      const cwd = creation.cwd === undefined ? undefined : wideString(creation.cwd)
      if (!symbols.CreateProcessW(null, ptr(commandLine), null, null, 1, BREAKAWAY_CREATE_FLAGS, ptr(environment), cwd === undefined ? null : ptr(cwd), ptr(startup), ptr(information))) {
        return { kind: "failed", code: lastError() }
      }
      return { kind: "created", process: suspendedProcess(kernel, information) }
    } finally {
      symbols.DeleteProcThreadAttributeList(ptr(attributes))
    }
  } finally {
    // The child holds its own copies; these were only to hand over.
    for (const handle of opened) symbols.CloseHandle(handle)
  }
}

function suspendedProcess(kernel: Kernel32, information: Buffer): SuspendedProcess {
  const symbols = kernel.symbols
  const processHandle = information.readBigUInt64LE(0)
  const threadHandle = information.readBigUInt64LE(PROCESS_INFORMATION_OFFSET_THREAD)
  return {
    pid: information.readUInt32LE(PROCESS_INFORMATION_OFFSET_PID),
    inAnyJob() {
      const answer = new Int32Array(1)
      // A null job asks about every job the process is in.
      return !symbols.IsProcessInJob(processHandle, 0, ptr(answer)) || answer[0] !== 0
    },
    terminate() { symbols.TerminateProcess(processHandle, 1) },
    close() {
      symbols.CloseHandle(threadHandle)
      symbols.CloseHandle(processHandle)
    },
  }
}
