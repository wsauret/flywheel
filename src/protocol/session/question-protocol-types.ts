import { Schema } from "effect"
import type { QuestionBlock } from "../../infra/substrate/events/output-blocks.js"
import type { RuntimePosition, RuntimeSessionCursorIdentity, RuntimeSessionViewsResult, RuntimeUiPatchPayload } from "../runtime/runtime-ui-protocol-types.js"

export type PendingQuestionView = QuestionBlock

/** One question's answer, resolved against the choices declared by the question. */
export const AgentInputAnswerSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("choice"),
    selections: Schema.Array(Schema.Struct({
      choiceId: Schema.String,
      text: Schema.optionalKey(Schema.String),
    })),
    /** Complete model-visible rendering of the selected named options. */
    text: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("freeform"), text: Schema.String }),
])

export type AgentInputAnswer = typeof AgentInputAnswerSchema.Type

export type AgentInputChoiceSelection = Extract<AgentInputAnswer, { kind: "choice" }>["selections"][number]

/** Derives the model-visible text for selected named options in selection order. */
export function formatQuestionChoiceAnswer(question: QuestionBlock["questions"][number], selections: readonly AgentInputChoiceSelection[]): string {
  const options = new Map(question.choices.flatMap((choice) => choice.kind === "option" && choice.choiceId ? [[choice.choiceId, choice] as const] : []))
  return selections.map((selection) => {
    const option = options.get(selection.choiceId)
    if (!option) throw new Error(`Question does not declare choice "${selection.choiceId}".`)
    const text = selection.text?.trim()
    return text ? `${option.label}: ${text}` : option.label
  }).join(", ")
}
export interface AgentInputAnswers { readonly [question: string]: AgentInputAnswer }
export interface AgentInputAnswerText { readonly [question: string]: string }

/** Converts canonical answers into the text rendered below a settled question. */
export function formatAgentInputAnswers(answers: AgentInputAnswers): AgentInputAnswerText {
  return Object.fromEntries(Object.entries(answers).map(([question, answer]) => [
    question,
    answer.kind === "freeform" ? `Other: ${answer.text}` : answer.text,
  ]))
}

export type RuntimeQuestionSnapshotResult = RuntimeSessionViewsResult<PendingQuestionView>

export type QuestionPatchPayload =
  | { readonly kind: "question.updated"; readonly question: PendingQuestionView }
  | { readonly kind: "question.removed" }

export function questionCursor(sessionId: string): RuntimeSessionCursorIdentity & { readonly domain: "question" } {
  return { scope: "session", domain: "question", sessionId }
}

export function isQuestionPayload(payload: RuntimeUiPatchPayload): payload is QuestionPatchPayload {
  return payload.kind === "question.updated" || payload.kind === "question.removed"
}

/** A session that waits on a question, and when the question that its dock
 *  shows opened. No question text: a client that lists a session reads no
 *  question for it. */
export interface WaitingSession {
  readonly sessionId: string
  readonly openedAt: number
}

/** The sessions of the project that wait on a question, closed ones included
 *  (ARCH-PROTOCOL-068). A client joins them with the rows it lists, so a
 *  deleted session, a subagent, or a workflow agent in the set shows nowhere. */
export interface WaitingSessionsView {
  readonly sessions: readonly WaitingSession[]
}

export interface RuntimeWaitingSessionsSnapshotResult extends WaitingSessionsView {
  readonly snapshotPosition: RuntimePosition
}

/** One patch carries the whole set, so the newest supersedes any it overtook. */
export type WaitingSessionsPatchPayload = { readonly kind: "waitingSessions.changed"; readonly sessions: readonly WaitingSession[] }

export function waitingSessionsCursor() {
  return { scope: "workspace", domain: "waitingSessions" } as const
}
