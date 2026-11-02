import type { Accessor } from "solid-js"
import type { TabInfo } from "./create-tabs.js"
import type { Keymap } from "../keymap/keymap.js"
import type { OutputWindowCommandType } from "../output-window/output-window.js"
import type { OverlayLayers } from "../components/modal-stack.js"
import { shouldShowGlobalHints } from "../components/key-hint-row-state.js"
import type { QuestionInputContext } from "../components/question-input.js"
import type { ComposerPopupKeySlot } from "./create-composer-popup-key-slot.js"
import { createAsyncReporter } from "./report-async.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import type { ChatModeHook } from "./use-chat-mode.js"
import type { SessionControlsHook } from "./use-session-controls.js"
import type { SessionModalHook } from "./use-session-modal-types.js"

type KeyboardEventLike = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string; raw?: string; preventDefault?: () => void }

interface BindingActions {
  help: (evt: KeyboardEventLike) => void
  new: (evt: KeyboardEventLike) => void
  sessions: (evt: KeyboardEventLike) => void
  "tab.close": (evt: KeyboardEventLike) => void
  resume: (evt: KeyboardEventLike) => void
  "tab.next": (evt: KeyboardEventLike) => void
  "tab.previous": (evt: KeyboardEventLike) => void
  "tab.1": (evt: KeyboardEventLike) => void
  "tab.2": (evt: KeyboardEventLike) => void
  "tab.3": (evt: KeyboardEventLike) => void
  "tab.4": (evt: KeyboardEventLike) => void
  "tab.5": (evt: KeyboardEventLike) => void
  "tab.6": (evt: KeyboardEventLike) => void
  "tab.7": (evt: KeyboardEventLike) => void
  "tab.8": (evt: KeyboardEventLike) => void
  "tab.9": (evt: KeyboardEventLike) => void
  "output.page-up": (evt: KeyboardEventLike) => void
  "output.page-down": (evt: KeyboardEventLike) => void
  "output.half-page-up": (evt: KeyboardEventLike) => void
  "output.half-page-down": (evt: KeyboardEventLike) => void
  "output.top": (evt: KeyboardEventLike) => void
  "output.bottom": (evt: KeyboardEventLike) => void
}

interface KeyboardHandlerDeps {
  signals: Pick<ShellSignals, "interruptible" | "pendingQuestion">
  keymap: Keymap
  showToast: ShellServices["showToast"]
  exit: () => void
  tabs: Accessor<readonly TabInfo[]>
  startNewChat: () => Promise<void>
  chat: Pick<ChatModeHook, "interruptChat">
  sessionModal: Pick<SessionModalHook, "openSessionsModal">
  sessionControls: Pick<SessionControlsHook, "offered" | "resume">
  overlay: OverlayLayers
  questionInput: QuestionInputContext
  promptPopup: Pick<ComposerPopupKeySlot, "input">
  openCommandPalette: () => void
  switchForeground: (tabKey: string) => void
  dispatchOutputCommand: (command: OutputWindowCommandType) => void
  closeTab: (tabKey: string) => void
}

/** ESC ownership below the pre-handler key consumers, in priority order. */
export type EscapeModeId = "interrupt"

export interface PromptBarActions {
  newChat: () => void
  closeTab: () => void
  nextTab: () => void
  sessions: () => void
}

