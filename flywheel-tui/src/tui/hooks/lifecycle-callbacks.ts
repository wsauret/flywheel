/**
 * Shared lifecycle callback wiring for workflow and chat controllers.
 *
 * Both controllers fire onRunnerDone/onRunnerError with the same shape.
 * This helper writes the result data to the shared shell signals.
 */

import type { RunnerDoneResult, RunnerErrorResult } from "../../orchestration/session/types.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

export function wireLifecycleCallbacks(signals: ShellSignals, services: ShellServices) {
  return {
    onRunnerDone: (_id: string, result: RunnerDoneResult) => {
      signals.setStatusLine(result.statusMessage)
      services.setTerminalTitle(result.terminalTitle)
      services.refreshList()
      signals.setForegroundId(undefined)
    },
    onRunnerError: (_id: string, result: RunnerErrorResult) => {
      signals.setErrorMessage(result.errorMessage)
      services.setTerminalTitle(result.terminalTitle)
      services.refreshList()
      signals.setForegroundId(undefined)
    },
  }
}
