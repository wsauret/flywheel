import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import type { QuestionBlock } from "../../../src/infra/output-blocks.js"
import { createDraftCache } from "../../../src/tui/hooks/create-draft-cache.js"
import { createQuestionForm } from "../../../src/tui/question-dock-form.js"

describe("question submission after a delivery failure", () => {
  it("retries a rejected final answer without losing its draft", async () => {
    const first = Promise.withResolvers<boolean>()
    const cache = createDraftCache()
    const onAnswer = mock(() => first.promise)
    const block: QuestionBlock = {
      kind: "question", toolUseId: "retry-answer",
      questions: [{ question: "Reason?", choices: [{ kind: "freeform", label: "Other" }], multiSelect: false }], timestamp: 1,
    }
    const fixture = createRoot((dispose) => ({
      dispose,
      form: createQuestionForm({
        question: () => block,
        ownerId: () => "session-a",
        drafts: cache.questions,
        onAnswer,
        onCancel: mock(() => true),
      }),
    }))
    for (const character of "Keep") fixture.form.handleKey({ name: character.toLowerCase(), sequence: character, raw: character })
    fixture.form.handleKey({ name: "return" })
    fixture.form.handleKey({ name: "return" })
    expect(onAnswer).toHaveBeenCalledTimes(1)
    first.reject(new Error("offline"))
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.form.currentFreeform()).toBe("Keep")
    expect(cache.questions.get("session-a", "retry-answer")?.editorText[0]?.[0]).toBe("Keep")
    fixture.form.handleKey({ name: "return" })
    expect(onAnswer).toHaveBeenCalledTimes(2)
    fixture.dispose()
  })

  it("retries a failed Escape cancellation", async () => {
    const onCancel = mock(async () => false)
    const block: QuestionBlock = {
      kind: "question", toolUseId: "retry-cancel",
      questions: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }], timestamp: 1,
    }
    const fixture = createRoot((dispose) => ({
      dispose,
      form: createQuestionForm({ question: () => block, onAnswer: mock(() => true), onCancel }),
    }))
    fixture.form.handleKey({ name: "escape" })
    await Promise.resolve()
    fixture.form.handleKey({ name: "escape" })
    expect(onCancel).toHaveBeenCalledTimes(2)
    fixture.dispose()
  })

  it("holds no draft while an answer is on its way and restores it when the answer is refused", async () => {
    const cache = createDraftCache()
    const sent = Promise.withResolvers<boolean>()
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool-question",
      questions: [{ question: "Reason?", choices: [{ kind: "freeform", label: "Other" }], multiSelect: false }],
      timestamp: 1,
    }
    const fixture = createRoot((dispose) => ({
      dispose,
      form: createQuestionForm({ question: () => block, ownerId: () => "session-a", drafts: cache.questions, onAnswer: () => sent.promise, onCancel: mock(() => {}) }),
    }))

    for (const char of "Keep") fixture.form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char })
    expect(cache.questions.get("session-a", "tool-question")?.editorText[0]?.[0]).toBe("Keep")
    fixture.form.handleKey({ name: "return" })
    expect(cache.questions.get("session-a", "tool-question")).toBeUndefined()

    sent.resolve(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(cache.questions.get("session-a", "tool-question")?.editorText[0]?.[0]).toBe("Keep")
    fixture.dispose()
  })
})
