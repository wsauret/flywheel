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
import { readSession, updateSession } from "./session/persistence.js"
import { computeContextPercent } from "./session/budget-tracker-types.js"
import { TERMINAL_TITLE_PREFIX, formatElapsed, formatCost, formatTokens } from "../infra/format.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import type { ChatStoreHandle, SessionStore } from "./session-store-types.js"
import type { SessionManager } from "./session/manager.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { RunnerDoneResult, RunnerErrorResult } from "./session/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatControllerDeps {
  sessionStore: SessionStore
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

  /** Put the current chat in the background. Empty chats (no user messages) are auto-deleted. */
  backgroundChat(foregroundId?: string): void

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

const log = Log.create({ service: "chat-controller" })

export function createChatController(deps: ChatControllerDeps): ChatController {
  const { sessionStore, manager, refreshList, projectCwd } = deps

  let startup: StartupState = { phase: "idle" }
  let isFirstChat = true

  // Chat sessions created in this instance that haven't received any user messages.
  // These are auto-deleted (not persisted) when ended, backgrounded, or runner-completed.
  const emptyChats = new Set<string>()

  /**
   * Bring a chat session to its final disk state.
   * Empty chats (no user messages) are deleted. Chats with messages get
   * their claudeSessionId persisted and state set to paused for resume.
   */
  function finalizeChat(id: string): void {
    if (emptyChats.delete(id)) {
      try { manager.delete(id) } catch { /* already cleaned up */ }
    } else {
      const entry = sessionStore.get(id)
      if (entry?.kind === "chat" && entry.claudeSessionId) {
        try { updateSession(id, { claudeSessionId: entry.claudeSessionId }, projectCwd) } catch { /* best-effort */ }
      }
      manager.updateState(id, "paused")
    }
    refreshList()
  }

  /**
   * Internal helper: wire up a chat session with the sessionStore.
   * Returns the session ID on success, null on failure.
   */
  async function launchChat(
    sessionId: string,
    opts?: {
      initialMessage?: string
      priorBlocks?: AnyBlock[]
      claudeSessionId?: string
      description?: string
      initialCost?: number
      initialTokens?: number
      startedAt?: number
      contextPercent?: number
    },
  ): Promise<{ sessionId: string; terminalTitle: string } | null> {
    // Preserve any messages already buffered by sendMessage's auto-resume path
    const priorPending = (startup.phase === "starting" && startup.id === sessionId) ? startup.pending : []
    startup = { phase: "starting", id: sessionId, pending: priorPending }

    const terminalTitle = opts?.priorBlocks
      ? `${TERMINAL_TITLE_PREFIX}chat (resumed)`
      : `${TERMINAL_TITLE_PREFIX}chat`

    try {
      await sessionStore.startChat({
        sessionId,
        description: opts?.description ?? "Chat",
        priorBlocks: opts?.priorBlocks,
        initialCost: opts?.initialCost,
        initialTokens: opts?.initialTokens,
        startedAt: opts?.startedAt,
        contextPercent: opts?.contextPercent,
        onRunnerDone: (id) => {
          finalizeChat(id)
          deps.onRunnerDone?.(id, {
            statusMessage: "",
            terminalTitle: `${TERMINAL_TITLE_PREFIX}chat`,
          } satisfies RunnerDoneResult)
        },
        onRunnerError: (id, err) => {
          finalizeChat(id)
          deps.onRunnerError?.(id, {
            errorMessage: extractErrorMessage(err),
            terminalTitle: `${TERMINAL_TITLE_PREFIX}error`,
          } satisfies RunnerErrorResult)
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
            claudeSessionId: opts?.claudeSessionId,
          }),
      })

      // Replay any messages that arrived during async startup
      const pendingMessages = startup.phase === "starting" ? startup.pending : []
      startup = { phase: "ready" }
      isFirstChat = false

      for (const msg of pendingMessages) {
        sessionStore.injectMessage(sessionId, msg)
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
    if (!result) {
      try { manager.delete(sessionId) } catch { /* best-effort */ }
      refreshList()
      return null
    }
    if (!initialMessage?.trim()) emptyChats.add(sessionId)
    return { sessionId: result.sessionId, terminalTitle: result.terminalTitle }
  }

  async function resumeChat(sessionId: string): Promise<ResumeChatResult | null> {
    const persistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
    const priorBlocks: AnyBlock[] = await persistence.load()
    // Read persisted Claude session ID for --resume
    const persisted = readSession(sessionId, projectCwd)
    const claudeSessionId = persisted?.kind === "chat" ? persisted.claudeSessionId : undefined
    const description = persisted?.label || persisted?.name || undefined
    const initialCost = persisted?.totalCost || persisted?.budgetUsage?.cost_usd || undefined
    const initialTokens = persisted?.budgetUsage?.tokens_used || undefined
    const startedAt = persisted?.createdAt ? new Date(persisted.createdAt).getTime() : undefined
    const bu = persisted?.budgetUsage
    const contextPercent = computeContextPercent(bu?.context_prompt_tokens ?? 0, bu?.context_window ?? 0) || undefined
    const result = await launchChat(sessionId, {
      priorBlocks: priorBlocks.length > 0 ? priorBlocks : undefined,
      claudeSessionId,
      description,
      initialCost,
      initialTokens,
      startedAt,
      contextPercent,
    })
    if (!result) return null
    return { sessionId: result.sessionId, priorBlocks, terminalTitle: result.terminalTitle }
  }

  function backgroundChat(foregroundId?: string): void {
    startup = { phase: "idle" }
    if (foregroundId && emptyChats.has(foregroundId)) {
      finalizeChat(foregroundId)
      sessionStore.remove(foregroundId)
    }
  }

  function endChat(foregroundId: string | undefined): boolean {
    if (!foregroundId) return false
    const entry = sessionStore.get(foregroundId)
    if (!entry || entry.kind !== "chat") return false

    if (startup.phase === "starting" && startup.id === foregroundId) {
      startup = { phase: "idle" }
    }

    finalizeChat(foregroundId)
    sessionStore.remove(foregroundId)
    return true
  }

  function interruptChat(foregroundId: string | undefined): void {
    if (!foregroundId) return
    sessionStore.abort(foregroundId)
  }

  function sendMessage(foregroundId: string | undefined, text: string): boolean {
    // During async startup, buffer messages
    if (startup.phase === "starting") {
      startup.pending.push(text)
      emptyChats.delete(startup.id)
      return true
    }
    if (!foregroundId) return false

    // Fast path: session has an active runner — inject directly
    if (sessionStore.injectMessage(foregroundId, text)) {
      emptyChats.delete(foregroundId)
      return true
    }

    // Ended chat session — auto-resume with this message.
    // This happens when the user views a historical/ended chat (Ctrl+B → Enter)
    // and then sends a message. The loaded entry has no runner, so we recreate
    // one via launchChat with --resume <claudeSessionId> for full context.
    // The text is buffered in startup.pending so it flows through send() →
    // notifyInjected() (user message bubble appears immediately).
    const entry = sessionStore.get(foregroundId)
    if (entry?.kind === "chat" && entry.ended) {
      emptyChats.delete(foregroundId)
      const priorBlocks = entry.outputBlocks.length > 0
        ? [...entry.outputBlocks] as AnyBlock[]
        : undefined
      // Buffer the message BEFORE launchChat — launchChat preserves existing pending.
      startup = { phase: "starting", id: foregroundId, pending: [text] }
      launchChat(foregroundId, {
        priorBlocks,
        claudeSessionId: entry.claudeSessionId,
        description: entry.description,
        initialCost: entry.cost || undefined,
        initialTokens: entry.tokens || undefined,
        startedAt: entry.startedAt || undefined,
        contextPercent: entry.contextPercent || undefined,
      }).catch((err) => {
        log.error("chat auto-resume failed — message dropped", { error: extractErrorMessage(err) })
        startup = { phase: "idle" }
      })
      return true
    }

    // If we reach here, the message was silently dropped — no inject, no auto-resume.
    // Log diagnostics so we can trace the root cause.
    const diagEntry = sessionStore.get(foregroundId)
    log.error("chat message dropped — no delivery path", {
      foregroundId,
      hasEntry: !!diagEntry,
      entryKind: diagEntry?.kind,
      entryEnded: diagEntry?.ended,
      hasRunner: !!diagEntry?.runner,
      startupPhase: startup.phase,
    })
    return false
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
