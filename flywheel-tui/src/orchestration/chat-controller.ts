/**
 * Chat Controller — pure business logic for chat session lifecycle.
 *
 * Extracted from `src/tui/hooks/use-chat-mode.ts`. Controllers return DATA,
 * not signal writes. The TUI hook calls controller methods and writes
 * the returned data to SolidJS signals.
 *
 * Must NOT import from `src/tui/`.
 */

import { createChatRunner } from "./chat-runner.js"
import { createOutputPersistence } from "./session/output-persistence.js"
import { TERMINAL_TITLE_PREFIX, formatElapsed, formatCost, formatTokens } from "../infra/format.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import type { ChatStoreHandle, SessionRegistry } from "./session-registry.js"
import type { SessionManager } from "./session/manager.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { RunnerDoneResult, RunnerErrorResult } from "./session/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatControllerDeps {
  registry: SessionRegistry
  manager: SessionManager
  refreshList: () => void
  projectCwd: string
  /** Returns a monotonic timestamp for elapsed-time computation. */
  workStartTime: () => number
  /** Called when a runner completes normally. */
  onRunnerDone?: (id: string, result: RunnerDoneResult) => void
  /** Called when a runner encounters an error. */
  onRunnerError?: (id: string, result: RunnerErrorResult) => void
}

export interface StartChatResult {
  sessionId: string
  terminalTitle: string
}

export interface ResumeChatResult {
  sessionId: string
  priorBlocks: AnyBlock[]
  terminalTitle: string
}

export type { RunnerDoneResult, RunnerErrorResult }

export interface ChatController {
  /**
   * Create and launch a new chat session.
   * Returns the session ID on success, or null on failure.
   */
  startChat(initialMessage?: string): Promise<StartChatResult | null>

  /**
   * Resume a persisted chat session, loading its output blocks.
   * Returns the session ID and prior blocks, or null on failure.
   */
  resumeChat(sessionId: string): Promise<ResumeChatResult | null>

  /** End the foreground chat. Returns true if a chat was ended. */
  endChat(foregroundId: string | undefined): boolean

  /** Put the current chat in the background. */
  backgroundChat(): void

  /** Interrupt the foreground chat. */
  interruptChat(foregroundId: string | undefined): void

  /**
   * Send a message to the foreground chat.
   * Returns true if the message was sent or queued; false if dropped.
   */
  sendMessage(foregroundId: string | undefined, text: string): boolean
}

// ---------------------------------------------------------------------------
// Startup state machine
// ---------------------------------------------------------------------------

type StartupState =
  | { phase: "idle" }
  | { phase: "starting"; id: string; pending: string[] }
  | { phase: "ready" }

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatController(deps: ChatControllerDeps): ChatController {
  const { registry, manager, refreshList, projectCwd } = deps

  let startup: StartupState = { phase: "idle" }
  let isFirstChat = true

  /**
   * Internal helper: wire up a chat session with the registry.
   * Returns the session ID on success, null on failure.
   */
  async function launchChat(
    sessionId: string,
    opts?: { initialMessage?: string; priorBlocks?: AnyBlock[] },
  ): Promise<{ sessionId: string; terminalTitle: string } | null> {
    startup = { phase: "starting", id: sessionId, pending: [] }

    const terminalTitle = opts?.priorBlocks
      ? `${TERMINAL_TITLE_PREFIX}chat (resumed)`
      : `${TERMINAL_TITLE_PREFIX}chat`

    try {
      await registry.startChat({
        sessionId,
        description: "Chat",
        priorBlocks: opts?.priorBlocks,
        onRunnerDone: (id) => {
          const totalElapsed = formatElapsed(Date.now() - deps.workStartTime())
          const entry = registry.get(id)
          const tokens = entry?.tokens ?? 0
          const cost = entry?.cost ?? 0
          manager.updateState(id, "paused")
          const doneResult = {
            statusMessage: `Chat ended \u00b7 ${totalElapsed} \u00b7 ${formatCost(cost)} \u00b7 ${formatTokens(tokens)} tokens`,
            terminalTitle: `${TERMINAL_TITLE_PREFIX}done`,
          } satisfies RunnerDoneResult
          refreshList()
          deps.onRunnerDone?.(id, doneResult)
        },
        onRunnerError: (id, err) => {
          manager.updateState(id, "paused")
          const errorResult = {
            errorMessage: extractErrorMessage(err),
            terminalTitle: `${TERMINAL_TITLE_PREFIX}error`,
          } satisfies RunnerErrorResult
          refreshList()
          deps.onRunnerError?.(id, errorResult)
        },
        createRunner: (storeHandle: ChatStoreHandle) =>
          createChatRunner({
            sessionId,
            projectCwd,
            updateState: (id, state) => manager.updateState(id, state),
            updateEntry: storeHandle.updateEntry,
            onSessionName: (name) => {
              manager.updateLabel(sessionId, name)
              refreshList()
            },
            onError: storeHandle.onError,
            onEnded: storeHandle.onEnded,
            initialMessage: opts?.initialMessage?.trim() || undefined,
            priorBlocks: opts?.priorBlocks,
            showWelcome: isFirstChat && !opts?.priorBlocks,
          }),
      })

      // Replay any messages that arrived during async startup
      const pendingMessages = startup.phase === "starting" ? startup.pending : []
      startup = { phase: "ready" }
      isFirstChat = false

      for (const msg of pendingMessages) {
        registry.injectMessage(sessionId, msg)
      }

      return { sessionId, terminalTitle }
    } catch (_err) {
      startup = { phase: "idle" }
      return null
    }
  }

  async function startChat(initialMessage?: string): Promise<StartChatResult | null> {
    const sessionId = manager.create("chat", "Chat", "chat", "active")
    refreshList()
    const result = await launchChat(sessionId, { initialMessage })
    if (!result) return null
    return { sessionId: result.sessionId, terminalTitle: result.terminalTitle }
  }

  async function resumeChat(sessionId: string): Promise<ResumeChatResult | null> {
    const persistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
    const priorBlocks: AnyBlock[] = await persistence.load()
    const result = await launchChat(sessionId, {
      priorBlocks: priorBlocks.length > 0 ? priorBlocks : undefined,
    })
    if (!result) return null
    return { sessionId: result.sessionId, priorBlocks, terminalTitle: result.terminalTitle }
  }

  function backgroundChat(): void {
    startup = { phase: "idle" }
  }

  function endChat(foregroundId: string | undefined): boolean {
    if (!foregroundId) return false
    const entry = registry.get(foregroundId)
    if (!entry || entry.kind !== "chat") return false

    // If ending the chat we're currently starting, reset startup state
    if (startup.phase === "starting" && startup.id === foregroundId) {
      startup = { phase: "idle" }
    }

    // Update manager BEFORE removing from registry — avoids a reactive glitch
    // where sessionState() briefly sees the old manager state ("paused") after
    // the registry entry disappears but before the manager is updated.
    manager.updateState(foregroundId, "paused")
    registry.remove(foregroundId)
    refreshList()
    return true
  }

  function interruptChat(foregroundId: string | undefined): void {
    if (!foregroundId) return
    registry.abort(foregroundId)
  }

  function sendMessage(foregroundId: string | undefined, text: string): boolean {
    // During async startup, buffer messages
    if (startup.phase === "starting") {
      startup.pending.push(text)
      return true
    }
    // Send to whatever chat is in the foreground
    if (!foregroundId) return false
    return registry.injectMessage(foregroundId, text)
  }

  return {
    startChat,
    resumeChat,
    endChat,
    backgroundChat,
    interruptChat,
    sendMessage,
  }
}
