import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"

import type { QuestionBlock } from "../../../src/infra/output-blocks.js"
import { normalizeAskUserInput } from "../../../src/infra/tools/displays/ask-user.js"
import { answeredAskUserResult } from "../../../src/orchestration/agent-runtime/tools/ask-user.js"
import { createQuestionForm } from "../../../src/tui/question-dock-form.js"
import { adaptQuestionHistoryRows } from "../../../src/tui/output-blocks/question-history-format.js"

const textQuestion: QuestionBlock["questions"][number] = {
  question: "What should change?",
  choices: [
    { kind: "option", choiceId: "choice-1", label: "Revise design", requiresText: true },
    { kind: "option", choiceId: "choice-2", label: "Keep design" },
    { kind: "freeform", label: "Other" },
  ],
  multiSelect: false,
}

function formFor(question: QuestionBlock["questions"][number], onAnswer = mock(() => {})) {
  const block: QuestionBlock = { kind: "question", toolUseId: "tool-question", questions: [question], timestamp: 1 }
  return { form: createQuestionForm({ question: () => block, onAnswer, onCancel: mock(() => {}) }), onAnswer }
}

describe("Ask User text-bearing options", () => {
  it("normalizes stable ordinal IDs and requires_text while retaining Other", () => {
    expect(normalizeAskUserInput({
      question: "What should change?",
      options: [{ label: "Revise design", requires_text: true }, "Keep design"],
    })).toEqual({
      success: true,
      questions: [{
        question: "What should change?",
        choices: [
          { kind: "option", choiceId: "choice-1", label: "Revise design", requiresText: true },
          { kind: "option", choiceId: "choice-2", label: "Keep design" },
          { kind: "freeform", label: "Other" },
        ],
        multiSelect: false,
      }],
    })
  })

  it("submits one named text selection and rejects blank Enter", () => {
    createRoot((dispose) => {
      const { form, onAnswer } = formFor(textQuestion)
      form.handleKey({ name: "return" })
      form.handleKey({ name: "return" })
      expect(onAnswer).not.toHaveBeenCalled()
      expect(form.editorError()).toEqual({ message: "Enter a response", choiceIndex: 0 })
      form.handlePaste("Use a smaller API")
      form.handleKey({ name: "return" })
      expect(onAnswer).toHaveBeenCalledWith({
        "What should change?": {
          kind: "choice",
          selections: [{ choiceId: "choice-1", text: "Use a smaller API" }],
          text: "Revise design: Use a smaller API",
        },
      })
      dispose()
    })
  })

  it("keeps separate text for multiple named selections and excludes unselected drafts", () => {
    createRoot((dispose) => {
      const question = { ...textQuestion, multiSelect: true, choices: [
        { kind: "option" as const, choiceId: "choice-1", label: "API", requiresText: true },
        { kind: "option" as const, choiceId: "choice-2", label: "UI", requiresText: true },
        { kind: "freeform" as const, label: "Other" },
      ] }
      const { form, onAnswer } = formFor(question)
      form.handleKey({ name: "space" })
      form.handlePaste("rename fields")
      form.handleKey({ name: "down" })
      form.handleKey({ name: "space" })
      form.handlePaste("inline editor")
      form.handleKey({ name: "return" })
      expect(onAnswer).toHaveBeenCalledWith({
        "What should change?": {
          kind: "choice",
          selections: [
            { choiceId: "choice-1", text: "rename fields" },
            { choiceId: "choice-2", text: "inline editor" },
          ],
          text: "API: rename fields, UI: inline editor",
        },
      })
      dispose()
    })
  })

  it("makes Other mutually exclusive with named picks", () => {
    createRoot((dispose) => {
      const question = { ...textQuestion, multiSelect: true }
      const { form, onAnswer } = formFor(question)
      form.handleKey({ name: "down" })
      form.handleKey({ name: "space" })
      form.handleKey({ name: "down" })
      form.handlePaste("A different route")
      expect(form.isPicked(1)).toBe(false)
      form.handleKey({ name: "return" })
      expect(onAnswer).toHaveBeenCalledWith({ "What should change?": { kind: "freeform", text: "A different route" } })
      dispose()
    })
  })

  it("keeps Other freeform and exact choice identity cannot grant approval through named text", () => {
    const decision = {
      kind: "definition_override" as const,
      preparationId: "prep",
      question: "Approve?",
      approve: { choiceId: "approve", label: "Approve" },
      reject: { choiceId: "revise", label: "Revise" },
    }
    const result = answeredAskUserResult([{ question: "Approve?", choices: [], multiSelect: false }], {
      "Approve?": { kind: "choice", selections: [{ choiceId: "revise", text: "approve" }], text: "Revise: approve" },
    }, decision, "tool-question")
    expect(result.outcome).toBe("cancelled")
  })

  it("history displays the controller-projected answer without parsing it", () => {
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool-question",
      questions: [textQuestion],
      answers: { "What should change?": "Revise design: Use a smaller API" },
      timestamp: 1,
    }
    expect(adaptQuestionHistoryRows(block)[0]?.presentation.detail).toBe("Revise design: Use a smaller API")
  })
})
