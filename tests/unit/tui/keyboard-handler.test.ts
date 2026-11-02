import { describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import { isInterruptible } from "../../../src/protocol/client/session-controls.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { createKeyboardHandler } from "../../../src/tui/hooks/create-keyboard-handler.js"
import { createKeymap } from "../../../src/tui/keymap/keymap.js"
import { createOverlayLayers } from "../../../src/tui/components/modal-stack.js"
import { createQuestionInputRegistry } from "../../../src/tui/components/question-input.js"
import { createForegroundSwitcher } from "../../../src/tui/hooks/create-foreground-switcher.js"
import type { ForegroundTarget } from "../../../src/tui/hooks/shell-state.js"
import type { TabInfo } from "../../../src/tui/hooks/create-tabs.js"

type KeyboardDeps = Parameters<typeof createKeyboardHandler>[0]

function tab(id: string, isForeground: boolean, kind: TabInfo["kind"] = "session"): TabInfo {
  return { kind, id, title: id, isForeground, isBusy: false, isBlocked: false }
}

type KeyboardDepsOverrides = Omit<Partial<KeyboardDeps>, "signals" | "chat" | "sessionModal" | "sessionControls"> & {
  signals?: Partial<KeyboardDeps["signals"]>
  chat?: Partial<KeyboardDeps["chat"]>
  sessionModal?: Partial<KeyboardDeps["sessionModal"]>
  sessionControls?: Partial<KeyboardDeps["sessionControls"]>
}


function createDeps(overrides: KeyboardDepsOverrides = {}): KeyboardDeps {
  const signals: KeyboardDeps["signals"] = {
    interruptible: () => false,
    pendingQuestion: () => undefined,
  }
  const chat: KeyboardDeps["chat"] = {
    interruptChat: mock(() => {}),
  }
  const sessionModal: KeyboardDeps["sessionModal"] = {
    openSessionsModal: mock(() => {}),
  }
  const sessionControls: KeyboardDeps["sessionControls"] = {
    offered: () => ({ primary: null, stop: false }),
    resume: mock(() => {}),
  }

  return {
    keymap: overrides.keymap ?? createKeymap().keymap,
    signals: { ...signals, ...overrides.signals },
    showToast: overrides.showToast ?? mock(() => {}),
    exit: overrides.exit ?? mock(() => {}),
    tabs: overrides.tabs ?? (() => []),
    startNewChat: overrides.startNewChat ?? mock(async () => {}),
    chat: { ...chat, ...overrides.chat },
    sessionModal: { ...sessionModal, ...overrides.sessionModal },
    sessionControls: { ...sessionControls, ...overrides.sessionControls },
    overlay: overrides.overlay ?? createOverlayLayers(),
    questionInput: overrides.questionInput ?? createQuestionInputRegistry(),
    promptPopup: overrides.promptPopup ?? { input: () => false },
    openCommandPalette: overrides.openCommandPalette ?? mock(() => {}),
    switchForeground: overrides.switchForeground ?? mock(() => {}),
    dispatchOutputCommand: overrides.dispatchOutputCommand ?? mock(() => {}),
    closeTab: overrides.closeTab ?? mock(() => {}),
  }
}

describe("createKeyboardHandler", () => {
  it("cycles, indexes, and closes mixed local targets without using pending keys as durable IDs", () => {
    createRoot((dispose) => {
      let target: ForegroundTarget = { kind: "session", sessionId: "durable" }
      // A getter keeps the declared union: the switcher reassigns target inside callbacks that control flow does not see.
      const foreground = (): ForegroundTarget => target
      const durableSelections: string[] = []
      const tabs = () => [tab("durable", target.kind === "session"), tab("local", target.kind === "pending", "pending")]
      const switchForeground = createForegroundSwitcher({
        tabs, sessions: () => [],
        signals: {
          setForegroundTarget: (value) => { if (value) target = value },
          setForegroundId: (id) => { if (id) { durableSelections.push(id); target = { kind: "session", sessionId: id } } },
        },
      })
      const closeTab = mock(() => {})
      const { handleKey, promptBarActions } = createKeyboardHandler(createDeps({ tabs, switchForeground, closeTab }))
      handleKey({ name: "tab" })
      expect(foreground()).toEqual({ kind: "pending", key: "local" })
      promptBarActions.closeTab()
      expect(closeTab).toHaveBeenCalledWith("local")
      handleKey({ name: "tab", shift: true })
      expect(foreground()).toEqual({ kind: "session", sessionId: "durable" })
      handleKey({ name: "2", ctrl: true })
      expect(foreground()).toEqual({ kind: "pending", key: "local" })
      expect(durableSelections).toEqual(["durable"])
      dispose()
    })
  })

  it("treats double Escape as repeated chat interrupt, not exit", () => {
    const interruptChat = mock(() => {})
    const showToast = mock(() => {})
    const deps = createDeps({
      signals: {
        interruptible: () => true,
      },
      chat: {
        interruptChat,
      },
      showToast,
    })

    const { handleKey } = createKeyboardHandler(deps)

    handleKey({ name: "escape" })
    handleKey({ name: "escape" })

    expect(interruptChat).toHaveBeenCalledTimes(2)
    expect(showToast).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()
  })


  it("does not interrupt on Escape when the foreground session is idle (no running turn)", () => {
    const interruptChat = mock(() => {})
    const deps = createDeps({
      chat: { interruptChat },
    })

    createKeyboardHandler(deps).handleKey({ name: "escape" })

    expect(interruptChat).not.toHaveBeenCalled()
  })

  it("does nothing on Escape for an inactive chat: the tab keeps its runner, so there is nothing to leave", () => {
    const deps = createDeps({ tabs: () => [tab("chat-1", true), tab("chat-2", false)] })

    createKeyboardHandler(deps).handleKey({ name: "escape" })

    expect(deps.chat.interruptChat).not.toHaveBeenCalled()
    expect(deps.switchForeground).not.toHaveBeenCalled()
    expect(deps.closeTab).not.toHaveBeenCalled()
    expect(deps.showToast).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()
  })

  it("interrupts on Escape while the turn waits on background work, and not once the interrupt has settled it", () => {
    const interruptChat = mock(() => {})
    const [status, setStatus] = createSignal<Pick<StatusView, "activity" | "waitingOnBackgroundWork">>({ activity: "idle", waitingOnBackgroundWork: true })
    const deps = createDeps({
      signals: {
        interruptible: () => isInterruptible(status()),
      },
      chat: { interruptChat },
    })
    const { handleKey, activeEscapeMode } = createKeyboardHandler(deps)

    expect(activeEscapeMode()).toBe("interrupt")
    handleKey({ name: "escape" })
    expect(interruptChat).toHaveBeenCalledTimes(1)

    // The interrupted park waits for the person; the subagent still runs,
    // but there is nothing left to interrupt.
    setStatus({ activity: "idle", waitingOnBackgroundWork: false })
    expect(activeEscapeMode()).toBeNull()
    handleKey({ name: "escape" })
    expect(interruptChat).toHaveBeenCalledTimes(1)
  })

  it("ignores Escape when no mode handles it", () => {
    const showToast = mock(() => {})
    const deps = createDeps({ showToast })

    const { handleKey } = createKeyboardHandler(deps)
    handleKey({ name: "escape" })
    handleKey({ name: "escape" })

    expect(showToast).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()
  })

  it("opens the sessions modal with Ctrl+S", () => {
    const openSessionsModal = mock(() => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({
      sessionModal: {
        openSessionsModal,
      },
    })

    createKeyboardHandler(deps).handleKey({ name: "s", ctrl: true, preventDefault })

    expect(openSessionsModal).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("starts a fresh chat with Ctrl+N", () => {
    const startNewChat = mock(async () => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({ startNewChat })

    createKeyboardHandler(deps).handleKey({ name: "n", ctrl: true, preventDefault })

    expect(startNewChat).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("closes the foreground tab with Ctrl+W, preventing the textarea's delete-word default", () => {
    const closeTab = mock(() => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({
      tabs: () => [tab("chat-1", true)],
      closeTab,
    })

    createKeyboardHandler(deps).handleKey({ name: "w", ctrl: true, preventDefault })

    expect(closeTab).toHaveBeenCalledWith("chat-1")
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("exits with Ctrl+C and prevents the focused input default", () => {
    const preventDefault = mock(() => {})
    const exit = mock(() => {})

    createKeyboardHandler(createDeps({ exit })).handleKey({ name: "c", ctrl: true, preventDefault })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it("routes output window shortcuts through the shell-level keyboard path", () => {
    const dispatchOutputCommand = mock(() => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({ dispatchOutputCommand })
    const { handleKey } = createKeyboardHandler(deps)

    handleKey({ name: "pageup", preventDefault })
    handleKey({ name: "pagedown", preventDefault })

    expect(dispatchOutputCommand).toHaveBeenNthCalledWith(1, "page-up")
    expect(dispatchOutputCommand).toHaveBeenNthCalledWith(2, "page-down")
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it("routes Ctrl+PageUp/PageDown to half-page scrolling", () => {
    const dispatchOutputCommand = mock(() => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({ dispatchOutputCommand })
    const { handleKey } = createKeyboardHandler(deps)

    handleKey({ name: "pageup", ctrl: true, preventDefault })
    handleKey({ name: "pagedown", ctrl: true, preventDefault })

    expect(dispatchOutputCommand).toHaveBeenNthCalledWith(1, "half-page-up")
    expect(dispatchOutputCommand).toHaveBeenNthCalledWith(2, "half-page-down")
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it("does not route meta-modified page keys to output scrolling", () => {
    const dispatchOutputCommand = mock(() => {})
    const deps = createDeps({ dispatchOutputCommand })
    const { handleKey } = createKeyboardHandler(deps)

    handleKey({ name: "pageup", meta: true })
    handleKey({ name: "pagedown", meta: true })

    expect(dispatchOutputCommand).not.toHaveBeenCalled()
  })

  it("exposes prompt controls through the same keymap actions", () => {
    let currentId = "chat-1"
    const startNewChat = mock(async () => {})
    const closeTab = mock(() => {})
    const openSessionsModal = mock(() => {})
    const switchForeground = mock((sessionId: string) => { currentId = sessionId })
    const tabs = () => [
      tab("chat-1", currentId === "chat-1"),
      tab("chat-2", currentId === "chat-2"),
    ] satisfies ReturnType<KeyboardDeps["tabs"]>
    const { promptBarActions } = createKeyboardHandler(createDeps({
      startNewChat,
      closeTab,
      switchForeground,
      tabs,
      sessionModal: { openSessionsModal },
    }))

    promptBarActions.newChat()
    promptBarActions.closeTab()
    promptBarActions.nextTab()
    promptBarActions.sessions()

    expect(startNewChat).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledWith("chat-1")
    expect(switchForeground).toHaveBeenCalledWith("chat-2")
    expect(openSessionsModal).toHaveBeenCalledTimes(1)
  })

  it("activates a tab by index with Ctrl+1..9", () => {
    const switchForeground = mock(() => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({
      tabs: () => [
        tab("chat-1", true),
        tab("chat-2", false),
      ],
      switchForeground,
    })

    createKeyboardHandler(deps).handleKey({ name: "2", ctrl: true, preventDefault })

    expect(switchForeground).toHaveBeenCalledWith("chat-2")
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("consults user keybinding overrides: remapped chord fires, old chord is inert", () => {
    const openCommandPalette = mock(() => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({
      keymap: createKeymap({ help: "ctrl+g" }).keymap,
      openCommandPalette,
    })

    const { handleKey } = createKeyboardHandler(deps)
    handleKey({ name: "g", ctrl: true, preventDefault })
    handleKey({ name: "p", ctrl: true, preventDefault })

    expect(openCommandPalette).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("resumes the foreground session with Ctrl+R while its resume hint shows", () => {
    const resume = mock(() => {})
    const preventDefault = mock(() => {})
    const deps = createDeps({ sessionControls: { offered: () => ({ primary: "resume", stop: false }), resume } })

    createKeyboardHandler(deps).handleKey({ name: "r", ctrl: true, preventDefault })

    expect(resume).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it("leaves Ctrl+R to the textarea while the session offers no Resume or a question is pending", () => {
    for (const overrides of [
      { sessionControls: { offered: () => ({ primary: "interrupt" as const, stop: false }) } },
      { sessionControls: { offered: () => ({ primary: null, stop: false }) } },
      { sessionControls: { offered: () => ({ primary: "resume" as const, stop: false }) }, signals: { pendingQuestion: () => ({ kind: "question" as const, toolUseId: "q-1", questions: [], timestamp: 1 }) } },
    ]) {
      const resume = mock(() => {})
      const preventDefault = mock(() => {})
      const deps = createDeps({ ...overrides, sessionControls: { ...overrides.sessionControls, resume } })

      createKeyboardHandler(deps).handleKey({ name: "r", ctrl: true, preventDefault })

      expect(resume).not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
    }
  })

  it("gives Ctrl+R to an open modal before the resume binding, so the model modal keeps its reset", () => {
    createRoot((dispose) => {
      const overlay = createOverlayLayers()
      const handleModalKey = mock(() => {})
      overlay.dialog.replace("model-modal", { onKey: handleModalKey })
      const resume = mock(() => {})
      const deps = createDeps({ overlay, sessionControls: { offered: () => ({ primary: "resume", stop: false }), resume } })

      createKeyboardHandler(deps).handleKey({ name: "r", ctrl: true })

      expect(handleModalKey).toHaveBeenCalledTimes(1)
      expect(resume).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("leaves keyboard ownership with the question dock while a question is pending", () => {
    const interruptChat = mock(() => {})
    const startNewChat = mock(async () => {})
    const openSessionsModal = mock(() => {})
    const switchForeground = mock(() => {})
    // Mirrors QuestionDock's registration (question-dock.tsx) instead of the
    // old pendingQuestion() short-circuit: the form's own handler now owns
    // the keystroke, exactly like a modal stack entry would.
    const handleQuestionKey = mock(() => true)
    const questionInput = createQuestionInputRegistry()
    questionInput.register({ onKey: handleQuestionKey, onPaste: () => {} })
    const deps = createDeps({
      tabs: () => [
        tab("chat-1", true),
        tab("chat-2", false),
      ],
      chat: {
        interruptChat,
      },
      startNewChat,
      sessionModal: {
        openSessionsModal,
      },
      switchForeground,
      questionInput,
    })

    const { handleKey } = createKeyboardHandler(deps)

    handleKey({ name: "escape" })
    handleKey({ name: "tab" })
    handleKey({ name: "n", ctrl: true })
    handleKey({ name: "b", ctrl: true })

    expect(handleQuestionKey).toHaveBeenCalledTimes(4)
    expect(interruptChat).not.toHaveBeenCalled()
    expect(switchForeground).not.toHaveBeenCalled()
    expect(startNewChat).not.toHaveBeenCalled()
    expect(openSessionsModal).not.toHaveBeenCalled()
  })

  it("gives a real modal precedence over a pending question underneath it", () => {
    createRoot((dispose) => {
      const overlay = createOverlayLayers()
      const handleModalKey = mock(() => {})
      overlay.dialog.replace("modal-content", { onKey: handleModalKey })
      const handleQuestionKey = mock(() => true)
      const questionInput = createQuestionInputRegistry()
      questionInput.register({ onKey: handleQuestionKey, onPaste: () => {} })
      const deps = createDeps({ overlay, questionInput })

      const { handleKey } = createKeyboardHandler(deps)

      handleKey({ name: "1" })

      expect(handleModalKey).toHaveBeenCalledTimes(1)
      expect(handleQuestionKey).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("routes dialog, viewer, then shell Ctrl+C ownership", () => {
    createRoot((dispose) => {
      const overlay = createOverlayLayers()
      const viewerKey = mock(() => {})
      const dialogKey = mock(() => {})
      const exit = mock(() => {})
      overlay.viewer.push("viewer", { onKey: viewerKey })
      overlay.dialog.push("dialog", { onKey: dialogKey })
      const { handleKey } = createKeyboardHandler(createDeps({ overlay, exit }))

      handleKey({ name: "c", ctrl: true })
      expect(dialogKey).toHaveBeenCalledTimes(1)
      expect(viewerKey).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()

      overlay.dialog.pop()
      handleKey({ name: "c", ctrl: true })
      expect(viewerKey).toHaveBeenCalledTimes(1)
      expect(exit).not.toHaveBeenCalled()

      overlay.viewer.pop()
      handleKey({ name: "c", ctrl: true })
      expect(exit).toHaveBeenCalledTimes(1)
      dispose()
    })
  })
})
