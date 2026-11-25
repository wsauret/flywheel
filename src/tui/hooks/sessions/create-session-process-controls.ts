import { errorMessage } from "../../../infra/error-message.js"
import type { RuntimeClient } from "../../../protocol/runtime/app-service-types.js"
import { toolProcess } from "../../../protocol/client/transcript/transcript-model.js"
import type { RowProcessControls } from "../../transcript/output-blocks/stop-affordance.js"
import type { ShellServices, ShellSignals } from "../state/shell-state.js"

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
        void terminateBackgroundCommand(deps, sessionId, toolUseId)
      },
      // A child's Cancel ends the parent's tool call it answers: the parent is
      // this transcript's session, and the call is the card's.
      onStopChild: (toolUseId) => {
        void deps.appService.dispatch({ type: "background.terminate", sessionId, toolUseId }).then((result) => {
          if (!result.ok) deps.showToast({ message: result.error, variant: "error" })
        })
      },
    }
  }
}

/** Never throws: the inline transcript stop affordance fire-and-forgets
 *  this. Stop is idempotent (a settled task is a no-op), so the only failure
 *  mode is a transport error; the stop affordance disappearing is the
 *  success feedback. */
async function terminateBackgroundCommand(deps: SessionProcessControlDeps, sessionId: string, toolUseId: string): Promise<void> {
  try {
    await deps.appService.dispatch({ type: "background.terminate", sessionId, toolUseId })
  } catch (err) {
    deps.showToast({ message: errorMessage(err), variant: "error" })
  }
}
