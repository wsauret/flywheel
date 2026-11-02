import { describe, expect, it, mock } from "bun:test"
import type { AgentViewKind } from "../../../../src/protocol/client/slash-route.js"
import { closeChatSurface } from "../../../../src/tui/commands/close-chat-surface.js"

function surface(view: { agent?: AgentViewKind; chat?: string }) {
  const closeChat = mock(async (_sessionId: string) => {})
  const showToast = mock(() => {})
  const open = closeChatSurface({ agentInView: () => view.agent, chatInFront: () => view.chat, closeChat, showToast })
  return { open, closeChat, showToast }
}

describe("the Close chat surface", () => {
  it("closes the chat in front", async () => {
    const { open, closeChat, showToast } = surface({ chat: "chat-1" })
    await open()
    expect(closeChat).toHaveBeenCalledWith("chat-1")
    expect(showToast).not.toHaveBeenCalled()
  })

  it("is refused in an agent's view and with no chat in front, and closes nothing", async () => {
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
