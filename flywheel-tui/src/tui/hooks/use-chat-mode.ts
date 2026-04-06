import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { startChatSession, type ChatSession } from "../chat.js"
import { formatElapsed, formatCost, formatTokens } from "../format.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { AnyBlock } from "../types.js"
import type { AgentState, SessionStatus } from "./use-workflow-lifecycle.js"

export interface ChatModeDeps {
  setAgentState: (state: AgentState) => void
  setSessionStatus: (status: SessionStatus) => void
  setOutputBlocks: (blocks: AnyBlock[]) => void
  setSteps: (steps: never[]) => void
  setErrorMessage: (msg: string) => void
  setStatusLine: (line: string) => void
  setSessionTitle: (title: string) => void
  setTerminalTitle: (title: string) => void
  resetMetrics: () => void
  workStartTime: Accessor<number>
  setTokens: (n: number) => void
  setCost: (n: number) => void
  setActivity: (a: "idle" | "thinking" | "generating" | "tool_executing") => void
}

export interface ChatModeHook {
  /** True while a chat session is open (regardless of whose turn it is). */
  chatActive: Accessor<boolean>
  startChat(initialMessage?: string): Promise<void>
  interruptChat(): void
  endChat(): void
  sendMessage(text: string): void
  getChatSession(): ChatSession | null
}

export function useChatMode(deps: ChatModeDeps): ChatModeHook {
  const [chatActive, setChatActive] = createSignal(false)
  let chatSession: ChatSession | null = null

  async function startChat(initialMessage?: string): Promise<void> {
    setChatActive(true)
    deps.setAgentState("active")     // show "Starting worker..." while spawning
    deps.setSessionStatus("running") // session is live from this point
    deps.setOutputBlocks([])
    deps.setSteps([])
    deps.setErrorMessage("")
    deps.setStatusLine("")
    deps.setSessionTitle("Chat")
    deps.resetMetrics()
    deps.setTerminalTitle("flywheel · chat")

    try {
      chatSession = await startChatSession({
        onBlocksChanged: deps.setOutputBlocks,
        onWaitingChanged: (waiting) => {
          deps.setAgentState(waiting ? "active" : "idle")
          // sessionStatus stays "running" — only the agent's activity changes
        },
        onTokensChanged: deps.setTokens,
        onCostChanged: deps.setCost,
        onModelActivity: deps.setActivity,
        onError: (msg) => { deps.setErrorMessage(msg); deps.setAgentState("idle"); deps.setSessionStatus("error") },
        onEnded: () => {
          if (!chatActive()) return
          const cost = chatSession?.budgetTracker.getTotalCost() ?? 0
          const tokens = chatSession?.budgetTracker.getTokensUsed() ?? 0
          deps.setStatusLine(`Chat ended · ${formatElapsed(Date.now() - deps.workStartTime())} · ${formatCost(cost)} · ${formatTokens(tokens)} tokens`)
          chatSession = null
          setChatActive(false)
          deps.setAgentState("idle")
          deps.setSessionStatus("completed")
          deps.setTerminalTitle("flywheel · done")
        },
      }, initialMessage)
      // Worker is spawned. If no initial message was sent, the agent is now
      // idle waiting for user input — clear the "Starting worker..." indicator.
      if (!initialMessage?.trim()) deps.setAgentState("idle")
    } catch (err) {
      deps.setErrorMessage(`Chat error: ${extractErrorMessage(err)}`)
      setChatActive(false)
      deps.setAgentState("idle")
      deps.setSessionStatus("error")
    }
  }

  function interruptChat(): void {
    chatSession?.interrupt()
  }

  function endChat(): void {
    chatSession?.end()
    chatSession = null
  }

  function sendMessage(text: string): void {
    chatSession?.send(text)
  }

  function getChatSession(): ChatSession | null {
    return chatSession
  }

  return { chatActive, startChat, interruptChat, endChat, sendMessage, getChatSession }
}
