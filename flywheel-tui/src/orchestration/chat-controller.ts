import { createChatRunner } from "./chat-runner.js"
import { createOutputPersistence } from "./session/output-persistence.js"
import { readSession, updateSession } from "./session/persistence.js"
import { computeContextPercent } from "./session/budget-tracker-types.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import type { ChatStoreHandle, SessionStore, ChatSessionEntry } from "./session-store-types.js"
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
}

interface ResumeChatResult {
  sessionId: string
  priorBlocks: AnyBlock[]
}

export interface ChatController {
  startChat(initialMessage?: string): Promise<StartChatResult | null>
  resumeChat(sessionId: string): Promise<ResumeChatResult | null>
  endChat(foregroundId: string | undefined): Promise<boolean>
  backgroundChat(foregroundId?: string): Promise<void>
  interruptChat(foregroundId: string | undefined): void
  sendMessage(foregroundId: string | undefined, text: string): boolean
  sendToolResult(foregroundId: string | undefined, toolUseId: string, content: string, isError?: boolean): boolean
  answerQuestion(foregroundId: string | undefined, toolUseId: string, answers: Record<string, string>): boolean
  cancelQuestion(foregroundId: string | undefined, toolUseId: string): boolean
}

type StartupState =
  | { phase: "idle" }
  | { phase: "starting"; id: string; pending: string[] }

const log = Log.create({ service: "chat-controller" })

export function createChatController(deps: ChatControllerDeps): ChatController {
  const { sessionStore, manager, refreshList, projectCwd } = deps

  let startup: StartupState = { phase: "idle" }
  // Why here (not in the TUI): the controller is the only entity that knows
  // whether this is the first chat — the session manager lists historical
  // sessions, but new-process-first-chat is controller-local knowledge.
  let isFirstChat = true

  // Tracks sessions started with no initial message so they can be silently
  // deleted rather than persisted as "paused" stubs. Not a state — a policy.
  const emptyChats = new Set<string>()

  function finalizeChat(id: string): void {
    if (emptyChats.delete(id)) {
      try { manager.delete(id) } catch { /* already cleaned up */ }
    } else {
      const entry = sessionStore.get(id)
      if (entry?.kind === "chat" && entry.engineSessionId) {
        try { updateSession(id, { engineSessionId: entry.engineSessionId }, projectCwd) } catch { /* best-effort */ }
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
      engineSessionId?: string
      description?: string
      initialCost?: number
      initialTokens?: number
      startedAt?: number
      contextPercent?: number
    },
  ): Promise<{ sessionId: string } | null> {
    const priorPending = (startup.phase === "starting" && startup.id === sessionId) ? startup.pending : []
    startup = { phase: "starting", id: sessionId, pending: priorPending }

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
          deps.onRunnerDone?.(id, {})
        },
        onRunnerError: (id, err) => {
          finalizeChat(id)
          deps.onRunnerError?.(id, { errorMessage: extractErrorMessage(err) })
        },
        createRunner: (storeHandle: ChatStoreHandle) =>
          createChatRunner({
            sessionId,
            projectCwd,
            updateState: (id, state) => { manager.updateState(id, state); refreshList() },
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
            engineSessionId: opts?.engineSessionId,
          }),
      })

      const pendingMessages = startup.phase === "starting" ? startup.pending : []
      startup = { phase: "idle" }
      isFirstChat = false

      for (const msg of pendingMessages) {
        sessionStore.injectMessage(sessionId, msg)
      }

      return { sessionId }
    } catch {
      // Caller handles null return — no additional recovery needed
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
    return { sessionId: result.sessionId }
  }

  async function resumeChat(sessionId: string): Promise<ResumeChatResult | null> {
    const priorBlocks: AnyBlock[] = await createOutputPersistence({ sessionId, baseDir: projectCwd }).load()
    const p = readSession(sessionId, projectCwd)
    const bu = p?.budgetUsage
    const result = await launchChat(sessionId, {
      priorBlocks: priorBlocks.length > 0 ? priorBlocks : undefined,
      engineSessionId: p?.kind === "chat" ? p.engineSessionId : undefined,
      description: p?.label || p?.name || undefined,
      initialCost: p?.totalCost || bu?.cost_usd || undefined,
      initialTokens: bu?.tokens_used || undefined,
      startedAt: p?.createdAt ? new Date(p.createdAt).getTime() : undefined,
      contextPercent: computeContextPercent(bu?.context_prompt_tokens ?? 0, bu?.context_window ?? 0) || undefined,
    })
    if (!result) return null
    return { sessionId: result.sessionId, priorBlocks }
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

  function autoResumeChat(sessionId: string, entry: ChatSessionEntry, text: string): void {
    emptyChats.delete(sessionId)
    const priorBlocks = entry.outputBlocks.length > 0
      ? [...entry.outputBlocks] as AnyBlock[]
      : undefined
    startup = { phase: "starting", id: sessionId, pending: [text] }
    launchChat(sessionId, {
      priorBlocks,
      engineSessionId: entry.engineSessionId,
      description: entry.description,
      initialCost: entry.cost || undefined,
      initialTokens: entry.tokens || undefined,
      startedAt: entry.startedAt || undefined,
      contextPercent: entry.contextPercent || undefined,
    }).catch((err) => {
      log.error("chat auto-resume failed — message dropped", { error: extractErrorMessage(err) })
      startup = { phase: "idle" }
    })
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

    const entry = sessionStore.get(foregroundId)
    if (entry?.kind === "chat" && entry.ended) {
      autoResumeChat(foregroundId, entry, text)
      return true
    }

    log.error("chat message dropped — no delivery path", {
      foregroundId,
      hasEntry: !!entry,
      entryKind: entry?.kind,
      entryEnded: entry?.ended,
      hasRunner: !!entry?.runner,
      startupPhase: startup.phase,
    })
    return false
  }

  function sendToolResult(foregroundId: string | undefined, toolUseId: string, content: string, isError?: boolean): boolean {
    if (!foregroundId) return false
    return sessionStore.injectToolResult(foregroundId, toolUseId, content, isError)
  }

  function answerQuestion(foregroundId: string | undefined, toolUseId: string, answers: Record<string, string>): boolean {
    if (!foregroundId) return false
    return sessionStore.answerQuestion(foregroundId, toolUseId, answers)
  }

  function cancelQuestion(foregroundId: string | undefined, toolUseId: string): boolean {
    if (!foregroundId) return false
    return sessionStore.cancelQuestion(foregroundId, toolUseId)
  }

  return {
    startChat,
    resumeChat,
    endChat,
    backgroundChat,
    interruptChat,
    sendMessage,
    sendToolResult,
    answerQuestion,
    cancelQuestion,
  }
}
