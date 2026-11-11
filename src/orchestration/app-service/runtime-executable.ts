import { readFileSync } from "node:fs"
import { basename, dirname, join, posix } from "node:path"

import { runningSourceSnapshot, runsThroughBun, sourceCheckout } from "../../infra/cli-subprocess.js"
import type { AccountDirectories, StartupDirectories } from "../../infra/directory-authorities.js"
import { activeBuildDir } from "../../infra/update/active-build.js"
import { accountBuildId, executableBuild, ownBuildId } from "../../infra/update/live-builds.js"
import { installedLauncherPath } from "../../protocol/installation.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../protocol/runtime-liveness.js"


/** The installed command for this account: its launcher, the POSIX wrapper or
 *  the Windows `flywheel.exe`, when this process runs a build of the
 *  account's versions tree. A source checkout has no installed command. */
export function installedExecutable(input: { readonly platform: NodeJS.Platform; readonly userDataRoot: string; readonly accountHome: string; readonly installDirectory: string | undefined; readonly execPath: string }): string | undefined {
  if (posix.basename(input.execPath) === "bun") return undefined
  if (ownBuildId(input.userDataRoot, input.execPath) === undefined) return undefined
  return installedLauncherPath(input.platform, { FLYWHEEL_INSTALL_DIR: input.installDirectory, LOCALAPPDATA: process.env.LOCALAPPDATA }, input.accountHome)
}

/** The command that runs this account's Flywheel: the installed launcher when
 *  there is one, else this program itself. A runtime is always started from
 *  the installed build rather than from the process that wants it, so a
 *  client on an older build starts the current one, and a runtime that
 *  stopped for an update is replaced by the build the update installed.
 *
 *  A source run re-enters through its checkout's development launcher, the
 *  same way `bin/flywheel` starts it: that entry stages the runtime's own
 *  native assets, which a runtime that inherited the starter's staged assets
 *  would lose the moment the starter exited, resolves SolidJS under the
 *  browser export condition, and takes a snapshot of the checkout's current
 *  source. The launcher is the checkout's, never the one in the snapshot the
 *  starter runs from, so a client that started before an edit starts a
 *  runtime of the source the checkout holds now. */
export function runtimeCommand(directories: AccountDirectories): readonly string[] {
  const installed = installedExecutable({ platform: process.platform, userDataRoot: directories.userDataRoot, accountHome: directories.accountHome, installDirectory: process.env.FLYWHEEL_INSTALL_DIR, execPath: process.execPath })
  if (installed !== undefined) return [installed]
  if (!runsThroughBun(process.execPath)) return [process.execPath]
  return sourceRuntimeCommand()
}

/** A source run's entry: this Bun through the checkout's development launcher. */
export function sourceRuntimeCommand(): readonly [string, ...string[]] {
  return [process.execPath, "--conditions=browser", join(sourceCheckout(), "scripts", "dev.ts")]
}

/** The build identity of a runtime started from a source checkout. */
export function sourceBuildId(protocolVersion: number): string {
  return `source:protocol-${protocolVersion}`
}

/** The protocol version the checkout's source declares right now, read from
 *  the one module that owns the constant. It is the checkout's, never the
 *  snapshot's that a dev service runs, which is fixed at the service's
 *  start. Reading source text is a boundary read of the developer's own
 *  tree: a shape it does not recognize is no answer, which leaves a source
 *  runtime up as it always was. */
export function checkoutProtocolVersion(): number | undefined {
  try {
    const source = readFileSync(join(sourceCheckout(), "src", "protocol", "runtime-liveness.ts"), "utf8")
    const declared = /^export const RUNTIME_PROTOCOL_VERSION = (\d+)$/m.exec(source)?.[1]
    return declared === undefined ? undefined : Number(declared)
  } catch {
    return undefined
  }
}

/** The build a start would run right now, with the version it states. */
export interface InstalledBuild {
  readonly buildId: string
  readonly version: string
}

/** The build a start would run right now: for a source checkout the protocol
 *  its source declares, otherwise the build the account's activation names,
 *  which is what the launcher on every platform runs. The version is the
 *  directory the versions home places the build under. A source checkout
 *  states no release version. */
export function installedBuild(directories: StartupDirectories, host: { readonly execPath: string } = process): InstalledBuild | undefined {
  if (runsThroughBun(host.execPath)) {
    const protocolVersion = checkoutProtocolVersion()
    return protocolVersion === undefined ? undefined : { buildId: sourceBuildId(protocolVersion), version: "source" }
  }
  const build = activeBuildDir(directories.userDataRoot)
  return build === undefined ? undefined : { buildId: basename(build), version: basename(dirname(build)) }
}

/** The identity of the build a start would run right now. */
export function installedBuildId(directories: StartupDirectories, host: { readonly execPath: string } = process): string | undefined {
  return installedBuild(directories, host)?.buildId
}

/** What an executable says it is, read at one moment: a source run, an
 *  installed build with the directory it was launched from, or nothing
 *  Flywheel installed. */
export type RunningBuild =
  | { readonly kind: "source" }
  | { readonly kind: "installed"; readonly buildId: string; readonly buildDir: string }
  | { readonly kind: "unknown" }

/** Reads what `host`'s executable says it is now: the protocol a source run
 *  was loaded with, or the build directory it runs from. It is never read
 *  from `current`, which an install can move to a newer build at any
 *  moment. */
export function readRunningBuild(host: { readonly execPath: string } = process): RunningBuild {
  if (runsThroughBun(host.execPath)) return { kind: "source" }
  const build = executableBuild(host.execPath)
  return build === undefined ? { kind: "unknown" } : { kind: "installed", ...build }
}

let processBuild: RunningBuild | undefined

/** The build this process executes, read once and kept. The CLI entry reads
 *  it first, so every later question about this process's build is answered
 *  by that one read of an immutable build directory. */
export function processRunningBuild(): RunningBuild {
  processBuild ??= readRunningBuild()
  return processBuild
}

/** The code identity of this process for a person to read, or null when it
 *  cannot be known: a source run's snapshot digest, or the installed build id
 *  captured at process start. The protocol-only source id names no code, and
 *  neither the `current` link nor a checkout's HEAD says what runs. */
export function runningDisplayBuildId(build: RunningBuild = processRunningBuild()): string | null {
  if (build.kind === "source") return runningSourceSnapshot()?.digest ?? null
  return build.kind === "installed" ? build.buildId : null
}

/** The id of `build` for the account at `directories`: a source run's
 *  protocol, or a build that sits in this account's versions home. */
export function runningBuildId(build: RunningBuild, directories: Pick<StartupDirectories, "userDataRoot">): string | undefined {
  if (build.kind === "source") return sourceBuildId(RUNTIME_PROTOCOL_VERSION)
  if (build.kind === "unknown") return undefined
  return accountBuildId({ buildDir: build.buildDir, buildId: build.buildId }, directories.userDataRoot)
}
