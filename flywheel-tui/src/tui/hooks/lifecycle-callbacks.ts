/**
 * Shared lifecycle callback wiring for workflow and chat controllers.
 *
 * Both controllers fire onRunnerDone/onRunnerError with the same shape.
 * This helper writes the result data to the shared shell signals.
 */

import { batch } from "solid-js"
import type { RunnerDoneResult, RunnerErrorResult } from "../../orchestration/session/types.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

export function wireLifecycleCallbacks(signals: ShellSignals, services: ShellServices) {
  return {
    onRunnerDone: (_id: string, result: RunnerDoneResult) => {
      services.setTerminalTitle(result.terminalTitle)
      services.refreshList()
    },
    onRunnerError: (_id: string, result: RunnerErrorResult) => {
      batch(() => {
        signals.setErrorMessage(result.errorMessage)
        services.refreshList()
      })
      services.setTerminalTitle(result.terminalTitle)
    },
  }
}
