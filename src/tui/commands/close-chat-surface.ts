import { chatOnlyCommandNotice, type AgentViewKind } from "../../protocol/client/slash-route.js"
import type { ShellServices } from "../hooks/shell-state.js"
import type { ChatInView } from "../hooks/transcript-in-view.js"

/** The terminal's `close-chat` surface: Close chat on the chat in view, which
 *  ends its work now and removes its tab (PI-INTERACTION-082, PI-INTERACTION-119).
 *  A chat that a view over the chat in front shows closes as from its own tab,
 *  through that view. In an agent's view, the person does not see the chat
 *  that would close, so the surface refuses there and closes nothing. */
export function closeChatSurface(deps: {
  readonly agentInView: () => Exclude<AgentViewKind, "chat"> | undefined
  readonly chatInView: () => Pick<ChatInView, "closeChat"> | undefined
  /** The chat in front, or undefined when the foreground is no chat. */
  readonly chatInFront: () => string | undefined
  readonly closeChat: (sessionId: string) => Promise<void>
  readonly showToast: ShellServices["showToast"]
}): () => Promise<void> {
  return async () => {
    const agent = deps.agentInView()
    if (agent !== undefined) { deps.showToast({ message: chatOnlyCommandNotice("close", agent), variant: "warning" }); return }
    const shown = deps.chatInView()
    if (shown) { shown.closeChat(); return }
    const sessionId = deps.chatInFront()
    if (sessionId === undefined) { deps.showToast({ message: "No active chat session", variant: "warning" }); return }
    await deps.closeChat(sessionId)
  }
}
