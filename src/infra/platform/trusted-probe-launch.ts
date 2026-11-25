import * as fs from "node:fs"
import { delimiter, extname, join } from "node:path"

/** How a trusted probe program is bound and launched. Every owner of a probe, from the process containers to the
 *  private-directory ACL, launches through this, so it sits below all of them. */

/** How long a trusted program may run when its caller names no budget of its
 *  own, such as a `trustedProbeRun` given no timeout. No probe runs through a
 *  shell host, so each answers in tens of milliseconds. */
const PROBE_TIMEOUT_MS = 500

/** Where a probe program may come from. A program is never resolved through
 *  the inherited PATH: one writable entry in front of it would let a program
 *  nobody vetted answer in place of the real one, and whatever reads its
 *  answer would believe it. */
const TRUSTED_PROBE_DIRS: readonly string[] = process.platform === "win32"
  ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0")]
  : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

interface ProbeEnvironment {
  readonly [key: string]: string
}

export interface TrustedProbeLaunch {
  readonly argv: readonly string[]
  readonly env: ProbeEnvironment
  /** How long this program may run before it is killed. It belongs to the
   *  launch rather than to the call site, so no caller can ask a question
   *  through a program its budget cannot cover. */
  readonly timeoutMs: number
  /** Windows gives a console program whose parent holds no console a fresh one,
   *  and on Windows 11 that console is a visible terminal window. The guardian
   *  runs detached and holds no console, so every probe it starts would open
   *  one. A probe asks an internal question, so it never gets a window. The
   *  flag has no meaning on other platforms, which ignore it. */
  readonly windowsHide: true
}
/** The environment every probe runs in. It is the whole environment, not an
 *  addition to this process's: a probe needs no configuration, and the fixed
 *  PATH is what a program name falls back to when no trusted directory holds
 *  it. */
const PROBE_ENV: ProbeEnvironment = process.platform === "win32"
  ? { PATH: TRUSTED_PROBE_DIRS.join(delimiter), SYSTEMROOT: process.env.SystemRoot ?? "C:\\Windows", SYSTEMDRIVE: process.env.SystemDrive ?? "C:" }
  : { PATH: TRUSTED_PROBE_DIRS.join(delimiter) }

const probePrograms = new Map<string, string>()

/** How one probe command is launched: the program is bound to a trusted absolute
 * path, or launch construction fails when the host does not provide it. `env`
 * adds to the fixed probe environment for a program that needs to find a
 * service of the session, such as the systemd user manager's bus; the
 * program path stays trusted either way. */
export function trustedProbeLaunch(
  argv: readonly string[],
  options: { readonly trustedDirs?: readonly string[]; readonly exists?: (filePath: string) => boolean; readonly env?: ProbeEnvironment } = {},
): TrustedProbeLaunch {
  const [name, ...rest] = argv
  if (name === undefined) throw new Error("a probe command names no program")
  return {
    argv: [trustedProbeProgram(name, options), ...rest],
    env: options.env === undefined ? PROBE_ENV : { ...PROBE_ENV, ...options.env },
    timeoutMs: PROBE_TIMEOUT_MS,
    windowsHide: true,
  }
}

/** The file names a trusted directory is searched for. A caller names the
 *  program the way an operator would type it, but Windows keeps the extension
 *  on disk: `whoami` is `whoami.exe`, so a bare name matches nothing and every
 *  probe reports the program as unavailable. Only `.exe` is admitted, because a
 *  trusted probe launches a system binary and must never resolve to a `.bat` or
 *  `.cmd` script that happens to sit beside it. */
function probeFileNames(name: string): readonly string[] {
  if (process.platform !== "win32" || extname(name) !== "") return [name]
  return [`${name}.exe`]
}

function trustedProbeProgram(
  name: string,
  options: { readonly trustedDirs?: readonly string[]; readonly exists?: (filePath: string) => boolean },
): string {
  const useCache = options.trustedDirs === undefined && options.exists === undefined
  const known = useCache ? probePrograms.get(name) : undefined
  if (known !== undefined) return known
  const found = (options.trustedDirs ?? TRUSTED_PROBE_DIRS)
    .flatMap((dir) => probeFileNames(name).map((fileName) => join(dir, fileName)))
    .find(options.exists ?? fs.existsSync)
  if (found === undefined) throw new Error(`trusted probe program is unavailable: ${name}`)
  if (useCache) probePrograms.set(name, found)
  return found
}
