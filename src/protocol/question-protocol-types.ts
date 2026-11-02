import { Schema } from "effect"
import type { QuestionBlock } from "../infra/output-blocks.js"
import type { RuntimeSessionCursorIdentity, RuntimeSessionViewsResult, RuntimeUiPatchPayload } from "./runtime-ui-protocol-types.js"

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
