import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { formatQuestionChoiceAnswer, type AgentInputAnswer } from "../../../src/protocol/question-protocol-types.js"
import { questionRecordState } from "../../../src/protocol/client/question-settlement.js"

/** The wire form of one answered question, derived at submit. */
export type QuestionAnswer = AgentInputAnswer
export type FrontendQuestionBlock = Extract<FrontendOutputBlock, { kind: "question" }>
export type FrontendQuestionEntry = FrontendQuestionBlock["questions"][number]
interface NamedText { readonly [choiceId: string]: string }
/** What a person has picked for one question: the chosen options, and the
 *  text typed against any option that asked for some. */
export interface NamedSelectionState { readonly ids: readonly string[]; readonly text: NamedText }

export function applyNamedText(state: NamedSelectionState, choiceId: string, text: string, multiSelect: boolean): NamedSelectionState {
  const ids = text.trim() ? (multiSelect ? [...new Set([...state.ids, choiceId])] : [choiceId]) : state.ids.filter((id) => id !== choiceId)
  return { ids, text: { ...state.text, [choiceId]: text } }
}

/** The answer a question's current state amounts to, or nothing while it is
 *  incomplete: an option that requires text is not an answer until the text
 *  is there (PI-INTERACTION-004). Freeform text wins over picked options. */
export function resolveQuestionAnswer(question: FrontendQuestionEntry, state: NamedSelectionState | undefined, other: string | undefined): QuestionAnswer | undefined {
  const freeform = other?.trim()
  if (freeform) return { kind: "freeform", text: freeform }
  if (!state || state.ids.length === 0) return undefined
  const selections = state.ids.map((choiceId) => {
    const text = state.text[choiceId]?.trim()
    return { choiceId, ...(text ? { text } : {}) }
  })
  const declared = new Map(question.choices.flatMap((choice) => choice.kind === "option" && choice.choiceId ? [[choice.choiceId, choice] as const] : []))
  if (selections.some((selection) => !declared.has(selection.choiceId) || (declared.get(selection.choiceId)?.requiresText && !selection.text))) return undefined
  return { kind: "choice", selections, text: formatQuestionChoiceAnswer(question, selections) }
}

/** One row of the transcript's record of a resolved question. Mirrors the
 *  TUI: the question's title where a tool name goes, the answer as the detail,
 *  and a question the person cancelled or skipped ending as an error row. */
export interface QuestionRecordRow {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly status: "completed" | "error"
}

export function questionRecordRows(block: FrontendQuestionBlock): QuestionRecordRow[] {
  return block.questions.map((question, index) => {
    const record = questionRecordState(block, question.question)
    const row = { id: `${block.toolUseId}#q${index}`, title: question.header ?? question.question }
    if (record.kind === "answered") return { ...row, detail: record.text, status: "completed" }
    return record.kind === "cancelled"
      ? { ...row, detail: "Cancelled", status: "error" }
      : { ...row, detail: "(unanswered)", status: "completed" }
  })
}
