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

  /**
   * Register lifecycle callbacks invoked when a runner completes or errors.
   * These fire asynchronously from the registry's background execution.
   */
  onRunnerDone(cb: (id: string, result: RunnerDoneResult) => void): void
  onRunnerError(cb: (id: string, result: RunnerErrorResult) => void): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatController(deps: ChatControllerDeps): ChatController {
  const { registry, manager, refreshList, projectCwd } = deps

  // Internal startup buffering state
  let startingChatId: string | null = null
  let chatReady = false
  let pendingMessages: string[] = []
  let isFirstChat = true

  /**
   * Internal helper: wire up a chat session with the registry.
   * Returns the session ID on success, null on failure.
   */
  async function launchChat(
    sessionId: string,
    opts?: { initialMessage?: string; priorBlocks?: AnyBlock[] },
  ): Promise<{ sessionId: string; terminalTitle: string } | null> {
    startingChatId = sessionId
    chatReady = false
    pendingMessages = []

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
          manager.updateState(id, "completed")
          const doneResult = {
            statusMessage: `Chat ended \u00b7 ${totalElapsed} \u00b7 ${formatCost(cost)} \u00b7 ${formatTokens(tokens)} tokens`,
            terminalTitle: `${TERMINAL_TITLE_PREFIX}done`,
          } satisfies RunnerDoneResult
          refreshList()
          _onRunnerDone?.(id, doneResult)
        },
        onRunnerError: (id, err) => {
          manager.updateState(id, "paused")
          const errorResult = {
            errorMessage: extractErrorMessage(err),
            terminalTitle: `${TERMINAL_TITLE_PREFIX}error`,
          } satisfies RunnerErrorResult
          refreshList()
          _onRunnerError?.(id, errorResult)
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

      chatReady = true
      startingChatId = null
      isFirstChat = false

      // Replay any messages that arrived during async startup
      for (const msg of pendingMessages) {
        registry.injectMessage(sessionId, msg)
      }
      pendingMessages = []

      return { sessionId, terminalTitle }
    } catch (_err) {
      startingChatId = null
      chatReady = false
      pendingMessages = []
      return null
    }
  }

  // Callback hooks — set by the TUI hook to receive async lifecycle events
  let _onRunnerDone: ((id: string, result: RunnerDoneResult) => void) | undefined
  let _onRunnerError: ((id: string, result: RunnerErrorResult) => void) | undefined

  /** Allow the TUI hook to register lifecycle callbacks. */
  function onRunnerDone(cb: (id: string, result: RunnerDoneResult) => void): void {
    _onRunnerDone = cb
  }

  function onRunnerError(cb: (id: string, result: RunnerErrorResult) => void): void {
    _onRunnerError = cb
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
    startingChatId = null
    chatReady = false
    pendingMessages = []
  }

  function endChat(foregroundId: string | undefined): boolean {
    if (!foregroundId) return false
    const entry = registry.get(foregroundId)
    if (!entry || entry.kind !== "chat") return false

    // If ending the chat we're currently starting, clean up startup state
    if (foregroundId === startingChatId) {
      startingChatId = null
      chatReady = false
      pendingMessages = []
    }

    registry.remove(foregroundId)
    manager.updateState(foregroundId, "completed")
    refreshList()
    return true
  }

  function interruptChat(foregroundId: string | undefined): void {
    if (!foregroundId) return
    registry.abort(foregroundId)
  }

  function sendMessage(foregroundId: string | undefined, text: string): boolean {
    // During async startup, buffer messages
    if (startingChatId && !chatReady) {
      pendingMessages.push(text)
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
    onRunnerDone,
    onRunnerError,
  }
}
