import { dlopen, FFIType } from "bun:ffi"

/** Windows idle-sleep inhibition through `SetThreadExecutionState`.
 *
 *  `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` tells the power manager that this
 *  thread needs the system awake until the same thread clears it with
 *  `ES_CONTINUOUS` alone. The state belongs to the calling thread, so both
 *  calls run on Bun's main thread and end with the process. A lid closed or an
 *  explicit sleep still wins, as it does for `caffeinate -i` on macOS. */

const ES_SYSTEM_REQUIRED = 0x0000_0001
const ES_CONTINUOUS = 0x8000_0000

export interface WindowsExecutionStateApi {
  /** Holds the system awake. Returns false when the power manager refused. */
  keepSystemAwake(): boolean
  /** Lets the system idle-sleep again. Returns false when the power manager refused. */
  allowSleep(): boolean
}

interface Kernel32ExecutionState {
  readonly symbols: {
    SetThreadExecutionState(flags: number): number
  }
}

function openKernel32(): Kernel32ExecutionState {
  return dlopen("kernel32.dll", {
    SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
  })
}

function createWindowsExecutionStateApi(kernel32: Kernel32ExecutionState): WindowsExecutionStateApi {
  // A zero return is the API's failure word; the previous flags come back otherwise.
  return {
    keepSystemAwake: () => kernel32.symbols.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) !== 0,
    allowSleep: () => kernel32.symbols.SetThreadExecutionState(ES_CONTINUOUS) !== 0,
  }
}

let opened: WindowsExecutionStateApi | undefined
let openFailed = false

/** The execution-state API for this platform, opened once on first use.
 *  `undefined` off Windows, and in the unreachable case that kernel32 cannot
 *  be opened. */
export function windowsExecutionStateApi(): WindowsExecutionStateApi | undefined {
  if (process.platform !== "win32" || openFailed) return undefined
  if (opened) return opened
  try {
    opened = createWindowsExecutionStateApi(openKernel32())
    return opened
  } catch {
    openFailed = true
    return undefined
  }
}
