import { createSignal, batch } from "solid-js"
import type { Accessor } from "solid-js"
import { createChatController } from "../../orchestration/chat-controller.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"
import { wireLifecycleCallbacks } from "./lifecycle-callbacks.js"

interface ChatModeDeps {
  signals: ShellSignals
  services: ShellServices
  /** Project working directory — injected to avoid hardcoding process.cwd(). */
  projectCwd: string
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
}

export function useChatMode(deps: ChatModeDeps): ChatModeHook {
  const { signals, services } = deps
  const metrics = services.metrics

  // Only true during the async startup window of a new chat
  const [chatActive, setChatActive] = createSignal(false)

  const callbacks = wireLifecycleCallbacks(signals, services)

  const controller = createChatController({
    sessionStore: services.sessionStore,
    manager: services.manager,
    refreshList: services.refreshList,
    projectCwd: deps.projectCwd,
    onRunnerDone: callbacks.onRunnerDone,
    onRunnerError: callbacks.onRunnerError,
  })

  async function startChat(initialMessage?: string): Promise<void> {
    setChatActive(true)
    metrics.resetMetrics()

    const result = await controller.startChat(initialMessage)

    batch(() => {
      setChatActive(false)
      if (result) {
        signals.setForegroundId(result.sessionId)
        services.setTerminalTitle(result.terminalTitle)
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

  return { chatActive, startChat, backgroundChat, interruptChat, endChat, sendMessage }
}