export function createKeyboardHandler(deps: KeyboardHandlerDeps) {
  const { signals, chat, sessionModal, overlay } = deps

  const reportAsync = createAsyncReporter(deps.showToast)

  function cycleSession(direction: 1 | -1): void {
    const list = deps.tabs()
    if (list.length === 0) return
    const idx = list.findIndex((t) => t.isForeground)
    if (idx === -1) {
      const first = list[0]
      if (first) deps.switchForeground(first.id)
      return
    }
    if (list.length < 2) return
    const next = list[(idx + direction + list.length) % list.length]
    if (next && !next.isForeground) deps.switchForeground(next.id)
  }

  function activateTabByIndex(index: number): void {
    const list = deps.tabs()
    const target = list[index]
    if (target && !target.isForeground) deps.switchForeground(target.id)
  }

  function closeForegroundTab(): void {
    const fg = deps.tabs().find((t) => t.isForeground)
    if (!fg) return
    deps.closeTab(fg.id)
  }

  const promptBarActions: PromptBarActions = {
    newChat: () => reportAsync(deps.startNewChat),
    closeTab: closeForegroundTab,
    nextTab: () => cycleSession(1),
    sessions: sessionModal.openSessionsModal,
  }

  function handleEscape(): void {
    // Idle Escape remains available to the focused editor.
    if (signals.interruptible()) chat.interruptChat()
  }

  /** The escape mode a press would run now, or null when an earlier key
   *  consumer owns Escape. */
  function activeEscapeMode(): EscapeModeId | null {
    if (overlay.isOpen()) return null
    if (signals.pendingQuestion()) return null
    if (deps.promptPopup.input({ name: "escape" })) return null
    return signals.interruptible() ? "interrupt" : null
  }

  // Terminal transport quirks are normalized into the key-event shape the
  // resolver consumes; they are not bindings themselves.
  function normalizeTerminalQuirks(evt: KeyboardEventLike): KeyboardEventLike {
    // Some terminals encode Ctrl+O as raw ASCII SI (0x0F) without ctrl/name.
    if (evt.sequence === "\u000f" || evt.raw === "\u000f") return { ...evt, name: "o", ctrl: true }
    return evt
  }

  function outputCommand(command: OutputWindowCommandType): (evt: KeyboardEventLike) => void {
    return (evt) => {
      evt.preventDefault?.()
      deps.dispatchOutputCommand(command)
    }
  }

  function tabActivation(index: number): (evt: KeyboardEventLike) => void {
    return (evt) => {
      evt.preventDefault?.()
      activateTabByIndex(index)
    }
  }

  // What each resolved binding does. Adding a binding means adding a row to
  // DEFAULT_BINDINGS plus an entry here; the Record is exhaustive over the
  // binding command ids, so the compiler enforces the pairing.
  //
  // Actions that consume a chord the focused textarea also binds must
  // preventDefault (Ctrl+w previously both closed the tab AND deleted a word
  // from the draft - close is async, so the renderable's default still
  // fired). Tab cycling deliberately does not, matching prior behavior.
  const bindingActions: BindingActions = {
    help: (evt) => { evt.preventDefault?.(); deps.openCommandPalette() },
    new: (evt) => { evt.preventDefault?.(); promptBarActions.newChat() },
    sessions: (evt) => { evt.preventDefault?.(); promptBarActions.sessions() },
    // Browser muscle memory: Ctrl+w closes the tab, deliberately consuming
    // the textarea's "delete word backward" default (see comment above).
    "tab.close": (evt) => { evt.preventDefault?.(); promptBarActions.closeTab() },
    // Ctrl+r acts only while its prompt hint shows, by the same two rules the
    // border layout reads; otherwise the key passes to the focused textarea.
    // An open modal gets the key first (the model modal binds its own Ctrl+r
    // reset), because overlay input routes before the keymap.
    resume: (evt) => {
      const hintShown = deps.sessionControls.offered().primary === "resume"
        && shouldShowGlobalHints({ hasPendingQuestion: signals.pendingQuestion() !== undefined })
      if (!hintShown) return
      evt.preventDefault?.()
      deps.sessionControls.resume()
    },
    "tab.next": promptBarActions.nextTab,
    "tab.previous": () => cycleSession(-1),
    "tab.1": tabActivation(0),
    "tab.2": tabActivation(1),
    "tab.3": tabActivation(2),
    "tab.4": tabActivation(3),
    "tab.5": tabActivation(4),
    "tab.6": tabActivation(5),
    "tab.7": tabActivation(6),
    "tab.8": tabActivation(7),
    "tab.9": tabActivation(8),
    "output.page-up": outputCommand("page-up"),
    "output.page-down": outputCommand("page-down"),
    "output.half-page-up": outputCommand("half-page-up"),
    "output.half-page-down": outputCommand("half-page-down"),
    "output.top": outputCommand("top"),
    "output.bottom": outputCommand("bottom"),
  }

  const handleKey = function handleKey(evt: KeyboardEventLike): void {
    if (overlay.input(evt)) return
    if (evt.ctrl && evt.name === "c") { evt.preventDefault?.(); deps.exit(); return }
    if (deps.questionInput.input(evt)) return
    // The prompt's popups (slash suggestions, history) claim escape (dismiss,
    // not interrupt), plain tab (complete, not session-cycle), and their
    // navigation keys while open; the popups act on them in the prompt
    // textarea's own key handler.
    if (deps.promptPopup.input(evt)) return
    // Escape is interrupt/mode semantics owned by the escape-mode stack above,
    // not a remappable app command.
    if (evt.name === "escape") { handleEscape(); return }
    const normalized = normalizeTerminalQuirks(evt)
    const commandId = deps.keymap.resolve(normalized)
    if (commandId) bindingActions[commandId](normalized)
  }

  return { handleKey, activeEscapeMode, promptBarActions }
}
