import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi"

/** Writes text to this process's Windows console and answers how many UTF-16
 *  code units the console took. A count below the text's length means the
 *  console refused the rest. */
export type ConsoleTextWriter = (text: string) => number

/** `STD_OUTPUT_HANDLE`, -11, as the unsigned 32-bit value the call takes. */
const STD_OUTPUT_HANDLE = 0xffff_fff5

function openKernel32() {
  return dlopen("kernel32.dll", {
    GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },
    GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WriteConsoleW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  })
}

/** The three kernel32 calls the writer makes, as it calls them. */
interface ConsoleSymbols {
  GetStdHandle(id: number): Pointer | bigint | null
  GetConsoleMode(handle: Pointer | bigint, mode: Pointer): number
  WriteConsoleW(handle: Pointer | bigint, text: Pointer, length: number, written: Pointer, reserved: null): number
}

/** Builds the writer over already-opened symbols, or answers nothing when
 *  standard output is not a console, such as a pipe or a file. Exported so the
 *  write loop can be tested without Windows. */
export function createConsoleTextWriter(kernel32: ConsoleSymbols): ConsoleTextWriter | undefined {
  const handle = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
  if (!handle) return undefined
  const mode = new Uint32Array(1)
  if (!kernel32.GetConsoleMode(handle, ptr(mode))) return undefined
  const written = new Uint32Array(1)
  return (text) => {
    if (text.length === 0) return 0
    // A JavaScript string is UTF-16 already, so one code unit is two bytes.
    const units = Buffer.from(text, "utf16le")
    let taken = 0
    while (taken < text.length) {
      written[0] = 0
      const ok = kernel32.WriteConsoleW(handle, ptr(units, taken * 2), text.length - taken, ptr(written), null)
      const count = written[0] ?? 0
      if (!ok || count === 0) break
      taken += count
    }
    return taken
  }
}

/** The console writer for this process's standard output, or nothing when
 *  standard output is not a Windows console or kernel32 cannot be opened.
 *  kernel32 is mapped into every Windows process before any code runs, so
 *  opening it loads nothing. */
export function openWindowsConsoleWriter(): ConsoleTextWriter | undefined {
  try {
    return createConsoleTextWriter(openKernel32().symbols)
  } catch {
    return undefined
  }
}
