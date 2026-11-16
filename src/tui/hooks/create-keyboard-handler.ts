import type { Accessor } from "solid-js"
import type { TabInfo } from "./create-tabs.js"
import type { Keymap } from "../keymap/keymap.js"
import type { OutputWindowCommandType } from "../output-window/output-window.js"
import type { OverlayLayers } from "../components/modal-stack.js"
import { shouldShowGlobalHints } from "../components/key-hint-row-state.js"
import type { QuestionInputContext } from "../components/question-input.js"
import type { ComposerPopupKeySlot } from "./create-composer-popup-key-slot.js"
import type { ModuleSlots } from "./create-module-slots.js"
import { createAsyncReporter } from "./report-async.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import type { ChatModeHook } from "./use-chat-mode.js"
import type { SessionControlsHook } from "./use-session-controls.js"
import type { SessionModalHook } from "./use-session-modal-types.js"

type KeyboardEventLike = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string; raw?: string; preventDefault?: () => void }

/** What the keymap acts on in a chat pane: its transcript's paging and its session's Resume. */
export interface KeymapPane {
  /** True while the pane's question shows; its dock then owns the keys, and Resume names no hint. */
  readonly pendingQuestion: Accessor<boolean>
  readonly sessionControls: Pick<SessionControlsHook, "offered" | "resume">
  output(command: OutputWindowCommandType): void
}

type BindingAction = (evt: KeyboardEventLike, pane: KeymapPane) => void

interface BindingActions {
  help: BindingAction
  new: BindingAction
  sessions: BindingAction
  "tab.close": BindingAction
  resume: BindingAction
  "tab.next": BindingAction
  "tab.previous": BindingAction
  "tab.1": BindingAction
  "tab.2": BindingAction
  "tab.3": BindingAction
  "tab.4": BindingAction
  "tab.5": BindingAction
  "tab.6": BindingAction
  "tab.7": BindingAction
  "tab.8": BindingAction
  "tab.9": BindingAction
  "output.page-up": BindingAction
  "output.page-down": BindingAction
  "output.half-page-up": BindingAction
  "output.half-page-down": BindingAction
  "output.top": BindingAction
  "output.bottom": BindingAction
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
  strips: Pick<ModuleSlots, "stripInput">
  openCommandPalette: () => void
  switchForeground: (tabKey: string) => void
  dispatchOutputCommand: (command: OutputWindowCommandType) => void
  closeTab: (tabKey: string) => void
}

/** ESC ownership below the pre-handler key consumers, in priority order. */
export type EscapeModeId = "interrupt"

interface PromptBarActions {
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

  function outputCommand(command: OutputWindowCommandType): BindingAction {
    return (evt, pane) => {
      evt.preventDefault?.()
      pane.output(command)
    }
  }

  function tabActivation(index: number): BindingAction {
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
    resume: (evt, pane) => {
      const hintShown = pane.sessionControls.offered().primary === "resume"
        && shouldShowGlobalHints({ hasPendingQuestion: pane.pendingQuestion() })
      if (!hintShown) return
      evt.preventDefault?.()
      pane.sessionControls.resume()
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

  // The pane of the tab in front.
  const tabPane: KeymapPane = {
    pendingQuestion: () => signals.pendingQuestion() !== undefined,
    sessionControls: deps.sessionControls,
    output: deps.dispatchOutputCommand,
  }

  /** Exits on ctrl+c; true when it did. */
  function exitKey(evt: KeyboardEventLike): boolean {
    if (!(evt.ctrl && evt.name === "c")) return false
    evt.preventDefault?.()
    deps.exit()
    return true
  }

  const handleKey = function handleKey(evt: KeyboardEventLike): void {
    if (overlay.input(evt)) return
    if (exitKey(evt)) return
    if (deps.questionInput.input(evt)) return
    // The prompt's popups (slash suggestions, history) claim escape (dismiss,
    // not interrupt), plain tab (complete, not session-cycle), and their
    // navigation keys while open; the popups act on them in the prompt
    // textarea's own key handler.
    if (deps.promptPopup.input(evt)) return
    // Only the consumers below see the normalized event; those above keep
    // the raw one they have always received.
    const normalized = normalizeTerminalQuirks(evt)
    // Escape is interrupt/mode semantics owned by the escape-mode stack,
    // not a remappable app command.
    const commandId = evt.name === "escape" ? null : deps.keymap.resolve(normalized)
    if (commandId) { bindingActions[commandId](normalized, tabPane); return }
    // A keymap binding wins over a chord a module strip declares.
    if (deps.strips.stripInput(normalized)) return
    if (evt.name === "escape") handleEscape()
  }

  /** A key for a chat pane that a view over the tab in front shows, such as
   *  the lead's chat view, after the view's own keys and the pane's question
   *  and popups had it: the keymap acts on that pane as on the tab's pane,
   *  except the tab commands, which act on the tab bar and do nothing here.
   *  A key that no binding takes reaches the pane's focused composer. */
  function paneKey(evt: KeyboardEventLike, pane: KeymapPane): void {
    if (exitKey(evt)) return
    const normalized = normalizeTerminalQuirks(evt)
    const commandId = evt.name === "escape" ? null : deps.keymap.resolve(normalized)
    if (!commandId) return
    if (TAB_COMMANDS.has(commandId)) { evt.preventDefault?.(); return }
    bindingActions[commandId](normalized, pane)
  }

  return { handleKey, paneKey, activeEscapeMode, promptBarActions }
}

/** The commands that act on the tab bar. */
const TAB_COMMANDS: ReadonlySet<keyof BindingActions> = new Set(["new", "tab.close", "tab.next", "tab.previous", "tab.1", "tab.2", "tab.3", "tab.4", "tab.5", "tab.6", "tab.7", "tab.8", "tab.9"])
