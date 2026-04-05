import { describe, it, expect } from "bun:test"
import {
  createInitialStore,
  isTextOnly,
  hasCustom,
  optionCount,
  isSingle,
  selectTab,
  commitCustom,
  moveTo,
  type QuestionStore,
} from "../src/tui/components/question-prompt-logic"
import type { QuestionInfo } from "../src/workflows/queue/question-service"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOnlyQuestion(overrides: Partial<QuestionInfo> = {}): QuestionInfo {
  return {
    question: "What do you want to build?",
    header: "Description",
    options: [],
    textOnly: true,
    ...overrides,
  }
}

function optionsQuestion(overrides: Partial<QuestionInfo> = {}): QuestionInfo {
  return {
    question: "Pick a mode",
    header: "Mode",
    options: [
      { label: "A", description: "Option A" },
      { label: "B", description: "Option B" },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// isTextOnly
// ---------------------------------------------------------------------------

describe("isTextOnly", () => {
  it("returns true for textOnly questions", () => {
    expect(isTextOnly(textOnlyQuestion())).toBe(true)
  })

  it("returns false for regular questions", () => {
    expect(isTextOnly(optionsQuestion())).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(isTextOnly(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hasCustom — textOnly questions should NOT have custom option
// ---------------------------------------------------------------------------

describe("hasCustom with textOnly", () => {
  it("returns false for textOnly questions even if custom is not set", () => {
    expect(hasCustom(textOnlyQuestion())).toBe(false)
  })

  it("returns false for textOnly questions even if custom is true", () => {
    expect(hasCustom(textOnlyQuestion({ custom: true }))).toBe(false)
  })

  it("returns true for regular questions by default", () => {
    expect(hasCustom(optionsQuestion())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// optionCount — textOnly questions should have 0 options
// ---------------------------------------------------------------------------

describe("optionCount with textOnly", () => {
  it("returns 0 for textOnly questions", () => {
    expect(optionCount(textOnlyQuestion())).toBe(0)
  })

  it("returns options.length + 1 (custom) for regular questions", () => {
    // 2 options + 1 custom = 3
    expect(optionCount(optionsQuestion())).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// createInitialStore — textOnly starts in editing mode
// ---------------------------------------------------------------------------

describe("createInitialStore with textOnly", () => {
  it("starts in editing mode for textOnly first question", () => {
    const store = createInitialStore([textOnlyQuestion()])
    expect(store.editing).toBe(true)
    expect(store.tab).toBe(0)
    expect(store.selected).toBe(0)
  })

  it("starts NOT in editing mode for regular first question", () => {
    const store = createInitialStore([optionsQuestion()])
    expect(store.editing).toBe(false)
  })

  it("starts in editing mode when first of multiple questions is textOnly", () => {
    const store = createInitialStore([textOnlyQuestion(), optionsQuestion()])
    expect(store.editing).toBe(true)
  })

  it("starts NOT in editing mode when first of multiple is regular", () => {
    const store = createInitialStore([optionsQuestion(), textOnlyQuestion()])
    expect(store.editing).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// selectTab — switching to textOnly tab sets editing
// ---------------------------------------------------------------------------

describe("selectTab with textOnly", () => {
  it("sets editing when switching to a textOnly tab", () => {
    const questions = [optionsQuestion(), textOnlyQuestion()]
    const result = selectTab(questions, 1)
    expect(result.tab).toBe(1)
    expect(result.editing).toBe(true)
  })

  it("does not set editing when switching to a regular tab", () => {
    const questions = [textOnlyQuestion(), optionsQuestion()]
    const result = selectTab(questions, 1)
    expect(result.tab).toBe(1)
    expect(result.editing).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// commitCustom — textOnly text submission uses fast path for single question
// ---------------------------------------------------------------------------

describe("commitCustom with textOnly", () => {
  it("submits text as answer via fast path for single textOnly question", () => {
    const questions = [textOnlyQuestion()]
    const store: QuestionStore = {
      tab: 0,
      answers: [[]],
      custom: ["hello world"],
      selected: 0,
      editing: true,
    }
    const result = commitCustom(store, questions, "hello world")
    expect(result.fastPath).toBe(true)
    expect(result.patch.answers?.[0]).toEqual(["hello world"])
    expect(result.patch.editing).toBe(false)
  })

  it("rejects empty text (returns editing: false, no fast path)", () => {
    const questions = [textOnlyQuestion()]
    const store: QuestionStore = {
      tab: 0,
      answers: [[]],
      custom: [""],
      selected: 0,
      editing: true,
    }
    const result = commitCustom(store, questions, "")
    expect(result.fastPath).toBe(false)
    expect(result.patch.editing).toBe(false)
  })

  it("advances to next tab for multi-question textOnly", () => {
    const questions = [textOnlyQuestion(), optionsQuestion()]
    const store: QuestionStore = {
      tab: 0,
      answers: [[], []],
      custom: ["my feature", ""],
      selected: 0,
      editing: true,
    }
    const result = commitCustom(store, questions, "my feature")
    expect(result.fastPath).toBe(false)
    expect(result.patch.answers?.[0]).toEqual(["my feature"])
    expect(result.patch.tab).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// moveTo — textOnly with 0 options wraps correctly
// ---------------------------------------------------------------------------

describe("moveTo with textOnly", () => {
  it("returns selected 0 when optionCount is 0", () => {
    const result = moveTo(textOnlyQuestion(), 5)
    expect(result.selected).toBe(0)
  })
})
