import { describe, expect, it, mock } from "bun:test"
import type { AgentViewKind } from "../../../../src/protocol/client/slash-route.js"
import { closeChatSurface } from "../../../../src/tui/commands/close-chat-surface.js"

function surface(view: { agent?: Exclude<AgentViewKind, "chat">; shown?: boolean; chat?: string }) {
  const closeChat = mock(async (_sessionId: string) => {})
  const closeShown = mock(() => {})
  const showToast = mock(() => {})
  const open = closeChatSurface({ agentInView: () => view.agent, chatInView: () => view.shown ? { closeChat: closeShown } : undefined, chatInFront: () => view.chat, closeChat, showToast })
  return { open, closeChat, closeShown, showToast }
}

describe("the Close chat surface", () => {
  it("closes the chat in front", async () => {
    const { open, closeChat, showToast } = surface({ chat: "chat-1" })
    await open()
    expect(closeChat).toHaveBeenCalledWith("chat-1")
    expect(showToast).not.toHaveBeenCalled()
  })

  it("closes a chat that a view over the chat in front shows through that view, as from its tab", async () => {
    const { open, closeChat, closeShown, showToast } = surface({ shown: true, chat: "lead" })
    await open()
    expect(closeShown).toHaveBeenCalledTimes(1)
    expect(closeChat).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it("is refused in an agent's view over the chat in front and with no chat in front, and closes nothing", async () => {
    for (const [view, message] of [
      [{ agent: "subagent", chat: "chat-1" }, "/close works in a chat, not in this subagent"],
      [{ agent: "workflow-agent" }, "/close works in a chat, not in this workflow agent"],
      [{}, "No active chat session"],
    ] as const) {
      const { open, closeChat, showToast } = surface(view)
      await open()
      expect(closeChat).not.toHaveBeenCalled()
      expect(showToast).toHaveBeenCalledWith({ message, variant: "warning" })
    }
  })
})
