import { rmSync } from "node:fs"

import type { ServeLane } from "../infra/cli-subprocess.js"
import type { LaunchState } from "../infra/launch-state.js"
import { accountServeDir } from "../infra/paths.js"
import { shutdownSignals } from "../infra/shutdown-signals.js"
import type { LeftTerminal } from "../tui/exit.js"

type Environment = { readonly [name: string]: string | undefined }

/** The program a terminal re-executes into: the build that serves, or its
 *  lane's entry after a restart. */
export interface TerminalSuccessor {
  /** The program and its leading arguments; the terminal's own arguments follow. */
  readonly command: readonly string[]
  /** What the program's own launcher would export before running it. */
  readonly env: { readonly [name: string]: string }
}

/** The successor's environment variable that names its launch-state file.
 *  The name rides the environment rather than an argument because the
 *  successor can be a build that predates it: such a build ignores a variable
 *  it does not know and starts plain, where an unknown argument would refuse
 *  to start. */
export const LAUNCH_STATE_ENV = "FLYWHEEL_LAUNCH_STATE"

/** The successor's environment variable that names the project on a remote
 *  machine a terminal attached through the relay was showing, as
 *  `RemoteAttach.handoff` states it. It rides the environment for the same
 *  reason the place does, and the successor opens that project without
 *  asking. */
export const REMOTE_HANDOFF_ENV = "FLYWHEEL_REMOTE_PROJECT"

export interface TerminalHandoffOptions {
  readonly lane: ServeLane
  readonly userDataRoot: string
  /** The project root the successor opens, or for a terminal attached to a
   *  remote machine the directory of its own state for that project. */
  readonly projectRoot: string
  /** The project on a remote machine this terminal shows, which the
   *  successor opens through the relay instead of a local project root. */
  readonly remote?: string
  readonly allowPersistentProcesses: boolean
  readonly printLogs: boolean
  /** The place a predecessor handed this terminal, which it carries on when
   *  it must follow again before its shell has shown it. */
  readonly incoming: LaunchState | undefined
}

export interface TerminalHandoffSeams {
  readonly env?: Environment
  readonly leaveTerminal?: () => Promise<LeftTerminal>
  readonly platform?: NodeJS.Platform
  /** Replaces this process image. Absent where the platform cannot, which is
   *  Windows; the successor then runs as this terminal's child. */
  readonly replace?: ((command: readonly string[], env: Environment) => never) | undefined
  readonly runSuccessor?: (command: readonly string[], env: Environment) => Promise<number>
  readonly exit?: (code: number) => never
}

/** How a terminal becomes its successor (ARCH-RUNTIME-036, ARCH-DISTRIBUTION-031). */
export interface TerminalHandoff {
  /** Hands the person's place to the successor and becomes it, keeping the
   *  pid, the shell's foreground job, and the tty. Never settles once the
   *  successor runs; rejects when it cannot start, after the terminal is back. */
  follow(target: TerminalSuccessor): Promise<never>
  /** Adds one release of something this process image owns, run in order
   *  just before the image is replaced, or after a successor that ran as
   *  this terminal's child has ended: a live-build record, the launcher and
   *  the processes it owns, the log. */
  release(step: () => void | Promise<void>): void
}

/** Replacing the image skips the exit event, and its listeners release this
 *  process's temporary files, so they run first. */
function replaceProcess(command: readonly string[], env: Environment): never {
  const [file] = command
  if (file === undefined || process.execve === undefined) throw new Error("this platform cannot replace a process image")
  process.emit("exit", 0)
  return process.execve(file, command, { ...env })
}

export function createTerminalHandoff(options: TerminalHandoffOptions, seams: TerminalHandoffSeams = {}): TerminalHandoff {
  const releases: (() => void | Promise<void>)[] = []
  // Bun on Windows defines `process.execve` but throws when it is called, so
  // the platform decides, not the function's presence.
  const replace = "replace" in seams ? seams.replace : (seams.platform ?? process.platform) === "win32" ? undefined : replaceProcess
  let failure: Error | undefined

  async function follow(target: TerminalSuccessor): Promise<never> {
    // One failed handoff is the fault the person sees; a reconnect loop that
    // suspended and resumed the renderer on every attempt would be noise.
    if (failure !== undefined) throw new Error(failure.message, { cause: failure })
    const leaveTerminal = seams.leaveTerminal ?? (await import("../tui/exit.js")).leaveTerminal
    const left = await leaveTerminal()
    let statePath: string | undefined
    let successorExitCode: number
    let restoreSignals = (): void => {}
    try {
      const state = left.state ?? options.incoming
      const { writeLaunchState } = await import("../infra/launch-state.js")
      if (state !== undefined) statePath = writeLaunchState(accountServeDir(options.userDataRoot, options.lane), state)
      // Only arguments the successor parses; the place rides the environment.
      // `--remote` is newer than some builds, but a relay terminal's
      // successor is always a later release, which parses it.
      const command = [
        ...target.command,
        ...(options.remote === undefined ? ["--project-root", options.projectRoot] : ["--remote"]),
        ...(options.allowPersistentProcesses ? ["--allow-persistent-processes"] : []),
        ...(options.printLogs ? ["--print-logs"] : []),
      ]
      const { [LAUNCH_STATE_ENV]: _inherited, [REMOTE_HANDOFF_ENV]: _inheritedRemote, ...inherited } = seams.env ?? process.env
      const env = {
        ...inherited,
        ...target.env,
        ...(statePath === undefined ? {} : { [LAUNCH_STATE_ENV]: statePath }),
        ...(options.remote === undefined ? {} : { [REMOTE_HANDOFF_ENV]: options.remote }),
      }
      if (replace !== undefined) {
        for (const step of releases) await step()
        return replace(command, env)
      }
      // The successor now owns the terminal, and the signals a terminal sends
      // reach it as well; this process only waits to hand its status back,
      // and releases what it owns once the successor has ended.
      restoreSignals = holdShutdownSignals()
      const { runForegroundSuccessor } = await import("../infra/foreground-successor.js")
      successorExitCode = await (seams.runSuccessor ?? runForegroundSuccessor)(command, env)
      for (const step of releases) await step()
    } catch (error) {
      restoreSignals()
      if (statePath !== undefined) rmSync(statePath, { force: true })
      await left.resume()
      const failed = error instanceof Error ? error : new Error(String(error))
      failure = failed
      throw failed
    }
    // A suspended renderer needs no terminal restoration bytes. Close its
    // native owner before the exit handler tries to restore the Windows sink.
    try {
      await left.destroy()
    } finally {
      restoreSignals()
    }
    return (seams.exit ?? process.exit)(successorExitCode)
  }

  return {
    follow,
    release: (step) => { releases.push(step) },
  }
}

function holdShutdownSignals(): () => void {
  const held = shutdownSignals(process.platform).map((signal) => ({ signal, listeners: process.listeners(signal) }))
  const ignore = (): void => {}
  for (const { signal } of held) {
    process.removeAllListeners(signal)
    process.on(signal, ignore)
  }
  return () => {
    for (const { signal, listeners } of held) {
      process.off(signal, ignore)
      for (const listener of listeners) process.on(signal, listener)
    }
  }
}
