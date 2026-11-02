import { resolveDebugLogDirectory } from "../infra/debug-log.js"
import type { AccountDirectories, StartupDirectories } from "../infra/directory-authorities.js"
import { diagnosticDetail, errorMessage } from "../infra/error-message.js"
import { collapseHome } from "../infra/home-path.js"
import { Log } from "../infra/log.js"
import { startupTrace } from "../infra/startup-trace.js"
import type { LauncherContext } from "../infra/process-supervisor.js"
import { releaseFit, type ReleaseSide } from "../infra/update/release-fit.js"
import type { TerminalRemote, TerminalRemoteChoice, TerminalRemoteRequest, RemoteAttach } from "../orchestration/terminal-remote.js"
import type { AttachedRuntimeClient } from "../protocol/app-service-types.js"
import type { ReleaseInstall } from "../protocol/client/runtime-fault-copy.js"
import { RUNTIME_PROTOCOL_VERSION } from "../protocol/runtime-liveness.js"
import type { ReleaseInstallState } from "../tui/terminal-attach.js"
import { promptFromReadline } from "./readline-prompt.js"
import type { TerminalRuntime } from "./runtime-launch.js"
import type { TerminalHandoff, TerminalSuccessor } from "./terminal-handoff.js"

/** The terminal's reach to a project on another machine (PI-REMOTE-016),
 *  loaded only by a launch that offers or opens one, so a local launch reads
 *  none of the module catalog, the relay, or the update path. */

const log = Log.create({ service: "remote-terminal" })

async function loadTerminalRemote(): Promise<TerminalRemote> {
  const { installedTerminalRemote } = await import("../orchestration/modules.js")
  const contribution = installedTerminalRemote()
  if (contribution === undefined) throw new Error("This build of Flywheel cannot open a project on another machine.")
  return await contribution.load()
}

/** How many machines this account's terminal is paired with. */
export async function pairedMachineCount(userDataRoot: string): Promise<number> {
  return (await loadTerminalRemote()).pairedMachines(userDataRoot)
}

/** Asks the person for a project on a paired machine through the module that
 *  owns remote access, on this process's terminal. */
export async function chooseRemoteProject(request: Omit<TerminalRemoteRequest, "prompt" | "print">): Promise<TerminalRemoteChoice> {
  const remote = await loadTerminalRemote()
  return await remote.choose({ ...request, prompt: tracedPrompt, print: (line) => { process.stdout.write(`${line}\n`) } })
}

/** The picker's question on this process's terminal. The boot trace marks
 *  each question and its answer, so the release performance gate
 *  (`tests/release/scenarios/remote-attach.ts`) counts the terminal's own
 *  startup work and not the time the person takes to choose. */
async function tracedPrompt(question: string): Promise<string> {
  startupTrace("remote project question shown")
  try {
    return await promptFromReadline(question)
  } finally {
    startupTrace("remote project question answered")
  }
}

/** Installs the release a remote machine runs into this terminal's account
 *  and answers the program the terminal becomes to run it, or why no install
 *  reached it. */
export async function installTerminalRelease(account: AccountDirectories, launcher: LauncherContext, version: string): Promise<TerminalSuccessor | string> {
  const [{ installRelease, releaseInstallRefusal }, { runtimeCommand }] = await Promise.all([import("./update.js"), import("../orchestration/app-service/runtime-executable.js")])
  const result = await installRelease(account, launcher, version)
  if (result.kind !== "installed") return releaseInstallRefusal(result, version)
  return { command: runtimeCommand(account), env: {} }
}

/** Connects the terminal to a project on a remote machine through the
 *  relay's sealed socket, with the in-band release guard. */
export function launchRelayRuntime(remote: RemoteAttach, directories: StartupDirectories, launcher: LauncherContext, handoff: TerminalHandoff): TerminalRuntime {
  log.info("relay runtime client start", { runtimeId: remote.runtimeId, placementId: remote.placementId })
  const client = remote.connect((message, detail) => log.warn(message, { detail: diagnosticDetail(detail) }))
  const install = guardRelease({
    client,
    terminal: { version: process.env.FLYWHEEL_APP_VERSION, protocolVersion: RUNTIME_PROTOCOL_VERSION },
    install: (version) => installTerminalRelease(directories, launcher, version),
    follow: (successor) => handoff.follow(successor),
  })
  return {
    client,
    dispose: async () => {
      install.stop()
      await client.close()
    },
    // The terminal keeps its own log under the machine's state root, not in
    // the account log a local terminal's notice names.
    attach: { kind: "relay", machine: remote.machine, install, log: collapseHome(resolveDebugLogDirectory(directories.projectRoot), directories.accountHome) },
    projectRoot: remote.project,
    attachedIdentity: Promise.resolve({ version: remote.release.version, buildId: null }),
  }
}

export interface ReleaseGuardOptions {
  readonly client: Pick<AttachedRuntimeClient, "subscribe">
  readonly terminal: ReleaseSide
  /** Installs one release, and answers the program that runs it or why it
   *  was not installed. */
  readonly install: (version: string) => Promise<TerminalSuccessor | string>
  /** Becomes the program that runs the installed release. Never settles once
   *  the successor runs. */
  readonly follow: (successor: TerminalSuccessor) => Promise<never>
}

/** The in-band release guard of a relay terminal (PI-REMOTE-016). Presence
 *  said the releases fit, but the machine can update between that answer and
 *  an attach, so the runtime's typed protocol refusal names its release. A
 *  refusal that names a later release installs it, and the terminal becomes
 *  it; the state says so while it installs, and says why when it could not,
 *  for the fault notice to show. A refusal that names an earlier release asks
 *  nothing: the notice says the terminal attaches once the machine has
 *  updated. A frame the terminal cannot decode is not taken as an earlier
 *  runtime: presence names the release, so only a build its release does not
 *  name can send one. */
export function guardRelease(options: ReleaseGuardOptions): ReleaseInstallState & { stop(): void } {
  let current: ReleaseInstall | undefined
  const listeners = new Set<(install: ReleaseInstall | undefined) => void>()
  const set = (next: ReleaseInstall): void => {
    current = next
    for (const listener of listeners) listener(next)
  }
  const stop = options.client.subscribe((event) => {
    if (current?.status === "installing" || event.type !== "runtime.health" || event.health.kind !== "faulted" || event.health.refusal?.kind !== "protocol-mismatch") return
    const fit = releaseFit(options.terminal, event.health.refusal)
    if (fit.kind !== "install") return
    const version = fit.version
    log.info("remote runtime runs a later release; this terminal installs it", { version })
    set({ status: "installing", version })
    void (async () => {
      const successor = await options.install(version)
      if (typeof successor === "string") throw new Error(successor)
      return await options.follow(successor)
    })().catch((cause: unknown) => {
      log.warn("this terminal could not install the remote runtime's release", { version, error: errorMessage(cause) })
      set({ status: "failed", version, message: errorMessage(cause) })
    })
  })
  return {
    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },
    stop,
  }
}
