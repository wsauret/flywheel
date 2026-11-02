import { normalizeChatInput, type ChatInputLike } from "../../infra/chat-input.js"
import type { ChatSendResult } from "../chat/runner-types.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { durationMs } from "../../infra/operation-log.js"
import { Log } from "../../infra/log.js"
import { formatAgentInputAnswers, formatQuestionChoiceAnswer } from "../../protocol/question-protocol-types.js"
import type { OutputProjectionEvent } from "../../infra/output/output-projection-events.js"
import type { AgentInputEntry } from "../session/agent-input-projection.js"
import type { SessionFact } from "../session/session-fact-writer.js"
import type { AgentInputAnswers, DispatchOutcome, SessionMutation } from "./session-runtime-actor-types.js"
import type { SendChatOutcome } from "./runtime-supervisor-types.js"

type QuestionSettlement = Extract<SessionMutation, { kind: "question.answer" | "question.cancel" }>

/** The durable fact that records a person's answer or skip of one question. */
export function questionSettlementFact(interactionId: string, command: QuestionSettlement): SessionFact {
  return command.kind === "question.answer"
    ? { type: "agent_input.answered", version: 3, actor: "user", payload: { interactionId, answers: command.answers } }
    : { type: "agent_input.cancelled", version: 1, actor: "user", payload: { interactionId, reason: "user_cancelled" } }
}

/** The live display change that follows a committed answer or skip. */
export function questionSettlementDisplay(command: QuestionSettlement): OutputProjectionEvent {
  return command.kind === "question.answer"
    ? { type: "answer-question", toolUseId: command.toolUseId, answers: formatAgentInputAnswers(command.answers) }
    : { type: "cancel-question", toolUseId: command.toolUseId }
}

export function validAgentInputAnswers(
  entry: Extract<AgentInputEntry, { kind: "pending" }>,
  answers: AgentInputAnswers,
): boolean {
  // A skip settles the call with the answers the person gave, so a question
  // may have no answer. Every answer names a question the request asks.
  const asked = new Set(entry.request.map((question) => question.question))
  const answered = Object.keys(answers)
  if (answered.length === 0 || answered.some((question) => !asked.has(question))) return false
  return entry.request.every((question) => {
    const answer = answers[question.question]
    if (!answer) return true
    if (!answer.text.trim()) return false
    if (answer.kind === "freeform") return question.choices.some((choice) => choice.kind === "freeform")
    if (answer.selections.length === 0 || (!question.multiSelect && answer.selections.length !== 1)) return false
    const declared = new Map(question.choices.flatMap((choice) => choice.kind === "option" ? [[choice.choiceId, choice] as const] : []))
    const seen = new Set<string>()
    for (const selection of answer.selections) {
      if (seen.has(selection.choiceId)) return false
      seen.add(selection.choiceId)
      const option = declared.get(selection.choiceId)
      if (!option) return false
      if (option.requiresText) {
        if (!selection.text?.trim()) return false
      } else if (selection.text !== undefined) return false
    }
    return answer.text === formatQuestionChoiceAnswer(question, answer.selections)
  })
}

export function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
  return Promise.race([promise.catch(() => {}), timeout]).finally(() => clearTimeout(timer))
}

function dispatchResultSummary(result: DispatchOutcome): string {
  if (typeof result === "boolean") return result ? "true" : "false"
  if (result === null) return "null"
  if (typeof result !== "object") return "message"
  if ("ok" in result) return result.ok ? "ok" : "error"
  return "message"
}

export function chatInputParts(input: ChatInputLike): number {
  if (typeof input === "string") return 1
  return 1 + (input.attachments?.length ?? 0)
}

const log = Log.create({ service: "session-runtime-actor" })

/** Records the settled dispatch outcome without changing its result or rejection. */
export function observeSessionDispatch(sessionId: string, command: string, start: number, dispatched: Promise<DispatchOutcome>): Promise<DispatchOutcome> {
  return dispatched.then((result) => {
    log.debug("dispatch done", { sessionId, command, result: dispatchResultSummary(result), durationMs: durationMs(start) })
    return result
  }, (err: unknown) => {
    log.error("dispatch failed", { sessionId, command, durationMs: durationMs(start), error: errorMessage(err), errorDetail: errorDetail(err) })
    throw err
  })
}

export function unsavedMessageReason(cause: string): string {
  return `Chat message could not be saved: ${cause}`
}

/** The outcome of a send the runner took. Its save runs outside the actor's
 *  mailbox, so a store that waits on a lock never holds a close or another
 *  command behind it; the send's tail waits for the save instead. A message
 *  the runner found recorded answers its receipt. */
export function runnerSendOutcome(sessionId: string, input: ChatInputLike, sent: Promise<ChatSendResult>): Promise<SendChatOutcome> {
  return sent.then(
    (result): SendChatOutcome => result === "accepted" ? { ok: true }
      : result === "recorded" ? { ok: true, confirmedSubmissionIds: normalizeChatInput(input).submissionIds ?? [] }
        : { ok: false, reason: `Chat session ${sessionId} could not accept the message` },
    (error: unknown): SendChatOutcome => {
      const message = errorMessage(error)
      log.warn("chat message not saved", { sessionId, error: message })
      return { ok: false, reason: unsavedMessageReason(message) }
    },
  )
}
