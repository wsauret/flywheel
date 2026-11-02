import { describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import type { QuestionBlock } from "../../../src/infra/output-blocks.js"
import { createDraftCache } from "../../../src/tui/hooks/create-draft-cache.js"
import { createQuestionForm } from "../../../src/tui/question-dock-form.js"

describe("createQuestionForm", () => {
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

  it("multi-select Enter with nothing picked selects the highlighted option and submits, never cancels", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Features?", ["Dark mode", "Auto-save"], true)],
        timestamp: 1,
      }
      const form = createQuestionForm({
        question: () => block,
        onAnswer,
        onCancel,
      })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).toHaveBeenCalledWith({ "Features?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "Dark mode" } })
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("submits an answer only once while the answered question remains mounted", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Continue?", ["Yes"])],
        timestamp: 1,
      }
      const form = createQuestionForm({
        question: () => block,
        onAnswer,
        onCancel,
      })

      form.handleKey({ name: "return" })
      form.handleKey({ name: "return" })
      form.handleKey({ name: "escape" })

      expect(onAnswer).toHaveBeenCalledTimes(1)
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("does not answer a cancelled question while it remains mounted", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Continue?", ["Yes"])],
        timestamp: 1,
      }
      const form = createQuestionForm({
        question: () => block,
        onAnswer,
        onCancel,
      })

      form.handleKey({ name: "escape" })
      form.handleKey({ name: "return" })

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onAnswer).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("accepts the next question after its tool use ID changes", async () => {
    const fixture = createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const [question, setQuestion] = createSignal<QuestionBlock>({
        kind: "question",
        toolUseId: "first-question",
        questions: [singleQuestion("First?", ["Yes"])],
        timestamp: 1,
      })
      const form = createQuestionForm({
        question,
        onAnswer,
        onCancel: mock(() => {}),
      })
      return { dispose, form, onAnswer, setQuestion }
    })
    await Promise.resolve()

    fixture.form.handleKey({ name: "return" })
    fixture.setQuestion({
      kind: "question",
      toolUseId: "second-question",
      questions: [singleQuestion("Second?", ["Yes"])],
      timestamp: 2,
    })
    fixture.form.handleKey({ name: "return" })

    expect(fixture.onAnswer).toHaveBeenCalledTimes(2)
    fixture.dispose()
  })

  it("restores Other and required option drafts after foreground question changes", async () => {
    const cache = createDraftCache()
    const first: QuestionBlock = {
      kind: "question",
      toolUseId: "first-question",
      questions: [
        singleQuestion("Scope?", ["API", "UI"], true),
        singleQuestion("Color?", ["Red"]),
      ],
      timestamp: 1,
    }
    const second: QuestionBlock = {
      kind: "question",
      toolUseId: "second-question",
      questions: [{
        question: "Reason?",
        choices: [
          { kind: "option", choiceId: "choice-1", label: "Explain", requiresText: true },
          { kind: "freeform", label: "Other" },
        ],
        multiSelect: false,
      }],
      timestamp: 2,
    }
    const fixture = createRoot((dispose) => {
      const [ownerId, setOwnerId] = createSignal("session-a")
      const [question, setQuestion] = createSignal(first)
      const form = createQuestionForm({
        question,
        ownerId,
        drafts: cache.questions,
        onAnswer: mock(() => {}),
        onCancel: mock(() => {}),
      })
      return { dispose, form, setOwnerId, setQuestion }
    })
    await Promise.resolve()

    fixture.form.handleKey({ name: "space" })
    fixture.form.handleKey({ name: "right" })
    fixture.form.handleKey({ name: "up" })
    for (const character of "Amber") fixture.form.handleKey({ name: character.toLowerCase(), sequence: character, raw: character })

    fixture.setOwnerId("session-b")
    fixture.setQuestion(second)
    for (const character of "Because") fixture.form.handleKey({ name: character.toLowerCase(), sequence: character, raw: character })

    fixture.setOwnerId("session-a")
    fixture.setQuestion(first)
    expect(fixture.form.tab()).toBe(1)
    expect(fixture.form.currentFreeform()).toBe("Amber")
    expect(fixture.form.isPicked(1)).toBe(true)
    fixture.form.handleKey({ name: "up" })
    fixture.form.handleKey({ name: "left" })
    expect(fixture.form.isPicked(0)).toBe(true)

    fixture.setOwnerId("session-b")
    fixture.setQuestion(second)
    expect(fixture.form.editorPresentation(0).value).toBe("Because")
    expect(fixture.form.isPicked(0)).toBe(true)
    fixture.dispose()
  })

  it("does not publish drafts after answer or cancel settlement", () => {
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool-question",
      questions: [singleQuestion("Continue?", ["Yes"])],
      timestamp: 1,
    }

    for (const settleWith of ["answer", "cancel"] as const) {
      const changes = mock(() => {})
      createRoot((dispose) => {
        const form = createQuestionForm({
          question: () => block,
          ownerId: () => "session-a",
          drafts: { ...createDraftCache().questions, set: changes },
          onAnswer: mock(() => {}),
          onCancel: mock(() => {}),
        })

        form.handleKey({ name: settleWith === "answer" ? "return" : "escape" })
        const countAtSettlement = changes.mock.calls.length
        form.handleKey({ name: "down" })
        form.handleKey({ name: "return" })

        expect(changes).toHaveBeenCalledTimes(countAtSettlement)
        dispose()
      })
    }
  })

  it("persists a number shortcut that focuses Other before text is entered", () => {
    createRoot((dispose) => {
      const changes = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Continue?", ["Yes"])],
        timestamp: 1,
      }
      const form = createQuestionForm({
        question: () => block,
        ownerId: () => "session-a",
        drafts: { ...createDraftCache().questions, set: changes },
        onAnswer: mock(() => {}),
        onCancel: mock(() => {}),
      })

      form.handleKey({ name: "2" })

      expect(changes).toHaveBeenLastCalledWith("session-a", "tool-question", expect.objectContaining({ cursor: 1 }))
      dispose()
    })
  })

  it("multi-select Enter keeps the toggled set when the cursor sits on an unpicked option", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Features?", ["Dark mode", "Auto-save"], true)],
        timestamp: 1,
      }
      const form = createQuestionForm({
        question: () => block,
        onAnswer,
        onCancel,
      })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "space", preventDefault })
      form.handleKey({ name: "down", preventDefault })
      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).toHaveBeenCalledWith({ "Features?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "Dark mode" } })
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("multi-select Enter on a non-final question advances instead of submitting a partial record", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [
          singleQuestion("Features?", ["Dark mode", "Auto-save"], true),
          singleQuestion("Color?", ["Red", "Blue"]),
        ],
        timestamp: 1,
      }
      const form = createQuestionForm({
        question: () => block,
        onAnswer,
        onCancel,
      })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).not.toHaveBeenCalled()
      expect(form.tab()).toBe(1)

      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).toHaveBeenCalledWith({
        "Features?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "Dark mode" },
        "Color?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "Red" },
      })
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("types and submits Other without activation", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Color?", ["Red", "Blue"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      form.handleKey({ name: "down", preventDefault })
      for (const char of "Amber") {
        form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char, preventDefault })
      }
      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).toHaveBeenCalledWith({ "Color?": { kind: "freeform", text: "Amber" } })
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("edits Other at the caret and inserts line breaks with Shift+Enter", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Color?", ["Red"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel: mock(() => {}) })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      for (const char of "AC") form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char, preventDefault })
      form.handleKey({ name: "left", preventDefault })
      form.handleKey({ name: "b", sequence: "B", raw: "B", preventDefault })
      form.handleKey({ name: "return", shift: true, preventDefault })
      form.handleKey({ name: "d", sequence: "D", raw: "D", preventDefault })
      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).toHaveBeenCalledWith({ "Color?": { kind: "freeform", text: "AB\nDC" } })
      dispose()
    })
  })

  it("moves and deletes Other text by grapheme", () => {
    createRoot((dispose) => {
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Label?", ["Plain"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer: mock(() => {}), onCancel: mock(() => {}) })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      for (const text of ["A", "👨‍👩‍👧‍👦", "C"]) {
        form.handleKey({ name: text, sequence: text, raw: text, preventDefault })
      }
      form.handleKey({ name: "left", preventDefault })
      form.handleKey({ name: "backspace", preventDefault })

      expect(form.currentFreeform()).toBe("AC")
      dispose()
    })
  })

  it("uses modified arrows for Other selection while plain arrows navigate choices", () => {
    createRoot((dispose) => {
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Label?", ["Plain"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer: mock(() => {}), onCancel: mock(() => {}) })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      for (const char of "ABC") form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char, preventDefault })
      form.handleKey({ name: "left", shift: true, preventDefault })
      form.handleKey({ name: "left", shift: true, preventDefault })

      expect(form.currentFreeformPresentation().selection).toEqual({ start: 1, end: 3 })
      expect(form.cursor()).toBe(1)

      form.handleKey({ name: "up", preventDefault })
      expect(form.cursor()).toBe(0)
      form.handleKey({ name: "down", preventDefault })
      form.handleKey({ name: "x", sequence: "X", raw: "X", preventDefault })

      expect(form.currentFreeform()).toBe("AX")
      dispose()
    })
  })

  it("keeps editor text and selection after a named choice becomes the answer", () => {
    createRoot((dispose) => {
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("First?", ["One"]), singleQuestion("Second?", ["Two"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer: mock(() => {}), onCancel: mock(() => {}) })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      for (const char of "ABC") form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char, preventDefault })
      form.handleKey({ name: "left", shift: true, preventDefault })
      form.handleKey({ name: "up", preventDefault })
      form.handleKey({ name: "return", preventDefault })
      form.handleKey({ name: "left", preventDefault })
      form.handleKey({ name: "down", preventDefault })

      expect(form.currentFreeformPresentation().selection).toEqual({ start: 2, end: 3 })
      form.handleKey({ name: "x", sequence: "X", raw: "X", preventDefault })
      expect(form.currentFreeform()).toBe("ABX")
      dispose()
    })
  })

  it("uses rendered visual rows for modified vertical selection", () => {
    createRoot((dispose) => {
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Label?", ["Plain"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer: mock(() => {}), onCancel: mock(() => {}) })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      for (const char of "ABCD") form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char, preventDefault })
      form.setCurrentFreeformVisualLines([{ start: 0, end: 2 }, { start: 2, end: 4 }])
      form.handleKey({ name: "up", shift: true, preventDefault })

      expect(form.currentFreeformPresentation().selection).toEqual({ start: 2, end: 4 })
      form.handleKey({ name: "x", sequence: "X", raw: "X", preventDefault })
      expect(form.currentFreeform()).toBe("ABX")
      dispose()
    })
  })

  it("restores the cursor to the answered option when navigating back", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [
          singleQuestion("Stage?", ["Alpha", "Beta"]),
          singleQuestion("Owner?", ["Ada", "Linus"]),
        ],
        timestamp: 1,
      }
      const form = createQuestionForm({
        question: () => block,
        onAnswer,
        onCancel,
      })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      form.handleKey({ name: "return", preventDefault })
      expect(form.tab()).toBe(1)

      form.handleKey({ name: "left", preventDefault })

      expect(form.tab()).toBe(0)
      expect(form.cursor()).toBe(1)
      expect(form.isPicked(1)).toBe(true)
      expect(onAnswer).not.toHaveBeenCalled()
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("keeps typed Other text when a standard option becomes the answer", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Label?", ["Red", "Blue"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "up", preventDefault })
      for (const char of "Amber") {
        form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char, preventDefault })
      }
      form.handleKey({ name: "up", sequence: "[A", raw: "[A", preventDefault })

      expect(form.cursor()).toBe(1)
      expect(form.currentFreeform()).toBe("Amber")

      form.handleKey({ name: "return", preventDefault })

      expect(form.currentFreeform()).toBe("Amber")
      expect(form.isPicked(2)).toBe(false)
      expect(onAnswer).toHaveBeenCalledWith({ "Label?": { kind: "choice", selections: [{ choiceId: "choice-2" }], text: "Blue" } })
      expect(onCancel).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("keeps typed Other text while multi-select toggles named options", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Fruit?", ["Apple", "Cherry"], true)],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel: mock(() => {}) })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "up", preventDefault })
      for (const char of "Mango") form.handleKey({ name: char.toLowerCase(), sequence: char, raw: char, preventDefault })
      form.handleKey({ name: "up", preventDefault })
      form.handleKey({ name: "space", preventDefault })
      form.handleKey({ name: "space", preventDefault })

      expect(form.currentFreeform()).toBe("Mango")
      expect(form.isPicked(1)).toBe(false)
      expect(form.isPicked(2)).toBe(false)
      form.handleKey({ name: "down", preventDefault })
      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).toHaveBeenCalledWith({ "Fruit?": { kind: "freeform", text: "Mango" } })
      dispose()
    })
  })

  it("rejects an empty Other answer and clears validation after navigation", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Label?", ["Red"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel: mock(() => {}) })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "down", preventDefault })
      form.handleKey({ name: "return", preventDefault })

      expect(onAnswer).not.toHaveBeenCalled()
      expect(form.editorError()).toEqual({ message: "Enter a response", choiceIndex: 1 })

      form.handleKey({ name: "up", preventDefault })

      expect(form.editorError()).toBeUndefined()
      dispose()
    })
  })

  it("picks an option directly via its number shortcut and advances", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Color?", ["Red", "Blue", "Green"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel })
      const preventDefault = mock(() => {})

      form.handleKey({ name: "2", preventDefault })

      expect(onAnswer).toHaveBeenCalledWith({ "Color?": { kind: "choice", selections: [{ choiceId: "choice-2" }], text: "Blue" } })
      dispose()
    })
  })

  it("routes paste only while Other has focus", () => {
    createRoot((dispose) => {
      const onAnswer = mock(() => {})
      const onCancel = mock(() => {})
      const block: QuestionBlock = {
        kind: "question",
        toolUseId: "tool-question",
        questions: [singleQuestion("Label?", ["Red"])],
        timestamp: 1,
      }
      const form = createQuestionForm({ question: () => block, onAnswer, onCancel })
      const preventDefault = mock(() => {})

      form.handlePaste("ignored")
      expect(form.currentFreeform()).toBe("")

      form.handleKey({ name: "down", preventDefault })
      form.handlePaste("pasted answer")
      expect(form.currentFreeform()).toBe("pasted answer")

      form.handleKey({ name: "up", preventDefault })
      form.handlePaste(" ignored")
      expect(form.currentFreeform()).toBe("pasted answer")
      dispose()
    })
  })
})
