import type { Accessor } from "solid-js"
import { createChatController } from "../../orchestration/chat-controller.js"
import type { ShellSignals } from "./shell-state.js"
import type { SessionStore } from "../../orchestration/session-store-types.js"
import type { SessionManager } from "../../orchestration/session/manager.js"
import type { MetricsHook } from "./use-metrics.js"

interface ChatModeDeps {
  signals: ShellSignals
  sessionStore: SessionStore
  manager: SessionManager
  metrics: MetricsHook
  /** Project working directory — injected to avoid hardcoding process.cwd(). */
  projectCwd: string
  onRunnerDone: (id: string) => void
  onRunnerError: (id: string, errorMessage: string) => void
}

export interface ChatModeHook {
  /** True while a chat session is being created (async startup window) —
   *  forwarded from the controller so there's one source of truth. */
  isStarting: Accessor<boolean>
  startChat(initialMessage?: string): Promise<void>
  /** Put the current chat in the background without ending it. */
  backgroundChat(): Promise<void>
  interruptChat(): void
  /** Close the foreground chat — removes from store and marks paused. */
  endChat(): Promise<void>
  sendMessage(text: string): void
  answerQuestion(toolUseId: string, answers: Record<string, string>): void
  cancelQuestion(toolUseId: string): void
}

export function useChatMode(deps: ChatModeDeps): ChatModeHook {
  const { signals, sessionStore, manager, metrics, projectCwd, onRunnerDone, onRunnerError } = deps

  const controller = createChatController({
    sessionStore,
    manager,
    projectCwd,
    onRunnerDone,
    onRunnerError,
  })

  async function startChat(initialMessage?: string): Promise<void> {
    metrics.resetMetrics()
    const sessionId = await controller.startChat(initialMessage)
    if (sessionId) signals.setForegroundId(sessionId)
    else signals.setErrorMessage("Chat failed to start")
  }

  async function backgroundChat(): Promise<void> {
    const fgId = signals.foregroundId()
    signals.setForegroundId(undefined)
    await controller.backgroundChat(fgId)
  }

  async function endChat(): Promise<void> {
    const fgId = signals.foregroundId()
    if (await controller.endChat(fgId)) signals.setForegroundId(undefined)
  }

  function interruptChat(): void {
    controller.interruptChat(signals.foregroundId())
  }

  function sendMessage(text: string): void {
    controller.sendMessage(signals.foregroundId(), text)
  }

  function answerQuestion(toolUseId: string, answers: Record<string, string>): void {
    controller.answerQuestion(signals.foregroundId(), toolUseId, answers)
  }

  function cancelQuestion(toolUseId: string): void {
    controller.cancelQuestion(signals.foregroundId(), toolUseId)
  }

  return {
    isStarting: controller.isStarting,
    startChat,
    backgroundChat,
    interruptChat,
    endChat,
    sendMessage,
    answerQuestion,
    cancelQuestion,
  }
}