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
import type { ChatRegistryCallbacks } from "../../orchestration/session-registry.js"
import { TERMINAL_TITLE_PREFIX } from "./use-workflow-lifecycle.js"
import { createChatRunner } from "../../orchestration/chat-runner.js"
import { createOutputPersistence } from "../../orchestration/session/output-persistence.js"
import { formatElapsed, formatCost, formatTokens } from "../format.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { AnyBlock } from "../../infra/output-blocks.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

export interface ChatModeDeps {
  signals: ShellSignals
  services: ShellServices
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
  const { signals, services } = deps

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
    signals.setSessionTitle("Chat")
    signals.setStatusLine("")
    services.setTerminalTitle(opts?.priorBlocks ? `${TERMINAL_TITLE_PREFIX}chat (resumed)` : `${TERMINAL_TITLE_PREFIX}chat`)
    services.metrics.resetMetrics()

    // Set foregroundId early so inChat() returns true during async startup.
    signals.setForegroundId(sessionId)

    try {
      await services.registry.startChat({
        sessionId,
        description: "Chat",
        priorBlocks: opts?.priorBlocks,
        onRunnerDone: (id) => {
          const totalElapsed = formatElapsed(Date.now() - services.metrics.workStartTime())
          const entry = services.registry.get(id)
          const tokens = entry?.tokens ?? 0
          const cost = entry?.cost ?? 0
          services.manager.updateState(id, "completed")
          signals.setStatusLine(`Chat ended \u00b7 ${totalElapsed} \u00b7 ${formatCost(cost)} \u00b7 ${formatTokens(tokens)} tokens`)
          signals.setAgentState("idle")
          services.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}done`)
          services.refreshList()
          signals.setForegroundId(undefined)
        },
        onRunnerError: (id, err) => {
          services.manager.updateState(id, "paused")
          signals.setErrorMessage(extractErrorMessage(err))
          signals.setAgentState("idle")
          services.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}error`)
          services.refreshList()
          signals.setForegroundId(undefined)
        },
        createRunner: (registryCallbacks: ChatRegistryCallbacks) =>
          createChatRunner({
            sessionId,
            projectCwd: deps.projectCwd,
            updateState: (id, state) => services.manager.updateState(id, state),
            callbacks: {
              onBlocks: registryCallbacks.onBlocks,
              onTokens: registryCallbacks.onTokens,
              onCost: registryCallbacks.onCost,
              onContextPercent: registryCallbacks.onContextPercent,
              onModelActivity: registryCallbacks.onModelActivity,
              onSessionName: (name) => {
                registryCallbacks.onSessionName(name)
                services.manager.updateLabel(sessionId, name)
                services.refreshList()
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
        services.registry.injectMessage(sessionId, msg)
      }
      pendingMessages = []
    } catch (err) {
      startingChatId = null
      chatReady = false
      pendingMessages = []
      setChatActive(false)
      signals.setErrorMessage("Chat failed to start")
    }
  }

  async function startChat(initialMessage?: string): Promise<void> {
    const sessionId = services.manager.create("chat", "Chat", "chat", "active")
    services.refreshList()
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
    signals.setForegroundId(undefined)
  }

  /** Close the foreground chat — removes from registry and marks completed. */
  function endChat(): void {
    const fgId = signals.foregroundId()
    if (!fgId) return
    const entry = services.registry.get(fgId)
    if (!entry || entry.kind !== "chat") return

    // If ending the chat we're currently starting, clean up startup state
    if (fgId === startingChatId) {
      startingChatId = null
      chatReady = false
      pendingMessages = []
    }
    setChatActive(false)

    services.registry.remove(fgId)
    services.manager.updateState(fgId, "completed")
    services.refreshList()
    signals.setForegroundId(undefined)
  }

  function interruptChat(): void {
    const fgId = signals.foregroundId()
    if (!fgId) return
    services.registry.abort(fgId)
  }

  function sendMessage(text: string): void {
    // During async startup, buffer messages
    if (startingChatId && !chatReady) {
      pendingMessages.push(text)
      return
    }
    // Send to whatever chat is in the foreground
    const fgId = signals.foregroundId()
    if (!fgId) return
    services.registry.injectMessage(fgId, text)
  }

  return { chatActive, startChat, resumeChat, backgroundChat, interruptChat, endChat, sendMessage }
}
