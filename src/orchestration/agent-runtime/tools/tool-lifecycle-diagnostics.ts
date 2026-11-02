import { Log } from "../../../infra/log.js";
import type { ToolCall } from "../llm/types.js";

export type ToolLifecyclePhase =
  | "registration-started"
  | "registered"
  | "fiber-entered"
  | "stream-gate-released"
  | "admission-wait"
  | "admitted"
  | "handler-started"
  | "permit-released"
  | "handler-settled"
  | "fiber-exited";

/** Write an opt-in, path-free lifecycle marker to stderr, where whoever holds the process's output reads how far each tool call got after an external watchdog ends the process: the account keeps an executor's last output in its exit record. */
export function writeToolLifecycleDiagnostic(call: ToolCall, phase: ToolLifecyclePhase): void {
  if (process.env.FLYWHEEL_TOOL_LIFECYCLE_TRACE !== "1") return;
  const record = JSON.stringify({ toolUseId: call.id.slice(0, 128), phase });
  try {
    Log.writeDiagnosticStderr(`FLYWHEEL_TOOL_LIFECYCLE ${record}\n`);
  } catch {
    // Diagnostics cannot become part of the tool lifecycle they observe.
  }
}
