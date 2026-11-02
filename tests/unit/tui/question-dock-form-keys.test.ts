import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"

import type { QuestionBlock } from "../../../src/infra/output-blocks.js"
import { createQuestionForm } from "../../../src/tui/question-dock-form.js"

function singleQuestion(prompt: string, labels: string[], multi = false): QuestionBlock["questions"][number] {
  return {
    question: prompt,
    choices: [
      ...labels.map((label, index) => ({ kind: "option" as const, choiceId: `choice-${index + 1}`, label })),
      { kind: "freeform" as const, label: "Other" },
    ],
    multiSelect: multi,
  }
}

describe("question dock Escape and number keys", () => {
  it("keeps the answer already given when Escape skips a later question", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Option?", ["A", "B"]), singleQuestion("Filename?", ["one.txt", "two.txt"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel })

      form.handleKey({ name: "return" })
      expect(form.tab()).toBe(1)
      form.handleKey({ name: "escape" })

      expect(onAnswer).toHaveBeenCalledWith({ "Option?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "A" } })
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("cancels the call when Escape skips the only question, even with a pick", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Features?", ["Dark mode", "Auto-save"], true)],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel })

      form.handleKey({ name: "space" })
      form.handleKey({ name: "escape" })

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onAnswer).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("selects a later option by its number while an empty text option has focus", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [{
          question: "Remote?",
          choices: [
            { kind: "option", choiceId: "choice-1", label: "Provide remote URL", requiresText: true },
            { kind: "option", choiceId: "choice-2", label: "Leave uncommitted" },
            { kind: "freeform", label: "Other" },
          ],
          multiSelect: false,
        }],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel: mock(() => {}) })

      form.handleKey({ name: "2", sequence: "2", raw: "2" })

      expect(form.editorPresentation(0).value).toBe("")
      expect(onAnswer).toHaveBeenCalledWith({ "Remote?": { kind: "choice", selections: [{ choiceId: "choice-2" }], text: "Leave uncommitted" } })
      dispose()
    })
  })

  it("types a digit as text once the focused text option holds text", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Port?", ["Default"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel: mock(() => {}) })

      form.handleKey({ name: "down" })
      for (const char of "p1") form.handleKey({ name: char, sequence: char, raw: char })

      expect(form.currentFreeform()).toBe("p1")
      expect(onAnswer).not.toHaveBeenCalled()
      dispose()
    })
  })
})
