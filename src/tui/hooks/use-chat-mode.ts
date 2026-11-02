import type { MutationResult, RuntimeClient } from "../../protocol/app-service-types.js"
import { dispatchInterrupt } from "../../protocol/client/session-controls.js"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"

interface QuestionAnswers {
  [question: string]: AgentInputAnswer
}

interface ChatModeDeps {
  signals: Pick<ShellSignals, "foregroundId">
  appService: Pick<RuntimeClient, "dispatch">
  showToast: ShellServices["showToast"]
}

export interface ChatModeHook {
  interruptChat(): void
  answerQuestion(toolUseId: string, answers: QuestionAnswers): Promise<boolean>
  cancelQuestion(toolUseId: string): Promise<boolean>
  compactConversation(): Promise<boolean>
}

export function useChatMode(deps: ChatModeDeps): ChatModeHook {
  const { signals, appService, showToast } = deps

  function reportFailure(result: MutationResult): void {
    if (!result.ok) showToast({ message: result.error, variant: "error" })
  }

  function interruptChat(): void {
    const sessionId = signals.foregroundId()
    if (!sessionId) return
    void dispatchInterrupt(appService, { id: sessionId, kind: "chat" }).then((refusal) => {
      if (refusal) showToast({ message: `Interrupt failed: ${refusal.reason}`, variant: refusal.variant })
    })
  }

  async function answerQuestion(toolUseId: string, answers: QuestionAnswers): Promise<boolean> {
    const sessionId = signals.foregroundId()
    if (!sessionId) return false
    try {
      const result = await appService.dispatch({ type: "question.answer", sessionId, toolUseId, answers })
      reportFailure(result)
      return result.ok
    } catch (error) {
      showToast({ message: `Question answer failed: ${String(error)}`, variant: "error" })
      return false
    }
  }

  async function cancelQuestion(toolUseId: string): Promise<boolean> {
    const sessionId = signals.foregroundId()
    if (!sessionId) return false
    try {
      const result = await appService.dispatch({ type: "question.cancel", sessionId, toolUseId })
      reportFailure(result)
      return result.ok
    } catch (error) {
      showToast({ message: `Question cancel failed: ${String(error)}`, variant: "error" })
      return false
    }
  }

  async function compactConversation(): Promise<boolean> {
    const sessionId = signals.foregroundId()
    if (!sessionId) return false
    const result = await appService.dispatch({ type: "chat.compact", sessionId })
    if (!result.ok && result.error !== "No active context to compact yet") showToast({ message: result.error, variant: "error" })
    return result.ok
  }

  return { interruptChat, answerQuestion, cancelQuestion, compactConversation }
}
