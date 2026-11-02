import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi"

import { Log } from "./log.js"
import { runOwnedCommand } from "./owned-command.js"
import type { LauncherScope } from "./process-supervisor.js"

const log = Log.create({ service: "open-external-url" })

/** How long the opener is owned.
 *
 *  The opener is a handoff, not a browser: `open` and `xdg-open` pass the URL
 *  to a desktop service and exit, so the browser is the session's child and
 *  never this container's. The lease exists for the opener alone, and its
 *  expiry ends a handoff that never happened rather than a browser somebody is
 *  reading. */
const OPENER_LEASE_MS = 10_000

/** Hands one URL to the user's browser. Injected wherever a caller needs the
 *  handoff without holding a launch capability of its own. */
export type ExternalUrlOpener = (url: string) => Promise<boolean>

/** Hands a URL to the Windows shell as data. Injected so the Windows handoff is
 *  testable on a host that is not Windows. */
type ShellExecute = (url: string) => boolean

export interface ExternalUrlOpenerOptions {
  readonly platform?: NodeJS.Platform
  readonly shellExecute?: ShellExecute
}

/** Builds the one way Flywheel opens an external URL.
 *
 *  Everything a caller would otherwise repeat lives here: the scheme check that
 *  keeps external input out of a launch, the platform handoff, and the
 *  ownership transfer.
 *
 *  The two platform handoffs are different in kind, not in argv. On macOS and
 *  Linux the URL is one argument of one owned launch, so no shell ever sees it;
 *  the opener runs in a container the guardian owns, and success is reported
 *  only after that container settled. On Windows the URL is not launched at
 *  all: it is passed to `ShellExecuteW` as a UTF-16 string, which is a data
 *  argument of a function call. Nothing on that path parses `&`, `|`, `^`, a
 *  quote, or `%VAR%`, because there is no command line to parse. */
export function createExternalUrlOpener(options: ExternalUrlOpenerOptions = {}): (scope: LauncherScope, url: string) => Promise<boolean> {
  const platform = options.platform ?? process.platform
  const shellExecute = options.shellExecute ?? shellExecuteUrl
  return async (scope, url) => {
    // Callers treat a browser as a convenience and always show the URL
    // themselves, so refusing anything that is not plain http(s) costs nothing
    // and keeps every other scheme, including `file:` and `javascript:`, away
    // from the desktop's handler table.
    if (!isHttpUrl(url)) {
      log.warn("refused to open a URL that is not http(s)")
      return false
    }
    if (platform === "win32") return shellExecute(url)

    const command = platform === "darwin" ? ["open", url] : ["xdg-open", url]
    const result = await runOwnedCommand(scope, command, { timeoutMs: OPENER_LEASE_MS })
    if (result.timedOut || result.exitCode !== 0) {
      log.info("browser handoff did not complete", { exitCode: result.exitCode, timedOut: result.timedOut })
      return false
    }
    return true
  }
}

/** Hands a URL to the user's browser, and reports whether the handoff
 *  happened. */
export const openExternalUrl = createExternalUrlOpener()

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/** A null-terminated UTF-16LE copy of `value`, the encoding `ShellExecuteW`
 *  reads. Exported because it is the whole Windows argument: proving what these
 *  bytes are is proving that the URL crosses as a string and never as a command
 *  line. */
export function utf16Argument(value: string): Uint8Array {
  const units = new Uint16Array(value.length + 1)
  for (let index = 0; index < value.length; index += 1) units[index] = value.charCodeAt(index)
  units[value.length] = 0
  return new Uint8Array(units.buffer)
}

/** `ShellExecuteW` reports failure as a value of 32 or less. The number is the
 *  API's own, kept from the days it returned an instance handle. */
const SHELL_EXECUTE_MIN_SUCCESS = 32

let shell32: { ShellExecuteW: (hwnd: Pointer | null, operation: Pointer | null, file: Pointer | null, parameters: Pointer | null, directory: Pointer | null, show: number) => Pointer | bigint | null } | undefined

/** The Windows handoff: one call into `shell32`, with the URL as a UTF-16 data
 *  pointer. The library is bound on first use, because it exists only on
 *  Windows. */
function shellExecuteUrl(url: string): boolean {
  try {
    shell32 ??= dlopen("shell32.dll", {
      ShellExecuteW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
        returns: FFIType.ptr,
      },
    }).symbols
    const operation = utf16Argument("open")
    const file = utf16Argument(url)
    // SW_SHOWNORMAL. No parameters and no working directory: a URL is the whole
    // request, and a parameter string is the one place a command line could
    // reappear.
    const result = shell32.ShellExecuteW(null, ptr(operation), ptr(file), null, null, 1)
    if (Number(result ?? 0) > SHELL_EXECUTE_MIN_SUCCESS) return true
    log.info("browser handoff did not complete", { result: Number(result ?? 0) })
    return false
  } catch (err) {
    // The URL is never quoted into this line: a handoff that failed says so
    // without repeating what it was asked to open.
    log.warn("the Windows shell could not be asked to open a URL", { error: err instanceof Error ? err.name : "unknown" })
    return false
  }
}
