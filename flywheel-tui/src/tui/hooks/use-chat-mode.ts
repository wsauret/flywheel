import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { startChatSession, type ChatSession } from "../chat.js"
import { formatElapsed, formatCost, formatTokens } from "../format.js"
import { errorMessage as extractErrorMessage } from "../../workflows/shared/error-message.js"
import type { AnyBlock } from "../types.js"
import type { AppState } from "./use-workflow-lifecycle.js"

export interface ChatModeDeps {
  appState: Accessor<AppState>
  setAppState: (state: AppState) => void
  setOutputBlocks: (blocks: AnyBlock[]) => void
  setSteps: (steps: never[]) => void
  setErrorMessage: (msg: string) => void
  setStatusLine: (line: string) => void
  setSessionTitle: (title: string) => void
  setTerminalTitle: (title: string) => void
  resetMetrics: () => void
  startTimer: () => void
  stopTimer: () => void
  workStartTime: Accessor<number>
  setTokens: (n: number) => void
  setCost: (n: number) => void
  setActivity: (a: "idle" | "thinking" | "generating" | "tool_executing") => void
}

export interface ChatModeHook {
  chatWaiting: Accessor<boolean>
  startChat(initialMessage?: string): Promise<void>
  endChat(): void
  sendMessage(text: string): void
  getChatSession(): ChatSession | null
}

export function useChatMode(deps: ChatModeDeps): ChatModeHook {
  const [chatWaiting, setChatWaiting] = createSignal(false)
  let chatSession: ChatSession | null = null

  async function startChat(initialMessage?: string): Promise<void> {
    deps.setAppState("chatting")
    deps.setOutputBlocks([])
    deps.setSteps([])
    deps.setErrorMessage("")
    deps.setStatusLine("")
    deps.setSessionTitle("Chat")
    setChatWaiting(false)
    deps.resetMetrics()
    deps.startTimer()
    deps.setTerminalTitle("flywheel · chat")

    try {
      chatSession = await startChatSession({
        onBlocksChanged: deps.setOutputBlocks,
        onWaitingChanged: setChatWaiting,
        onTokensChanged: deps.setTokens,
        onCostChanged: deps.setCost,
        onModelActivity: deps.setActivity,
        onError: (msg) => { deps.setErrorMessage(msg); deps.setAppState("error") },
        onEnded: () => {
          if (deps.appState() !== "chatting") return
          deps.stopTimer()
          const cost = chatSession?.budgetTracker.getTotalCost() ?? 0
          const tokens = chatSession?.budgetTracker.getTokensUsed() ?? 0
          deps.setStatusLine(`Chat ended · ${formatElapsed(Date.now() - deps.workStartTime())} · ${formatCost(cost)} · ${formatTokens(tokens)} tokens`)
          chatSession = null
          deps.setAppState("completed")
          deps.setTerminalTitle("flywheel · done")
        },
      }, initialMessage)
    } catch (err) {
      deps.setErrorMessage(`Chat error: ${extractErrorMessage(err)}`)
      deps.setAppState("error")
    }
  }

  function endChat(): void {
    deps.stopTimer()
    chatSession?.end()
    chatSession = null
  }

  function sendMessage(text: string): void {
    chatSession?.send(text)
  }

  function getChatSession(): ChatSession | null {
    return chatSession
  }

  return { chatWaiting, startChat, endChat, sendMessage, getChatSession }
}
