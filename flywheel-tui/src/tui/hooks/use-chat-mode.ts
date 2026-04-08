/**
 * Chat Mode Hook — manages chat lifecycle through the session registry.
 *
 * All display state (output blocks, tokens, cost, activity) is driven by
 * useRegistrySync via the registry's subscriber notifications. This hook
 * only manages the chat session lifecycle: start, send, interrupt, end.
 *
 * Multi-chat: multiple chat sessions can coexist in the registry.
 * - `/new` and Ctrl+N background the current chat and start a fresh one.
 * - `/end` actually closes the foreground chat (removes from registry).
 * - Ctrl+B switches between all live sessions (chats and workflows).
 * - `sendMessage`, `interruptChat`, `endChat` operate on the foreground session.
 */

import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { SessionRegistry, ChatRegistryCallbacks } from "../../orchestration/session-registry.js"
import { TERMINAL_TITLE_PREFIX } from "./use-workflow-lifecycle.js"
import { createChatRunner } from "../../orchestration/chat-runner.js"
import { createOutputPersistence } from "../../orchestration/session/output-persistence.js"
import { formatElapsed, formatCost, formatTokens } from "../format.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { AnyBlock } from "../../infra/output-blocks.js"

export interface ChatModeDeps {
  registry: SessionRegistry
  foregroundId: Accessor<string | undefined>
  setForegroundId: (id: string | undefined) => void
  setAgentState: (state: import("./use-workflow-lifecycle.js").AgentState) => void
  setErrorMessage: (msg: string) => void
  manager: {
    create(planPath: string, name?: string, kind?: string, initialState?: string): string
    updateState(id: string, state: string): void
    updateLabel(id: string, label: string): void
  }
  refreshList: () => void
  setSessionTitle: (title: string) => void
  setStatusLine: (line: string) => void
  setTerminalTitle: (title: string) => void
  resetMetrics: () => void
  /** workStartTime accessor from metrics hook, for elapsed calculation. */
  workStartTime: () => number
  /** Project working directory — injected to avoid hardcoding process.cwd(). */
  projectCwd: string
}

export interface ChatModeHook {
  /** True while a chat session is being created (async startup window). */
  chatActive: Accessor<boolean>
  startChat(initialMessage?: string): Promise<void>
  /** Resume a previous chat session, loading its persisted output blocks. */
  resumeChat(sessionId: string): Promise<void>
  /** Put the current chat in the background without ending it. */
  backgroundChat(): void
  interruptChat(): void
  /** Close the foreground chat — removes from registry and marks completed. */
  endChat(): void
  sendMessage(text: string): void
}

