import type { RuntimeConfigDiagnostic, RuntimeConfigStatusView } from "../runtime-config-protocol-types.js"

/** What one setting's configuration problem means, in the words every client
 *  shows under the setting. An invalid value in a file the runtime rejected
 *  whole does not put the default in force: the runtime keeps the last valid
 *  file, so every other edit in the rejected file waits too. */
export function configProblemText(reason: RuntimeConfigDiagnostic["reason"], status: RuntimeConfigStatusView): string {
  if (reason === "normalized-value") return "Flywheel adjusted this value to one it accepts."
  if (status.kind === "malformed" && status.fallback === "last-valid") return "This value is invalid, so Flywheel kept the last valid file."
  return "This value is invalid, so the default is in force."
}
