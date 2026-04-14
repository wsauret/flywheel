import type { RunnerDoneResult, RunnerErrorResult } from "../../orchestration/session/types.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

export function wireLifecycleCallbacks(signals: ShellSignals, services: ShellServices) {
  return {
    onRunnerDone: (_id: string, result: RunnerDoneResult) => {
      services.setTerminalTitle(result.terminalTitle)
    },
    onRunnerError: (_id: string, result: RunnerErrorResult) => {
      signals.setErrorMessage(result.errorMessage)
      services.setTerminalTitle(result.terminalTitle)
    },
  }
}