export function useChatMode(deps: ChatModeDeps): ChatModeHook {
  // Only true during the async startup window of a new chat
  const [chatActive, setChatActive] = createSignal(false)
  // Tracks the chat currently being created (for async startup buffering)
  let startingChatId: string | null = null
  let chatReady = false
  let pendingMessages: string[] = []
  let isFirstChat = true

  /** Internal helper: wire up a chat session with the registry. */
  async function launchChat(
    sessionId: string,
    opts?: { initialMessage?: string; priorBlocks?: AnyBlock[] },
  ): Promise<void> {
    startingChatId = sessionId
    chatReady = false
    pendingMessages = []
    setChatActive(true)
    deps.setSessionTitle("Chat")
    deps.setStatusLine("")
    deps.setTerminalTitle(opts?.priorBlocks ? `${TERMINAL_TITLE_PREFIX}chat (resumed)` : `${TERMINAL_TITLE_PREFIX}chat`)
    deps.resetMetrics()

    // Set foregroundId early so inChat() returns true during async startup.
    deps.setForegroundId(sessionId)

    try {
      await deps.registry.startChat({
        sessionId,
        description: "Chat",
        priorBlocks: opts?.priorBlocks,
        onRunnerDone: (id) => {
          const totalElapsed = formatElapsed(Date.now() - deps.workStartTime())
          const entry = deps.registry.get(id)
          const tokens = entry?.tokens ?? 0
          const cost = entry?.cost ?? 0
          deps.manager.updateState(id, "completed")
          deps.setStatusLine(`Chat ended \u00b7 ${totalElapsed} \u00b7 ${formatCost(cost)} \u00b7 ${formatTokens(tokens)} tokens`)
          deps.setAgentState("idle")
          deps.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}done`)
          deps.refreshList()
          deps.setForegroundId(undefined)
        },
        onRunnerError: (id, err) => {
          deps.manager.updateState(id, "paused")
          deps.setErrorMessage(extractErrorMessage(err))
          deps.setAgentState("idle")
          deps.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}error`)
          deps.refreshList()
          deps.setForegroundId(undefined)
        },
        createRunner: (registryCallbacks: ChatRegistryCallbacks) =>
          createChatRunner({
            sessionId,
            projectCwd: deps.projectCwd,
            updateState: (id, state) => deps.manager.updateState(id, state),
            callbacks: {
              onBlocks: registryCallbacks.onBlocks,
              onTokens: registryCallbacks.onTokens,
              onCost: registryCallbacks.onCost,
              onContextPercent: registryCallbacks.onContextPercent,
              onModelActivity: registryCallbacks.onModelActivity,
              onSessionName: (name) => {
                registryCallbacks.onSessionName(name)
                deps.manager.updateLabel(sessionId, name)
                deps.refreshList()
              },
              onError: registryCallbacks.onError,
              onEnded: () => {
                registryCallbacks.onEnded()
              },
            },
            initialMessage: opts?.initialMessage?.trim() || undefined,
            priorBlocks: opts?.priorBlocks,
            showWelcome: isFirstChat && !opts?.priorBlocks,
          }),
      })

      chatReady = true
      startingChatId = null
      isFirstChat = false
      setChatActive(false)

      // Replay any messages that arrived during async startup
      for (const msg of pendingMessages) {
        deps.registry.injectMessage(sessionId, msg)
      }
      pendingMessages = []
    } catch (err) {
      startingChatId = null
      chatReady = false
      pendingMessages = []
      setChatActive(false)
      deps.setErrorMessage("Chat failed to start")
    }
  }

  async function startChat(initialMessage?: string): Promise<void> {
    const sessionId = deps.manager.create("chat", "Chat", "chat", "active")
    deps.refreshList()
    await launchChat(sessionId, { initialMessage })
  }

  async function resumeChat(sessionId: string): Promise<void> {
    const persistence = createOutputPersistence({ sessionId, baseDir: deps.projectCwd })
    const loaded = await persistence.load()
    const priorBlocks = loaded as AnyBlock[]
    await launchChat(sessionId, { priorBlocks: priorBlocks.length > 0 ? priorBlocks : undefined })
  }

  /** Put the foreground chat in the background — stays alive in registry. */
  function backgroundChat(): void {
    // Clear async startup state if still in progress
    startingChatId = null
    chatReady = false
    pendingMessages = []
    setChatActive(false)
    deps.setForegroundId(undefined)
  }

  /** Close the foreground chat — removes from registry and marks completed. */
  function endChat(): void {
    const fgId = deps.foregroundId()
    if (!fgId) return
    const entry = deps.registry.get(fgId)
    if (!entry || entry.kind !== "chat") return

    // If ending the chat we're currently starting, clean up startup state
    if (fgId === startingChatId) {
      startingChatId = null
      chatReady = false
      pendingMessages = []
    }
    setChatActive(false)

    deps.registry.remove(fgId)
    deps.manager.updateState(fgId, "completed")
    deps.refreshList()
    deps.setForegroundId(undefined)
  }

  function interruptChat(): void {
    const fgId = deps.foregroundId()
    if (!fgId) return
    deps.registry.abort(fgId)
  }

  function sendMessage(text: string): void {
    // During async startup, buffer messages
    if (startingChatId && !chatReady) {
      pendingMessages.push(text)
      return
    }
    // Send to whatever chat is in the foreground
    const fgId = deps.foregroundId()
    if (!fgId) return
    deps.registry.injectMessage(fgId, text)
  }

  return { chatActive, startChat, resumeChat, backgroundChat, interruptChat, endChat, sendMessage }
}
