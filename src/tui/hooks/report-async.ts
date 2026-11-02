import { errorMessage } from "../../infra/error-message.js"
import type { ShellServices } from "./shell-state.js"

/** Fire-and-forget runner for async actions triggered from sync UI handlers
 *  (key presses, command palette). Failures surface as error toasts. */
export function createAsyncReporter(showToast: ShellServices["showToast"]): (fn: () => Promise<void>) => void {
  return (fn) => {
    void Promise.resolve(fn()).catch((err) => {
      showToast({ message: errorMessage(err), variant: "error" })
    })
  }
}

/** Runs an async command step that answers whether it accepted the person's
 *  input. A failure surfaces as an error toast and counts as a refusal, so
 *  the caller can hand the input back. */
export function createAcceptanceReporter(showToast: ShellServices["showToast"]): (fn: () => Promise<boolean>) => Promise<boolean> {
  return async (fn) => {
    try {
      return await fn()
    } catch (err) {
      showToast({ message: errorMessage(err), variant: "error" })
      return false
    }
  }
}
