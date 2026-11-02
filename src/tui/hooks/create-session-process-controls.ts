import { createMemo } from "solid-js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { RowProcessControls } from "../output-blocks/stop-affordance.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import { terminateBackgroundCommand } from "./use-background-modal.js"

interface SessionProcessControlDeps {
  readonly appService: Pick<RuntimeClient, "dispatch">
  readonly signals: Pick<ShellSignals, "statusView">
  readonly showToast: ShellServices["showToast"]
}

export function createSessionProcessControls(deps: SessionProcessControlDeps): (sessionId: string) => RowProcessControls {
  return (sessionId) => {
    const activeHeldToolCallIds = createMemo<ReadonlySet<string>>(() => new Set(deps.signals.statusView(sessionId)?.activeForegroundBashToolCallIds))
    const activeManagedProcessToolCallIds = createMemo<ReadonlySet<string>>(() => new Set(deps.signals.statusView(sessionId)?.activeBackgroundCommands.map((command) => command.toolUseId)))
    const processorHeldToolCallIds = createMemo<ReadonlySet<string>>(() => new Set(deps.signals.statusView(sessionId)?.processorHeldToolCallIds))
    return {
      activeHeldToolCallIds,
      activeManagedProcessToolCallIds,
      processorHeldToolCallIds,
      onDetach: (toolUseId) => {
        if (!deps.signals.statusView(sessionId)?.activeForegroundBashToolCallIds.includes(toolUseId)) return
        void deps.appService.dispatch({ type: "bash.detach", sessionId, toolUseId })
      },
      onStop: (toolUseId) => {
        const command = deps.signals.statusView(sessionId)?.activeBackgroundCommands.find((candidate) => candidate.toolUseId === toolUseId)
        if (!command) return
        void terminateBackgroundCommand(deps, sessionId, command)
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
