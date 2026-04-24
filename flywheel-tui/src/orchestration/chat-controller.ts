import { createSignal, type Accessor } from "solid-js"
import { createChatRunner } from "./chat-runner.js"
import { updateSession } from "./session/persistence.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import type { ChatStoreHandle, SessionStore, ChatSessionEntry } from "./session-store-types.js"
import type { SessionManager } from "./session/manager.js"
import type { AnyBlock } from "../infra/output-blocks.js"

interface ChatControllerDeps {
  sessionStore: SessionStore
  manager: SessionManager
  projectCwd: string
  onRunnerDone?: (id: string) => void
  onRunnerError?: (id: string, errorMessage: string) => void
}

interface ChatController {
  /** True during the async startup window — from the first launchChat call
   *  until the session-store entry exists (or startup fails). Reactive so the
   *  shell can render "in chat" while the sessionStore entry is still being built. */
  isStarting: Accessor<boolean>
  startChat(initialMessage?: string): Promise<string | null>
  endChat(foregroundId: string | undefined): Promise<boolean>
  backgroundChat(foregroundId?: string): Promise<void>
  interruptChat(foregroundId: string | undefined): void
  sendMessage(foregroundId: string | undefined, text: string): boolean
  answerQuestion(foregroundId: string | undefined, toolUseId: string, answers: Record<string, string>): boolean
  cancelQuestion(foregroundId: string | undefined, toolUseId: string): boolean
}

type StartupState =
  | { phase: "idle" }
  | { phase: "starting"; id: string; pending: string[] }

const log = Log.create({ service: "chat-controller" })

export function createChatController(deps: ChatControllerDeps): ChatController {
  const { sessionStore, manager, projectCwd } = deps

  let startup: StartupState = { phase: "idle" }
  const [isStarting, setIsStarting] = createSignal(false)
  let isFirstChat = true
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
  ): Promise<boolean> {
    const priorPending = (startup.phase === "starting" && startup.id === sessionId) ? startup.pending : []
    startup = { phase: "starting", id: sessionId, pending: priorPending }
    setIsStarting(true)

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
          deps.onRunnerDone?.(id)
        },
        onRunnerError: (id, err) => {
          finalizeChat(id)
          deps.onRunnerError?.(id, extractErrorMessage(err))
        },
        createRunner: (storeHandle: ChatStoreHandle) =>
          createChatRunner({
            sessionId,
            projectCwd,
            updateState: manager.updateState,
            updateEntry: storeHandle.updateEntry,
            onSessionName: (name) => manager.updateLabel(sessionId, name),
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
      setIsStarting(false)
      isFirstChat = false

      for (const msg of pendingMessages) {
        sessionStore.injectMessage(sessionId, msg)
      }

      return true
    } catch (err) {
      log.warn("launchChat failed", { sessionId, error: extractErrorMessage(err) })
      startup = { phase: "idle" }
      setIsStarting(false)
      return false
    }
  }

  async function startChat(initialMessage?: string): Promise<string | null> {
    const sessionId = manager.create("chat", "Chat", "chat", "active")
    if (!(await launchChat(sessionId, { initialMessage }))) {
      try { manager.delete(sessionId) } catch { /* best-effort */ }
      return null
    }
    if (!initialMessage?.trim()) emptyChats.add(sessionId)
    return sessionId
  }

  async function backgroundChat(foregroundId?: string): Promise<void> {
    startup = { phase: "idle" }
    setIsStarting(false)
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
      setIsStarting(false)
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
    manager.updateState(sessionId, "active")
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
      setIsStarting(false)
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

  function answerQuestion(foregroundId: string | undefined, toolUseId: string, answers: Record<string, string>): boolean {
    if (!foregroundId) return false
    return sessionStore.answerQuestion(foregroundId, toolUseId, answers)
  }

  function cancelQuestion(foregroundId: string | undefined, toolUseId: string): boolean {
    if (!foregroundId) return false
    return sessionStore.cancelQuestion(foregroundId, toolUseId)
  }

  return {
    isStarting,
    startChat,
    endChat,
    backgroundChat,
    interruptChat,
    sendMessage,
    answerQuestion,
    cancelQuestion,
  }
}
