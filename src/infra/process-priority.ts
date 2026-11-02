import { dlopen, FFIType } from "bun:ffi"

/** The only reduced scheduling policy Flywheel promises for owned work. */
export type ProcessPriority = "background"

const BACKGROUND_NICE = 10
const PRIO_PROCESS = 0

type PriorityApi = ReturnType<typeof openPriorityApi>

let opened: PriorityApi | undefined
let unavailable = false

function openPriorityApi() {
  const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
  return dlopen(library, {
    getpriority: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    setpriority: { args: [FFIType.i32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  })
}

function priorityApi(): PriorityApi | undefined {
  if (process.platform === "win32" || unavailable) return undefined
  if (opened) return opened
  try {
    opened = openPriorityApi()
    return opened
  } catch {
    unavailable = true
    return undefined
  }
}

/** Reads one POSIX process nice value. Undefined means the platform cannot prove it. */
function readProcessPriority(pid: number): number | undefined {
  const api = priorityApi()
  if (!api) return undefined
  const priority = api.symbols.getpriority(PRIO_PROCESS, pid)
  return priority >= -20 && priority <= 19 ? priority : undefined
}

/** Establishes and reads back a required policy before an owned payload starts. */
export function establishProcessPriority(priority: ProcessPriority | undefined): boolean {
  if (priority === undefined || process.platform === "win32") return true
  const api = priorityApi()
  if (!api || api.symbols.setpriority(PRIO_PROCESS, 0, BACKGROUND_NICE) !== 0) return false
  const established = readProcessPriority(0)
  return established !== undefined && established >= BACKGROUND_NICE
}
