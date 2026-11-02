import type { ServeLane } from "../infra/cli-subprocess.js"
import type { FaultReach, ReleaseInstall } from "../protocol/client/runtime-fault-copy.js"

/** How this terminal reaches the runtime that serves its project (ARCH-RUNTIME-005).
 *  A terminal on the runtime's own machine attaches through the local account
 *  socket of its lane, and can restart that lane's service in place. A
 *  terminal on another machine attaches through the relay as a paired device
 *  (PI-REMOTE-016): it never stops, replaces, or retires the remote machine's
 *  runtime, and the person sits at the terminal, not at the machine. */
export type TerminalAttach =
  | { readonly kind: "local"; readonly lane: ServeLane; readonly restart: () => Promise<never> }
  | { readonly kind: "relay"; readonly machine: string; readonly install: ReleaseInstallState; readonly log: string }

/** The release a relay terminal installs because the machine refused it as
 *  the older side, while it installs it or after it could not. Nothing
 *  until such a refusal. A listener hears the current state at once. */
export interface ReleaseInstallState {
  subscribe(listener: (install: ReleaseInstall | undefined) => void): () => void
}

/** What a fault notice names as its remedy and log for this attach. */
export function faultReach(attach: TerminalAttach, install: ReleaseInstall | undefined): FaultReach {
  return attach.kind === "local" ? attach.lane : { machine: attach.machine, log: attach.log, ...(install === undefined ? {} : { install }) }
}

/** Who opens a sign-in page, which every login request of the terminal
 *  states. A local terminal sits at the runtime's machine, so the runtime
 *  opens the page and the flow can take its loopback callback. A relay
 *  terminal states nothing: the runtime's machine is elsewhere, so the
 *  terminal opens the page itself and shows its address and the field for
 *  the code or address the page ends on. */
export interface SignInPage {
  readonly request: { readonly openBrowser?: true }
  /** Whether the terminal opens a reported page in its own browser. */
  readonly opensLocally: boolean
}

export function signInPage(attach: Pick<TerminalAttach, "kind">): SignInPage {
  return attach.kind === "local" ? { request: { openBrowser: true }, opensLocally: false } : { request: {}, opensLocally: true }
}

/** Restarts the account service and this terminal in place, or says why a
 *  terminal attached through the relay never does. */
export function restartAttached(attach: TerminalAttach): Promise<never> {
  return attach.kind === "local" ? attach.restart() : Promise.reject(new Error(`Flywheel runs on ${attach.machine}. A terminal on another machine does not restart it.`))
}
