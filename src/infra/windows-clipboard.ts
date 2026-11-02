import { dlopen, FFIType, toArrayBuffer } from "bun:ffi"

/** The Windows clipboard, written through the platform's own API.
 *
 *  Windows exposes no clipboard command, so the alternative is PowerShell's
 *  `Set-Clipboard`, and starting the host dominates it: a copy costs most of a
 *  second, against a fraction of a millisecond here. It also costs a process,
 *  which on this platform is never free - a process needs a container, an owner,
 *  and a console it must be told not to open. Putting text on the clipboard
 *  needs none of that.
 *
 *  The clipboard is a single-owner global: any process may hold it, and a
 *  clipboard manager frequently does. A refusal is therefore a moment rather
 *  than an answer, which is why taking it is retried before it is reported as
 *  failed. */

export interface WindowsClipboard {
  /** Replaces the clipboard's text. False once the clipboard could not be
   *  taken for long enough to give up on it. */
  writeText(text: string): Promise<boolean>
}

const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x0002

/** How many times taking the clipboard is attempted, and how the wait between
 *  attempts grows. A holder keeps it for the length of its own copy, so the
 *  whole schedule stays far below anything a person would notice. */
const OPEN_ATTEMPTS = 8
const OPEN_BACKOFF_MS = 2

type Libraries = ReturnType<typeof openLibraries>

function openLibraries() {
  return {
    user32: dlopen("user32.dll", {
      OpenClipboard: { args: [FFIType.ptr], returns: FFIType.i32 },
      CloseClipboard: { args: [], returns: FFIType.i32 },
      EmptyClipboard: { args: [], returns: FFIType.i32 },
      SetClipboardData: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
    }),
    kernel32: dlopen("kernel32.dll", {
      GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: FFIType.ptr },
      GlobalLock: { args: [FFIType.ptr], returns: FFIType.ptr },
      GlobalUnlock: { args: [FFIType.ptr], returns: FFIType.i32 },
      GlobalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    }),
  }
}

/** Builds the clipboard over already-opened libraries. */
function createWindowsClipboard(libraries: Libraries): WindowsClipboard {
  const user32 = libraries.user32.symbols
  const kernel32 = libraries.kernel32.symbols

  /** One attempt at replacing the clipboard's text. */
  const attempt = (text: string): boolean => {
    if (!user32.OpenClipboard(null)) return false
    try {
      user32.EmptyClipboard()
      // A JavaScript string is already UTF-16, which is what this format holds,
      // so its code units are copied straight across and a character outside
      // the basic plane needs no special handling. The trailing NUL is part of
      // the format.
      const bytes = (text.length + 1) * 2
      const block = kernel32.GlobalAlloc(GMEM_MOVEABLE, BigInt(bytes))
      if (!block) return false
      const target = kernel32.GlobalLock(block)
      if (!target) {
        kernel32.GlobalFree(block)
        return false
      }
      const view = new DataView(toArrayBuffer(target, 0, bytes))
      for (let index = 0; index < text.length; index += 1) view.setUint16(index * 2, text.charCodeAt(index), true)
      view.setUint16(text.length * 2, 0, true)
      kernel32.GlobalUnlock(block)
      // The clipboard takes ownership of the block on success, so it is freed
      // here only when it was refused. Freeing an accepted block would hand the
      // clipboard memory it no longer owns.
      if (!user32.SetClipboardData(CF_UNICODETEXT, block)) {
        kernel32.GlobalFree(block)
        return false
      }
      return true
    } finally {
      user32.CloseClipboard()
    }
  }

  return {
    async writeText(text) {
      for (let tries = 0; tries < OPEN_ATTEMPTS; tries += 1) {
        if (attempt(text)) return true
        await Bun.sleep(OPEN_BACKOFF_MS * (tries + 1))
      }
      return false
    },
  }
}

let opened: WindowsClipboard | undefined
let openFailed = false

/** The clipboard for this platform, opened once on first use. `undefined` off
 *  Windows, and in the unreachable case that the libraries cannot be opened. */
export function windowsClipboard(): WindowsClipboard | undefined {
  if (process.platform !== "win32" || openFailed) return undefined
  if (opened) return opened
  try {
    opened = createWindowsClipboard(openLibraries())
    return opened
  } catch {
    openFailed = true
    return undefined
  }
}
