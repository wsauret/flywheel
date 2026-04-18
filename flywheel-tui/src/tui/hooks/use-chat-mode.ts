import { createSignal, batch } from "solid-js"
import type { Accessor } from "solid-js"
import { createChatController } from "../../orchestration/chat-controller.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"
import type { RunnerDoneResult, RunnerErrorResult } from "../../orchestration/session/types.js"

interface ChatModeDeps {
  signals: ShellSignals
  services: ShellServices
  /** Project working directory — injected to avoid hardcoding process.cwd(). */
  projectCwd: string
  lifecycleCallbacks: {
    onRunnerDone: (id: string, result: RunnerDoneResult) => void
    onRunnerError: (id: string, result: RunnerErrorResult) => void
  }
}

export interface ChatModeHook {
  /** True while a chat session is being created (async startup window). */
  chatActive: Accessor<boolean>
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
  const { signals, services } = deps
  const metrics = services.metrics

  // Only true during the async startup window of a new chat
  const [chatActive, setChatActive] = createSignal(false)

  const controller = createChatController({
    sessionStore: services.sessionStore,
    manager: services.manager,
    projectCwd: deps.projectCwd,
    onRunnerDone: deps.lifecycleCallbacks.onRunnerDone,
    onRunnerError: deps.lifecycleCallbacks.onRunnerError,
  })

  async function startChat(initialMessage?: string): Promise<void> {
    setChatActive(true)
    metrics.resetMetrics()

    const result = await controller.startChat(initialMessage)

    batch(() => {
      setChatActive(false)
      if (result) {
        signals.setForegroundId(result.sessionId)
      } else {
        signals.setErrorMessage("Chat failed to start")
      }
    })
  }

  async function backgroundChat(): Promise<void> {
    await controller.backgroundChat(signals.foregroundId())
    batch(() => {
      setChatActive(false)
      signals.setForegroundId(undefined)
    })
  }

  async function endChat(): Promise<void> {
    const fgId = signals.foregroundId()
    const ended = await controller.endChat(fgId)
    if (ended) {
      batch(() => {
        setChatActive(false)
        signals.setForegroundId(undefined)
      })
    }
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

  return { chatActive, startChat, backgroundChat, interruptChat, endChat, sendMessage, answerQuestion, cancelQuestion }
}
