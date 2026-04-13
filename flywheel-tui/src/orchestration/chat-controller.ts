import { createChatRunner } from "./chat-runner.js"
import { createOutputPersistence } from "./session/output-persistence.js"
import { readSession, updateSession } from "./session/persistence.js"
import { computeContextPercent } from "./session/budget-tracker-types.js"
import { TERMINAL_TITLE_PREFIX } from "../infra/format.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import type { ChatStoreHandle, SessionStore } from "./session-store-types.js"
import type { SessionManager } from "./session/manager.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { RunnerDoneResult, RunnerErrorResult } from "./session/types.js"

export interface ChatControllerDeps {
  sessionStore: SessionStore
  manager: SessionManager
  refreshList: () => void
  projectCwd: string
  onRunnerDone?: (id: string, result: RunnerDoneResult) => void
  onRunnerError?: (id: string, result: RunnerErrorResult) => void
}

interface StartChatResult {
  sessionId: string
  terminalTitle: string
}

interface ResumeChatResult {
  sessionId: string
  priorBlocks: AnyBlock[]
  terminalTitle: string
}

export interface ChatController {
  startChat(initialMessage?: string): Promise<StartChatResult | null>
  resumeChat(sessionId: string): Promise<ResumeChatResult | null>
  endChat(foregroundId: string | undefined): Promise<boolean>
  backgroundChat(foregroundId?: string): Promise<void>
  interruptChat(foregroundId: string | undefined): void
  sendMessage(foregroundId: string | undefined, text: string): boolean
}

type StartupState =
  | { phase: "idle" }
  | { phase: "starting"; id: string; pending: string[] }
  | { phase: "ready" }

const log = Log.create({ service: "chat-controller" })

export function createChatController(deps: ChatControllerDeps): ChatController {
  const { sessionStore, manager, refreshList, projectCwd } = deps

  let startup: StartupState = { phase: "idle" }
  let isFirstChat = true

  const emptyChats = new Set<string>()

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

  async function backgroundChat(foregroundId?: string): Promise<void> {
    startup = { phase: "idle" }
    if (foregroundId && emptyChats.has(foregroundId)) {
      finalizeChat(foregroundId)
      await sessionStore.remove(foregroundId)
    }
  }

  async function endChat(foregroundId: string | undefined): Promise<boolean> {
    if (!foregroundId) return false
    const entry = sessionStore.get(foregroundId)
    if (!entry || entry.kind !== "chat") return false

    if (startup.phase === "starting" && startup.id === foregroundId) {
      startup = { phase: "idle" }
    }

    finalizeChat(foregroundId)
    await sessionStore.remove(foregroundId)
    return true
  }

  function interruptChat(foregroundId: string | undefined): void {
    if (!foregroundId) return
    sessionStore.abort(foregroundId)
  }

  function sendMessage(foregroundId: string | undefined, text: string): boolean {
    if (startup.phase === "starting") {
      startup.pending.push(text)
      emptyChats.delete(startup.id)
      return true
    }
    if (!foregroundId) return false

    if (sessionStore.injectMessage(foregroundId, text)) {
      emptyChats.delete(foregroundId)
      return true
    }

    // Auto-resume: user sends a message into a viewed historical chat that has
    // no runner. Buffer the text in startup.pending so it appears immediately.
    const entry = sessionStore.get(foregroundId)
    if (entry?.kind === "chat" && entry.ended) {
      emptyChats.delete(foregroundId)
      const priorBlocks = entry.outputBlocks.length > 0
        ? [...entry.outputBlocks] as AnyBlock[]
        : undefined
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
