import type { ModuleId } from "../../../src/protocol/module-ids.js"

/** The kernel's actions that a control can wait on. A typed name lets the
 *  control that reads a working state and the action that records it agree:
 *  a renamed action fails to compile in both places instead of leaving a
 *  control that never shows that it works. */
type KernelAction =
  | "answer" | "capability" | "close" | "command" | "compact" | "delete" | "detach" | "dismiss-notice"
  | "interrupt" | "load-older" | "model" | "model-effort" | "model-reset" | "model-role" | "model-seat" | "new-chat"
  | "profile-create" | "profile-pin" | "profile-rename" | "profile-select"
  | "provider-consent" | "provider-disconnect" | "provider-login" | "provider-login-finish"
  | "provider-model" | "provider-models" | "provider-models-recheck" | "provider-rename" | "providers-refresh"
  | "recall-queued" | "reconnect" | "rename" | "restart" | "resume" | "setting" | "skip" | "stop" | "stop-tool"

/** A module names its own actions under its id, such as `mcp.authenticate`,
 *  so its words stay in its home. */
export type ActionName = KernelAction | `${ModuleId}.${string}`

/** The key the actions layer records a running action under: what the action
 *  does and what it acts on, such as `stop:<session id>`. A target with more
 *  than one part, such as a command in a session, names each part. An absent
 *  or empty last part is left out, so a command run with no arguments and
 *  one run with empty arguments have one key. A control reads its working
 *  state by the same key it acts under. */
export function actionKey(action: ActionName, ...target: readonly (string | undefined)[]): string {
  const parts = target.map((part) => part ?? "")
  while (parts.at(-1) === "") parts.pop()
  return `${action}:${parts.join(":")}`
}

/** Agent controls join by the addressed set. Missing or empty targets keep the whole-session key. */
export function controlActionKey(action: "interrupt" | "resume" | "restart", sessionId: string, targets?: readonly string[]): string {
  return actionKey(action, sessionId, targets?.length ? JSON.stringify([...new Set(targets)].toSorted()) : undefined)
}
