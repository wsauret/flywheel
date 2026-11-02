import type { InstallFailure } from "./bootstrap-install.js"
import type { ResolveFailure, ResolvedRuntime } from "./runtime-resolver.js"
import type { PrepareAccountResult, StartFailure } from "./supervisor.js"

/** Why the panel cannot show the client. Each cause has its own page, its
 *  own status bar reading, and its own remedy. */
export type HostFailure =
  | { readonly kind: "no_folder" }
  | { readonly kind: "resolve"; readonly failure: Exclude<ResolveFailure, { readonly kind: "none_found" }> }
  | { readonly kind: "install"; readonly failure: InstallFailure }
  | { readonly kind: "start"; readonly failure: StartFailure }
  /** The service listened, and then did not name its client. */
  | { readonly kind: "client"; readonly detail: string }

/** Where the editor is on its way to a client. `ready` carries what the
 *  host connects with; every other phase is a page in the panel. */
export type HostPhase =
  /** `since` is when this start began to wait, in epoch milliseconds, once
   *  a start runs. The start has no bound of its own, so the page counts the
   *  wait from it. */
  | { readonly kind: "starting"; readonly label?: string; readonly since?: number }
  | { readonly kind: "installing" }
  | { readonly kind: "unavailable"; readonly failure: HostFailure }
  | { readonly kind: "ready"; readonly runtime: ResolvedRuntime; readonly started: Extract<PrepareAccountResult, { readonly ok: true }> }

export interface EstablishDeps {
  /** The folder the runtime serves, or undefined when the window has none. */
  readonly projectRoot: () => string | undefined
  readonly resolve: () => Promise<{ readonly ok: true; readonly runtime: ResolvedRuntime } | { readonly ok: false; readonly failure: ResolveFailure }>
  /** Installs the current release; resolves with the installed runtime. */
  readonly install: () => Promise<{ readonly ok: true; readonly runtime: ResolvedRuntime } | { readonly ok: false; readonly failure: InstallFailure }>
  /** Finds or starts the account service with `runtime`, telling each step. */
  readonly start: (runtime: ResolvedRuntime, projectRoot: string, onStep: (label: string) => void) => Promise<PrepareAccountResult>
  /** The clock a start's wait is counted on. */
  readonly now: () => number
}

/** Takes the editor from nothing to a listening account service, telling
 *  `onPhase` each phase it passes through, and returns the last one: `ready`
 *  or `unavailable`. It is the one path every start takes, at activation and
 *  each time a person changes what it depends on, so a corrected setting
 *  starts Flywheel the same way a fresh window does. */
export async function establishRuntime(deps: EstablishDeps, onPhase: (phase: HostPhase) => void): Promise<Extract<HostPhase, { readonly kind: "ready" | "unavailable" }>> {
  const settle = <P extends Extract<HostPhase, { readonly kind: "ready" | "unavailable" }>>(phase: P): P => {
    onPhase(phase)
    return phase
  }
  const projectRoot = deps.projectRoot()
  if (projectRoot === undefined) return settle({ kind: "unavailable", failure: { kind: "no_folder" } })
  // An install is a wait of its own with its own page, so the start's wait
  // is counted again after it.
  let since = deps.now()
  onPhase({ kind: "starting", since })
  const resolved = await deps.resolve()
  let runtime: ResolvedRuntime
  if (resolved.ok) {
    runtime = resolved.runtime
  } else if (resolved.failure.kind === "none_found") {
    onPhase({ kind: "installing" })
    const installed = await deps.install()
    if (!installed.ok) return settle({ kind: "unavailable", failure: { kind: "install", failure: installed.failure } })
    runtime = installed.runtime
    since = deps.now()
    onPhase({ kind: "starting", since })
  } else {
    return settle({ kind: "unavailable", failure: { kind: "resolve", failure: resolved.failure } })
  }
  const started = await deps.start(runtime, projectRoot, (label) => onPhase({ kind: "starting", label, since }))
  if (!started.ok) return settle({ kind: "unavailable", failure: { kind: "start", failure: started.failure } })
  return settle({ kind: "ready", runtime, started })
}
