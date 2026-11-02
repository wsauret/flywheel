import { spawn, type SpawnOptions } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { createInterface } from "node:readline"

import { bootstrapInstallerUrl } from "../../../src/protocol/installation.js"
import { probeVersion } from "./probe-version.js"
import { isVersionAtLeast } from "./supervisor.js"

/** Installs Flywheel on a machine that has none, through the platform's
 *  bootstrap installer: the same script a person runs from the README.
 *
 *  The extension carries no runtime and implements no install of its own.
 *  The account has one install authority (ARCH-DISTRIBUTION-014), and the script hands over
 *  to it: it resolves one release tag, proves the archive against the
 *  published digests, places and activates the build, and registers the
 *  account service (`serve install`) where the account home is the login
 *  home. The extension fetches the script, runs it once with stdin closed,
 *  and then checks what it placed by asking the launcher its version. It never
 *  pins a version, because pinning is how a new machine ends up older than
 *  `latest`. */

/** How long the script download may go without a byte before it is given up.
 *  Only the transfer is bounded, never the total: the installer bounds its own
 *  requests, and a slow connection is not a failure. */
const STALL_MS = 60_000
/** The installers are a few kilobytes; nothing near this is one. */
const MAX_SCRIPT_BYTES = 1_048_576
/** The installer's last lines, kept for the failure report. */
const KEPT_LINES = 12

export type InstallFailure =
  | { readonly kind: "fetch_failed"; readonly url: string; readonly detail: string }
  | { readonly kind: "installer_failed"; readonly url: string; readonly exitCode: number | null; readonly lastLines: readonly string[] }
  | { readonly kind: "launcher_silent"; readonly url: string; readonly launcher: string; readonly lastLines: readonly string[] }
  | { readonly kind: "launcher_too_old"; readonly url: string; readonly launcher: string; readonly version: string; readonly minimum: string }

type InstallResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly failure: InstallFailure }

/** What the runner needs of a started installer. A `ChildProcess` is one. */
interface InstallerProcess {
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  once(event: "close", listener: (code: number | null) => void): this
  once(event: "error", listener: (cause: Error) => void): this
}

export interface InstallOptions {
  readonly platform: NodeJS.Platform
  /** The release repository, `owner/name`. */
  readonly repository: string
  /** Where the installer places the launcher (`installedLauncherPath`). */
  readonly launcher: string
  readonly minimumVersion: string
  /** The installer's environment. The host passes its own, so the install
   *  lands in the account home the host sees. */
  readonly env: NodeJS.ProcessEnv
  /** Receives every line the installer prints. */
  readonly onOutput: (line: string) => void
  /** Test seams. */
  readonly fetch?: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>
  readonly spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => InstallerProcess
  readonly probe?: (executable: string) => Promise<string | undefined>
  readonly stallMs?: number
}

export async function installFlywheel(options: InstallOptions): Promise<InstallResult> {
  const url = bootstrapInstallerUrl(options.platform, options.repository)
  const script = await fetchInstaller(url, options.fetch ?? fetch, options.stallMs ?? STALL_MS)
  if (!script.ok) return { ok: false, failure: { kind: "fetch_failed", url, detail: script.detail } }

  const lastLines: string[] = []
  const onLine = (line: string): void => {
    options.onOutput(line)
    lastLines.push(line)
    if (lastLines.length > KEPT_LINES) lastLines.shift()
  }
  const directory = await mkdtemp(join(tmpdir(), "flywheel-install-"))
  let exit: InstallerExit
  try {
    const path = join(directory, options.platform === "win32" ? "install.ps1" : "install.sh")
    await writeFile(path, script.bytes, { mode: 0o600 })
    const [command, ...args] = options.platform === "win32"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path]
      : ["sh", path]
    const spawnProcess = options.spawnProcess ?? ((file: string, argv: readonly string[], spawnOptions: SpawnOptions) => spawn(file, [...argv], spawnOptions))
    exit = await runInstaller(spawnProcess(command!, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), onLine)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  if (exit.error !== undefined) onLine(exit.error)
  if (exit.code !== 0) return { ok: false, failure: { kind: "installer_failed", url, exitCode: exit.code, lastLines } }

  const version = await (options.probe ?? probeVersion)(options.launcher)
  if (version === undefined) return { ok: false, failure: { kind: "launcher_silent", url, launcher: options.launcher, lastLines } }
  if (!isVersionAtLeast(version, options.minimumVersion)) {
    return { ok: false, failure: { kind: "launcher_too_old", url, launcher: options.launcher, version, minimum: options.minimumVersion } }
  }
  return { ok: true, version }
}

/** One plain sentence for the panel and the output channel, naming the
 *  release address so a person can run the same installer by hand. */
export function describeInstallFailure(failure: InstallFailure): string {
  const tail = (lines: readonly string[]): string => lines.length === 0 ? "" : `\n${lines.join("\n")}`
  switch (failure.kind) {
    case "fetch_failed":
      return `Flywheel could not be installed: the installer could not be downloaded from ${failure.url} (${failure.detail}). Choose Try again to run it again.`
    case "installer_failed":
      return `Flywheel could not be installed: the installer from ${failure.url} ${failure.exitCode === null ? "did not run" : `exited with code ${failure.exitCode}`}. Choose Try again to run it again.${tail(failure.lastLines)}`
    case "launcher_silent":
      return `Flywheel was installed from ${failure.url}, but ${failure.launcher} does not answer. Choose Try again to run it again.${tail(failure.lastLines)}`
    case "launcher_too_old":
      return `The installer from ${failure.url} installed Flywheel ${failure.version}, and this extension needs ${failure.minimum} or newer.`
  }
}

type FetchedScript = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly detail: string }

async function fetchInstaller(url: string, fetchScript: NonNullable<InstallOptions["fetch"]>, stallMs: number): Promise<FetchedScript> {
  const controller = new AbortController()
  let stall = setTimeout(() => controller.abort(), stallMs)
  const progressed = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), stallMs)
  }
  try {
    const response = await fetchScript(url, { signal: controller.signal })
    if (!response.ok || response.body === null) return { ok: false, detail: `the server answered ${response.status}` }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      progressed()
      const read = await reader.read()
      if (read.done) break
      total += read.value.byteLength
      if (total > MAX_SCRIPT_BYTES) {
        controller.abort()
        return { ok: false, detail: `the answer is larger than the ${MAX_SCRIPT_BYTES} bytes an installer can be` }
      }
      chunks.push(read.value)
    }
    return { ok: true, bytes: Buffer.concat(chunks) }
  } catch (cause) {
    return { ok: false, detail: controller.signal.aborted ? `no bytes arrived for ${Math.round(stallMs / 1000)} s` : String(cause) }
  } finally {
    clearTimeout(stall)
  }
}

interface InstallerExit {
  readonly code: number | null
  readonly error?: string
}

/** Forwards every line the installer prints and settles when it exits and its
 *  output is drained, or when it could not start. */
async function runInstaller(child: InstallerProcess, onLine: (line: string) => void): Promise<InstallerExit> {
  const lines = (stream: Readable | null): Promise<void> => stream === null
    ? Promise.resolve()
    : new Promise((resolve) => {
      createInterface({ input: stream }).on("line", onLine).once("close", resolve)
    })
  const drained = Promise.all([lines(child.stdout), lines(child.stderr)])
  const exit = await new Promise<InstallerExit>((resolve) => {
    child.once("error", (cause) => resolve({ code: null, error: String(cause) }))
    child.once("close", (code) => resolve({ code }))
  })
  if (exit.error === undefined) await drained
  return exit
}
