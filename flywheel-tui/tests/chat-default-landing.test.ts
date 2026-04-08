/**
 * Tests for Phase 6: Chat as Default Landing Experience
 *
 * 6.1 — /new closes current session and starts fresh
 * 6.2 — Free text in chat goes to sendMessage(), not command registry
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

// Mock the exit module (no JSX dependencies)
mock.module("../src/tui/exit.js", () => ({
  exitTUI: mock(() => {}),
}))

import { useCommandDispatch } from "../src/tui/hooks/use-command-dispatch.js"
import type { CommandDispatchDeps } from "../src/tui/hooks/use-command-dispatch.js"

function createMockDeps(overrides: Partial<CommandDispatchDeps> = {}): CommandDispatchDeps {
  return {
    agentState: () => "idle",
    sessionState: () => "active",
    setAgentState: mock(() => {}),
    foregroundId: () => "chat-abc",
    inChat: () => true,
    registry: { runningCount: () => 0 } as any,
    startWorkflow: mock(async () => {}),
    startTestStep: mock(async () => {}),
    startChat: mock(async () => {}),
    backgroundChat: mock(() => {}),
    endChat: mock(() => {}),
    sendMessage: mock(() => {}),
    handleResume: mock(async () => {}),
    openSessionsModal: mock(() => {}),
    showToast: mock(() => {}),
    ...overrides,
  }
}

describe("Chat as Default Landing — /new command", () => {
  it("/new closes current chat and starts a fresh one", () => {
    const deps = createMockDeps()
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("/new")

    expect(deps.backgroundChat).toHaveBeenCalledTimes(1)
    expect(deps.endChat).not.toHaveBeenCalled()
    expect(deps.startChat).toHaveBeenCalledTimes(1)
  })

  it("/end and /stop are not special commands in chat (go through registry)", async () => {
    const deps = createMockDeps()
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("/end")

    // /end is no longer a special chat command — goes through command registry
    expect(deps.endChat).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
  })

  it("/exit still exits the TUI from chat", () => {
    // We can't easily test exitTUI since it's imported directly,
    // but we can verify endChat is called before exit
    const deps = createMockDeps()
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("/exit")

    expect(deps.endChat).toHaveBeenCalledTimes(1)
  })

  it("/quit also exits the TUI from chat", () => {
    const deps = createMockDeps()
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("/quit")

    expect(deps.endChat).toHaveBeenCalledTimes(1)
  })
})

describe("Chat as Default Landing — free text routing", () => {
  it("free text in chat goes to sendMessage, not command registry", () => {
    const deps = createMockDeps()
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("tell me about this codebase")

    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledWith("tell me about this codebase")
    expect(deps.startWorkflow).not.toHaveBeenCalled()
  })

  it("unknown slash commands in chat go to command registry (not sendMessage), show toast", async () => {
    const deps = createMockDeps()
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("/something random")

    // Slash commands are dispatched through the registry, not sent as chat messages
    expect(deps.sendMessage).not.toHaveBeenCalled()
    // The toast fires async after the registry dispatch resolves
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.showToast).toHaveBeenCalledTimes(1)
  })

  it("empty text is ignored", () => {
    const deps = createMockDeps()
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("")
    handlePromptSubmit("   ")

    expect(deps.sendMessage).not.toHaveBeenCalled()
  })
})

describe("Chat as Default Landing — unknown command toast", () => {
  it("unknown commands outside chat show updated toast text (no /chat reference)", async () => {
    const deps = createMockDeps({
      inChat: () => false,
      sessionState: () => null,
    })
    const { handlePromptSubmit } = useCommandDispatch(deps)

    handlePromptSubmit("/bogus")

    // Give the async dispatch a tick to resolve
    await new Promise((r) => setTimeout(r, 10))

    expect(deps.showToast).toHaveBeenCalledTimes(1)
    const call = (deps.showToast as any).mock.calls[0]
    const message: string = call[0].message
    expect(message).not.toContain("/chat")
    expect(message).toContain("/new")
  })
})
