import { chatOnlyCommandNotice, type AgentViewKind } from "../../protocol/client/slash-route.js"
import type { ShellServices } from "../hooks/shell-state.js"

/** The terminal's `close-chat` surface: Close chat on the chat in front, which
 *  ends its work now and removes its tab (PI-INTERACTION-082). An agent's
 *  view has no chat in front, so the surface refuses there and closes nothing. */
export function closeChatSurface(deps: {
  readonly agentInView: () => AgentViewKind | undefined
  /** The chat in front, or undefined when the foreground is no chat. */
  readonly chatInFront: () => string | undefined
  readonly closeChat: (sessionId: string) => Promise<void>
  readonly showToast: ShellServices["showToast"]
}): () => Promise<void> {
  return async () => {
    const agent = deps.agentInView()
    if (agent !== undefined) { deps.showToast({ message: chatOnlyCommandNotice("close", agent), variant: "warning" }); return }
    const sessionId = deps.chatInFront()
    if (sessionId === undefined) { deps.showToast({ message: "No active chat session", variant: "warning" }); return }
    await deps.closeChat(sessionId)
  }
}
