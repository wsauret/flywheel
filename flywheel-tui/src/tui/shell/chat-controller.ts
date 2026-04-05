/**
 * Chat Controller — manages chat session lifecycle
 *
 * Extracted from FlywheelShell using the same dependency-injection pattern
 * as prompt-handler.ts and keyboard-controller.ts.
 *
 * Responsibilities:
 *   - Creating and destroying ChatSession instances
 *   - Lazy-starting: creates the session on boot but NO API call until the
 *     user actually types a message (InteractiveWorker supports this)
 *   - Transitioning from chatting to working: awaits destroyChatSession()
 *     with a timeout before starting the workflow
 *   - Restarting chat after workflow completion, /new, or Esc from completed
 *   - Capturing conversation context via getConversationSummary()
 *
 * Exports:
 *   - createChatController(deps) — factory returning the controller interface
 */

import {
  createChatSession,
  destroyChatSession,
  type ChatSession,
  type ChatAgentHandle,
} from "../session/chat-session.js"
import { createInteractiveWorker, type InteractiveWorkerHandle } from "../../harness/index.js"
import { Log } from "../../utils/log.js"

import type { UIActions } from "../routes/work/context/ui-state/types.js"
import type { WorkState } from "../types.js"
import type { AppState } from "./shell-modes.js"

const log = Log.create({ service: "chat-controller" })

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max time to wait for chat session teardown before proceeding with workflow. */
const DESTROY_TIMEOUT_MS = 3000

// ---------------------------------------------------------------------------
// Toast duck type (avoids importing the context provider)
// ---------------------------------------------------------------------------

export interface ToastLike {
  show(options: { message: string; variant: string; duration?: number }): void
}

// ---------------------------------------------------------------------------
// ChatControllerDeps — dependency bundle
// ---------------------------------------------------------------------------

export interface ChatControllerDeps {
  // State setters
  setAppState: (state: AppState) => void
  setActiveStore: (store: UIActions | null) => void
  setWorkState: (state: WorkState | null) => void

  // Store subscription
  subscribeToStore: (store: UIActions) => void
  unsubscribeStore: () => void

  // Model activity callback
  setModelActivity: (activity: import("../adapters/structured-output-builder.js").ModelActivity) => void

  toast: ToastLike

  // Working directory for tool execution
  getProjectCwd: () => string
}

// ---------------------------------------------------------------------------
// ChatController interface
// ---------------------------------------------------------------------------

export interface ChatController {
  /** Start a chat session. Transitions to 'chatting' state. No API call yet. */
  startChat(): boolean

  /** Send a user message to the active chat session. Lazy-starts the first API call. */
  sendMessage(text: string): void

  /**
   * Destroy the active chat session with a timeout.
   * Returns conversation summary captured before destruction.
   * Safe to call when no session is active (returns empty string).
   */
  destroyChat(): Promise<string>

  /** Restart chat (create a fresh session). Used after workflow completion or /new. */
  restartChat(): boolean

  /** Get the active chat session's conversation summary (empty if no session). */
  getConversationSummary(): string

  /** Whether a chat session is currently active. */
  isActive(): boolean

  /** Clean up resources. Called on TUI exit. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatController(deps: ChatControllerDeps): ChatController {
  let activeChatSession: ChatSession | null = null
  let activeWorker: InteractiveWorkerHandle | null = null

  /**
   * Try to create an InteractiveWorker.
   * Returns null if ANTHROPIC_API_KEY is missing (graceful fallback).
   */
  function tryCreateWorker(): InteractiveWorkerHandle | null {
    try {
      return createInteractiveWorker({
        cwd: deps.getProjectCwd(),
      })
    } catch (err) {
      // InteractiveWorker throws when ANTHROPIC_API_KEY is missing
      log.info("interactive worker creation failed (likely missing API key)", {
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }


  /**
   * Wire up the chat session: set store, subscribe, set app state.
   */
  function wireSession(session: ChatSession): void {
    activeChatSession = session
    deps.setActiveStore(session.store)
    deps.subscribeToStore(session.store)
    session.adapter.onModelActivityChange = (activity) => deps.setModelActivity(activity)
    deps.setModelActivity("idle")
    deps.setAppState("chatting")
  }

  /**
   * Unwire and destroy a chat session.
   */
  function teardownSession(): void {
    if (activeChatSession) {
      destroyChatSession(activeChatSession)
      activeChatSession = null
    }
    if (activeWorker) {
      activeWorker.shutdown()
      activeWorker = null
    }
    deps.unsubscribeStore()
    deps.setActiveStore(null)
    deps.setWorkState(null)
    deps.setModelActivity("idle")
  }

  const controller: ChatController = {
    startChat(): boolean {
      // Create worker first — validates API key
      const worker = tryCreateWorker()
      if (!worker) {
        deps.toast.show({
          message: "Chat unavailable: ANTHROPIC_API_KEY not set. Using idle mode.",
          variant: "warning",
          duration: 5000,
        })
        return false
      }
      activeWorker = worker

      // InteractiveWorker takes onStdout in options (fixed at creation), but
      // ChatSession provides its own onStdout callback per sendMessage via
      // spawnAgent. So we shut down the API-key-validation worker and create
      // the real one lazily inside spawnAgent with the correct onStdout wired.
      activeWorker.shutdown()
      activeWorker = null

      const session = createChatSession({
        spawnAgent: (message: string, onStdout: (chunk: string) => void): ChatAgentHandle => {
          // Create or reuse worker with correct onStdout
          if (!activeWorker) {
            try {
              activeWorker = createInteractiveWorker({
                cwd: deps.getProjectCwd(),
                onStdout,
              })
            } catch (err) {
              log.error("failed to create worker for message", {
                error: err instanceof Error ? err.message : String(err),
              })
              return {
                result: Promise.reject(err),
                abort: () => {},
              }
            }
          }

          const result = activeWorker.sendMessage(message).then(() => ({
            status: "completed" as const,
            totalTurns: 1,
            totalUsage: { inputTokens: 0, outputTokens: 0 },
          }))

          return {
            result,
            abort: () => {
              if (activeWorker) {
                activeWorker.shutdown()
                activeWorker = null
              }
            },
          }
        },
      })

      wireSession(session)
      log.info("chat session started (lazy — no API call until first message)")
      return true
    },

    sendMessage(text: string): void {
      if (!activeChatSession) {
        log.warn("sendMessage called with no active chat session")
        return
      }
      activeChatSession.sendMessage(text)
    },

    async destroyChat(): Promise<string> {
      if (!activeChatSession) return ""

      const summary = activeChatSession.getConversationSummary()
      log.info("destroying chat session", { summaryLength: summary.length })

      // Destroy with timeout to avoid blocking workflow start
      const teardown = new Promise<void>((resolve) => {
        teardownSession()
        resolve()
      })

      await Promise.race([
        teardown,
        new Promise<void>((resolve) => setTimeout(resolve, DESTROY_TIMEOUT_MS)),
      ])

      return summary
    },

    restartChat(): boolean {
      teardownSession()
      return controller.startChat()
    },

    getConversationSummary(): string {
      if (!activeChatSession) return ""
      return activeChatSession.getConversationSummary()
    },

    isActive(): boolean {
      return activeChatSession !== null
    },

    dispose(): void {
      teardownSession()
    },
  }

  return controller
}