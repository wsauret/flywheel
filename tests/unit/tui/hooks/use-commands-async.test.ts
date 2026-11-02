import { describe, expect, it, mock } from "bun:test"
import type { ChatInput, ChatInputLike } from "../../../../src/infra/chat-input.js"
import type { CommandDispatch } from "../../../../src/tui/commands/command-dispatch.js"
import { useCommands } from "../../../../src/tui/hooks/use-commands.js"

interface HarnessOptions {
  readonly slashHandled?: () => Promise<boolean>
  readonly pendingForeground?: boolean
}

interface HarnessState {
  foregroundId: string | undefined
  foregroundRevision: number
  sessionState: "active" | "inactive" | null
}

function harness(options: HarnessOptions = {}) {
  const state: HarnessState = {
    foregroundId: "chat-1",
    foregroundRevision: 0,
    sessionState: "active",
  }
  const toasts: Array<{ message: string; variant: string }> = []
  const messages: ChatInput[] = []
  const startChat = mock(async (_input?: ChatInputLike) => ({ kind: "foregrounded" as const, sessionId: "created" }))

  const signals = {
    foregroundId: () => state.foregroundId,
    foregroundTarget: () => options.pendingForeground
      ? { kind: "pending" as const, key: "pending:test" }
      : state.foregroundId === undefined ? undefined : { kind: "session" as const, sessionId: state.foregroundId },
    foregroundRevision: () => state.foregroundRevision,
    sessionCatalogRows: () => [],
    setForegroundId: (id: string | undefined) => {
      state.foregroundId = id
      state.foregroundRevision += 1
    },
    sessionInputMode: () => (state.foregroundId === undefined ? null : { kind: "chat" as const }),
    sessionState: () => state.sessionState,
  }

  const showToast = (toast: { message: string; variant: string }) => { toasts.push(toast) }
  const dispatch: CommandDispatch = {
    completableNames: () => [],
    dispatchableNames: () => [],
    dispatch: options.slashHandled ?? (async () => false),
  }

  const commands = useCommands({
    signals,
    dispatch,
    showToast,
    sendMessage: async (_sessionId, input) => { messages.push(input) },
    startChat,
    openSettingsDestination: async () => {},
    providerSetup: () => "usable" as const,
    openSubscriptionSpendReview: () => false,
  })

  return { commands, state, toasts, messages, startChat }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe("asynchronous command settlement", () => {
  it.each([undefined, "chat-1"])("a slash command hands its text back when its dispatch settles as refused, foreground %p", async (foregroundId) => {
    const pending = Promise.withResolvers<boolean>()
    const h = harness({ slashHandled: () => pending.promise })
    h.state.foregroundId = foregroundId

    const submitted = h.commands.handleComposerSubmit("/nope")
    if (typeof submitted === "boolean") throw new Error("Expected a pending settlement")

    pending.resolve(false)
    expect(await submitted.accepted).toBe(false)
  })

  it("plain text without a foreground creates a chat instead of becoming a command", async () => {
    const h = harness()
    h.state.sessionState = null
    h.state.foregroundId = undefined

    expect(h.commands.handleComposerSubmit("some text")).toBe(true)
    await flush()
    expect(h.startChat.mock.calls).toEqual([[{ text: "some text" }]])
    expect(h.toasts).toEqual([])
  })

  it.each([
    { text: "send after opening" },
    { text: "/inspect", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "aW1n" }] },
  ] satisfies ChatInput[])("messages submitted while the foreground chat is opening stay in the prompt", (input) => {
    const h = harness({ pendingForeground: true })

    expect(h.commands.handleComposerSubmit(input)).toBe(false)
    expect(h.toasts).toEqual([{ message: "Chat is still opening; your message stays in the prompt", variant: "warning" }])
    expect(h.startChat).not.toHaveBeenCalled()
  })

  it("submits an attachment-only chat message", async () => {
    const h = harness()
    const input: ChatInput = {
      text: "",
      attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "aW1n" }],
    }

    expect(h.commands.handleComposerSubmit(input)).toBe(true)
    await flush()
    expect(h.messages).toEqual([input])
  })
})
