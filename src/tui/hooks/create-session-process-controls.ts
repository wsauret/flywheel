import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { toolProcess } from "../../protocol/client/transcript-model.js"
import type { RowProcessControls } from "../output-blocks/stop-affordance.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import { terminateBackgroundCommand } from "./use-background-modal.js"

interface SessionProcessControlDeps {
  readonly appService: Pick<RuntimeClient, "dispatch">
  readonly signals: Pick<ShellSignals, "statusView">
  readonly showToast: ShellServices["showToast"]
}

/** The process controls of one session's transcript rows. The controls hold
 *  no reactive computation: each answer is a plain read of the session's
 *  live status, so a caller may ask for them, and ask them, in any scope. */
export function createSessionProcessControls(deps: SessionProcessControlDeps): (sessionId: string) => RowProcessControls {
  return (sessionId) => {
    const status = () => deps.signals.statusView(sessionId)
    return {
      status,
      onDetach: (toolUseId) => {
        if (!toolProcess(status(), toolUseId).held) return
        void deps.appService.dispatch({ type: "bash.detach", sessionId, toolUseId })
      },
      onStop: (toolUseId) => {
        if (!toolProcess(status(), toolUseId).managed) return
        void terminateBackgroundCommand(deps, sessionId, { toolUseId })
      },
      // A child's Stop ends the parent's tool call it answers: the parent is
      // this transcript's session, and the call is the card's.
      onStopChild: (toolUseId) => {
        void deps.appService.dispatch({ type: "background.terminate", sessionId, toolUseId }).then((result) => {
          if (!result.ok) deps.showToast({ message: result.error, variant: "error" })
        })
      },
    }
  }
}
