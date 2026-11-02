import type { RuntimeClient, SessionRow } from "../../protocol/app-service-types.js"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import { dispatchInterrupt, isInterruptible, offeredSessionControls, resumeMutationType, stopMutation, type ControlRefusal, type OfferedSessionControls } from "../../protocol/client/session-controls.js"
import type { ShellServices } from "./shell-state.js"
import type { Accessor } from "solid-js"

/** The one slice of a row the controls read: its id for the mutation, its
 *  kind for the mutation type, the actions it admits, and the parent's tool
 *  call that Stop terminates. */
export type ControlledSessionRow = Pick<SessionRow, "id" | "kind" | "admittedActions" | "parentSessionId" | "parentToolUseId">

interface SessionControlsDeps {
  /** The foreground session's row with its admitted actions. */
  row: Accessor<ControlledSessionRow | null>
  /** The foreground session's live status: whether it has something to interrupt now. */
  status: Accessor<StatusView | undefined>
  appService: Pick<RuntimeClient, "dispatch">
  showToast: ShellServices["showToast"]
}

export interface SessionControlsHook {
  /** What the foreground session offers now, read once for the prompt hint,
   *  the phase line, and the keys. */
  offered: Accessor<OfferedSessionControls>
  /** Interrupts the foreground session's running turn or agent; it can be resumed. */
  interrupt(): void
  /** Continues the foreground session from where it stopped, with no new message. */
  resume(): void
  /** Ends the foreground session's run for good through its parent's tool call. */
  stop(): void
}

/** One Interrupt, one Resume, and one Stop for every session kind
 *  (PI-INTERACTION-043, PI-INTERACTION-044, PI-AGENT-020): the row's kind
 *  picks the mutation, and the runtime's refusal is shown in its own words. */
export function useSessionControls(deps: SessionControlsDeps): SessionControlsHook {
  const offered = () => offeredSessionControls(deps.row(), isInterruptible(deps.status()))

  function report(subject: string, refusal: ControlRefusal | undefined): void {
    if (refusal) deps.showToast({ message: `${subject}: ${refusal.reason}`, variant: refusal.variant })
  }

  function refusalOf(result: { readonly ok: true } | { readonly ok: false; readonly error: string }): ControlRefusal | undefined {
    return result.ok ? undefined : { reason: result.error, variant: "error" }
  }

  function failed(subject: string): (err: unknown) => void {
    return (err) => deps.showToast({ message: `${subject}: ${err instanceof Error ? err.message : String(err)}`, variant: "error" })
  }

  function interrupt(): void {
    const row = deps.row()
    if (!row) return
    void dispatchInterrupt(deps.appService, row).then((refusal) => report("Interrupt failed", refusal))
  }

  function resume(): void {
    const row = deps.row()
    if (!row) return
    void deps.appService.dispatch({ type: resumeMutationType(row.kind), sessionId: row.id })
      .then((result) => report("Resume failed", refusalOf(result)))
      .catch(failed("Resume failed"))
  }

  function stop(): void {
    const mutation = stopMutation(deps.row() ?? undefined)
    if (!mutation) return
    void deps.appService.dispatch(mutation)
      .then((result) => report("Stop failed", refusalOf(result)))
      .catch(failed("Stop failed"))
  }

  return { offered, interrupt, resume, stop }
}
