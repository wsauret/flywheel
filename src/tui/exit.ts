// Module-scoped because the exit handler is process-global by nature; the terminal
// state, SIGINT handler, and renderer instance all have one-per-process identity.
// Converting to a factory + DI would thread props through shell.tsx and app.tsx for
// no new capability (there is no second exit controller to inject). Consistent with
// the Dependency Inversion rule of docs/elegance.md: when a rule produces indirection without depth, don't.

import { errorDetail, errorMessage } from "../infra/error-message.js"
import type { LaunchState } from "../infra/launch-state.js"
import { Log } from "../infra/log.js"
import { armProcessWatchdog } from "../infra/process-watchdog.js"

const log = Log.create({ service: "tui-exit" })

let globalExit: (() => void) | "exiting" | null = null
const preExitCleanups: (() => Promise<void>)[] = []

export function exitTUI(): void {
  armProcessWatchdog()
  // Renderer restoration is asynchronous. Repeated exit input must not
  // terminate the process between destroy() and renderer.closed.
  if (globalExit === "exiting") return
  if (!globalExit) {
    process.exit(0)
    return
  }
  const exit = globalExit
  globalExit = "exiting"

  const cleanups = preExitCleanups.splice(0)

  if (cleanups.length > 0) {
    // 3s hard timeout; user must never be trapped in a dead TUI. unref() so an
    // idle event loop can still exit before the deadline fires.
    const forceExitTimer = setTimeout(() => { exit() }, 3_000)
    forceExitTimer.unref?.()
    void Promise.all(cleanups.map(fn => fn().catch((err) => {
      log.warn("pre-exit cleanup failed", { error: errorMessage(err), errorDetail: errorDetail(err) })
    })))
      .finally(() => { clearTimeout(forceExitTimer); exit() })
  } else {
    exit()
  }
}

export function setExitHandler(handler: () => void): void {
  globalExit = handler
}

export function registerPreExitCleanup(fn: () => Promise<void>): void {
  preExitCleanups.push(fn)
}

/** The renderer's side of a handoff: give the terminal back in its original
 *  modes, take it again after failure, or release its suspended resources. */
export interface RendererHandoff {
  suspend(): Promise<void>
  resume(): Promise<void>
  /** Resolves after native cleanup. Rejects if the output owner fails to close. */
  destroy(): Promise<void>
}

let rendererHandoff: RendererHandoff | null = null
let launchStateCapture: (() => LaunchState) | null = null

export function setRendererHandoff(handoff: RendererHandoff | null): void {
  rendererHandoff = handoff
}

/** The shell names what the person is looking at, for a successor to restore. */
export function setLaunchStateCapture(capture: (() => LaunchState) | null): void {
  launchStateCapture = capture
}

export interface LeftTerminal {
  /** The place the shell captured, or undefined before the shell mounted. */
  readonly state: LaunchState | undefined
  /** Takes the terminal back after a handoff that could not happen. */
  resume(): Promise<void>
  /** Releases the suspended renderer without taking the terminal back.
   *  Resolves after native output and resource cleanup have finished. */
  destroy(): Promise<void>
}

/** Leaves the terminal to a successor process (ARCH-RUNTIME-036, ARCH-DISTRIBUTION-031): captures the place
 *  first, while the shell still runs, then suspends the renderer so the
 *  successor's first frame is the next one drawn. Until `resume`, an exit
 *  ends this process without touching the terminal, which is no longer its. */
export async function leaveTerminal(): Promise<LeftTerminal> {
  const state = launchStateCapture?.()
  const renderer = rendererHandoff
  await renderer?.suspend()
  const exit = globalExit
  globalExit = null
  return {
    state,
    resume: async () => {
      await renderer?.resume()
      globalExit = exit
    },
    destroy: async () => { await renderer?.destroy() },
  }
}
