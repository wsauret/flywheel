import { describe, it, expect, mock } from "bun:test"
import {
  createInitialStore,
  isSingle,
  tabCount,
  currentQuestion,
  isConfirmTab,
  isMulti,
  hasCustom,
  isOther,
  optionCount,
  moveTo,
  selectTab,
  toggleAnswer,
  pickAnswer,
  setCustomText,
  selectOption,
  commitCustom,
  buildFinalAnswers,
  submitAnswers,
  rejectQuestion,
  keyboardHints,
  type QuestionStore,
} from "../../src/tui/components/question-prompt-logic"
import type {
  QuestionInfo,
  QuestionRequest,
  QuestionService,
} from "../../src/workflows/queue/question-service"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const singleQuestion: QuestionInfo[] = [
  {
    question: "Pick a color",
    header: "Color",
    options: [
      { label: "Red", description: "A warm color" },
      { label: "Blue", description: "A cool color" },
    ],
  },
]

const singleMultiSelect: QuestionInfo[] = [
  {
    question: "Pick colors",
    header: "Colors",
    options: [
      { label: "Red", description: "A warm color" },
      { label: "Blue", description: "A cool color" },
      { label: "Green", description: "A natural color" },
    ],
    multiple: true,
  },
]

const multiQuestion: QuestionInfo[] = [
  {
    question: "Pick a framework",
    header: "Framework",
    options: [
      { label: "React", description: "Popular" },
      { label: "Solid", description: "Fast" },
    ],
  },
  {
    question: "Pick a language",
    header: "Language",
    options: [
      { label: "TypeScript", description: "Typed" },
      { label: "JavaScript", description: "Dynamic" },
    ],
  },
]

const questionWithCustom: QuestionInfo[] = [
  {
    question: "Pick a tool",
    header: "Tool",
    options: [
      { label: "Hammer", description: "For nails" },
      { label: "Screwdriver", description: "For screws" },
    ],
    custom: true,
  },
]

const questionNoCustom: QuestionInfo[] = [
  {
    question: "Pick a size",
    header: "Size",
    options: [
      { label: "Small", description: "S" },
      { label: "Large", description: "L" },
    ],
    custom: false,
  },
]

function makeRequest(questions: QuestionInfo[]): QuestionRequest {
  return { id: "req-123", questions }
}

function mockService(): QuestionService {
  return {
    reply: mock(() => {}),
    reject: mock(() => {}),
    ask: mock(() => Promise.resolve([])),
    list: mock(() => []),
  } as unknown as QuestionService
}

// ---------------------------------------------------------------------------
// createInitialStore
// ---------------------------------------------------------------------------

describe("createInitialStore", () => {
  it("creates store with correct shape for single question", () => {
    const store = createInitialStore(singleQuestion)
    expect(store.tab).toBe(0)
    expect(store.answers).toEqual([[]])
    expect(store.custom).toEqual([""])
    expect(store.selected).toBe(0)
    expect(store.editing).toBe(false)
  })

  it("creates store with correct shape for multiple questions", () => {
    const store = createInitialStore(multiQuestion)
    expect(store.tab).toBe(0)
    expect(store.answers).toEqual([[], []])
    expect(store.custom).toEqual(["", ""])
    expect(store.selected).toBe(0)
    expect(store.editing).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Derivation functions
// ---------------------------------------------------------------------------

describe("isSingle", () => {
  it("returns true for single non-multi question", () => {
    expect(isSingle(singleQuestion)).toBe(true)
  })

  it("returns false for multi-select single question", () => {
    expect(isSingle(singleMultiSelect)).toBe(false)
  })

  it("returns false for multiple questions", () => {
    expect(isSingle(multiQuestion)).toBe(false)
  })
})

describe("tabCount", () => {
  it("returns 1 for single-select single question (no confirm tab)", () => {
    expect(tabCount(singleQuestion)).toBe(1)
  })

  it("returns questions.length + 1 for multi-question", () => {
    expect(tabCount(multiQuestion)).toBe(3) // 2 questions + confirm
  })

  it("returns questions.length + 1 for multi-select single question", () => {
    expect(tabCount(singleMultiSelect)).toBe(2) // 1 question + confirm
  })
})

describe("currentQuestion", () => {
  it("returns the question at the given tab index", () => {
    expect(currentQuestion(multiQuestion, 0)?.header).toBe("Framework")
    expect(currentQuestion(multiQuestion, 1)?.header).toBe("Language")
  })

  it("returns undefined for out-of-bounds tab (confirm tab)", () => {
    expect(currentQuestion(multiQuestion, 2)).toBeUndefined()
  })
})

describe("isConfirmTab", () => {
  it("returns false for single-select single question", () => {
    // Single questions never have a confirm tab
    expect(isConfirmTab(singleQuestion, 0)).toBe(false)
    expect(isConfirmTab(singleQuestion, 1)).toBe(false) // isSingle -> no confirm
  })

  it("returns true when tab equals questions.length for multi-question", () => {
    expect(isConfirmTab(multiQuestion, 2)).toBe(true)
  })

  it("returns false for question tabs in multi-question", () => {
    expect(isConfirmTab(multiQuestion, 0)).toBe(false)
    expect(isConfirmTab(multiQuestion, 1)).toBe(false)
  })
})

describe("isMulti", () => {
  it("returns true for multiple: true", () => {
    expect(isMulti(singleMultiSelect[0])).toBe(true)
  })

  it("returns false for non-multi question", () => {
    expect(isMulti(singleQuestion[0])).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(isMulti(undefined)).toBe(false)
  })
})

describe("hasCustom", () => {
  it("returns true when custom is explicitly true", () => {
    expect(hasCustom(questionWithCustom[0])).toBe(true)
  })

  it("returns false when custom is explicitly false", () => {
    expect(hasCustom(questionNoCustom[0])).toBe(false)
  })

  it("returns true when custom is undefined (default)", () => {
    // Default behavior: custom !== false -> true
    expect(hasCustom(singleQuestion[0])).toBe(true)
  })

  it("returns false for undefined question", () => {
    expect(hasCustom(undefined)).toBe(false)
  })
})

describe("isOther", () => {
  it("returns true when selected is at the custom option index", () => {
    // singleQuestion[0] has 2 options, custom enabled by default
    expect(isOther(singleQuestion[0], 2)).toBe(true)
  })

  it("returns false when selected is at a regular option", () => {
    expect(isOther(singleQuestion[0], 0)).toBe(false)
    expect(isOther(singleQuestion[0], 1)).toBe(false)
  })

  it("returns false when custom is disabled", () => {
    expect(isOther(questionNoCustom[0], 2)).toBe(false)
  })
})

describe("optionCount", () => {
  it("includes custom option when enabled", () => {
    // 2 options + 1 custom
    expect(optionCount(singleQuestion[0])).toBe(3)
  })

  it("excludes custom option when disabled", () => {
    expect(optionCount(questionNoCustom[0])).toBe(2)
  })

  it("returns 0 for undefined", () => {
    expect(optionCount(undefined)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

describe("moveTo", () => {
  it("wraps around when going below 0", () => {
    const q = singleQuestion[0]
    const result = moveTo(q, -1)
    expect(result.selected).toBe(optionCount(q) - 1) // wraps to last
  })

  it("wraps around when going past the end", () => {
    const q = singleQuestion[0]
    const total = optionCount(q)
    const result = moveTo(q, total)
    expect(result.selected).toBe(0) // wraps to first
  })

  it("selects the given index when in range", () => {
    expect(moveTo(singleQuestion[0], 1).selected).toBe(1)
  })

  it("returns 0 for undefined question", () => {
    expect(moveTo(undefined, 5).selected).toBe(0)
  })
})

describe("selectTab", () => {
  it("wraps around forward", () => {
    const result = selectTab(multiQuestion, 3)
    expect(result.tab).toBe(0) // 3 tabs total, wraps 3->0
  })

  it("wraps around backward", () => {
    const result = selectTab(multiQuestion, -1)
    expect(result.tab).toBe(2) // wraps to confirm tab
  })

  it("always resets selected to 0", () => {
    const result = selectTab(multiQuestion, 1)
    expect(result.selected).toBe(0)
  })

  it("stays at 0 for single-select single question", () => {
    const result = selectTab(singleQuestion, 1)
    expect(result.tab).toBe(0) // only 1 tab, wraps back
  })
})

describe("toggleAnswer", () => {
  it("adds an option when not present", () => {
    const answers = [[], []]
    const result = toggleAnswer(answers, 0, "React")
    expect(result[0]).toEqual(["React"])
    expect(result[1]).toEqual([]) // other tab unaffected
  })

  it("removes an option when already present", () => {
    const answers = [["React", "Solid"], []]
    const result = toggleAnswer(answers, 0, "React")
    expect(result[0]).toEqual(["Solid"])
  })
})

describe("pickAnswer", () => {
  it("sets answer to single label", () => {
    const answers = [[], []]
    const result = pickAnswer(answers, 0, "React")
    expect(result[0]).toEqual(["React"])
  })

  it("replaces existing answer", () => {
    const answers = [["Solid"], []]
    const result = pickAnswer(answers, 0, "React")
    expect(result[0]).toEqual(["React"])
  })
})

describe("setCustomText", () => {
  it("sets text at the given tab index", () => {
    const customs = ["", ""]
    const result = setCustomText(customs, 1, "hello")
    expect(result).toEqual(["", "hello"])
  })

  it("does not mutate original array", () => {
    const customs = ["old", ""]
    const result = setCustomText(customs, 0, "new")
    expect(customs[0]).toBe("old")
    expect(result[0]).toBe("new")
  })
})

// ---------------------------------------------------------------------------
// selectOption (the main pick/toggle logic)
// ---------------------------------------------------------------------------

describe("selectOption", () => {
  it("single-select single-question: returns fastPath=true", () => {
    const store = createInitialStore(singleQuestion)
    const result = selectOption(store, singleQuestion)
    expect(result.fastPath).toBe(true)
    expect(result.patch.answers?.[0]).toEqual(["Red"])
  })

  it("single-select single-question: second option", () => {
    const store = { ...createInitialStore(singleQuestion), selected: 1 }
    const result = selectOption(store, singleQuestion)
    expect(result.fastPath).toBe(true)
    expect(result.patch.answers?.[0]).toEqual(["Blue"])
  })

  it("multi-select: toggles option, no fastPath", () => {
    const store = createInitialStore(singleMultiSelect)
    const result = selectOption(store, singleMultiSelect)
    expect(result.fastPath).toBe(false)
    expect(result.patch.answers?.[0]).toEqual(["Red"])
  })

  it("multi-question single-select: advances tab", () => {
    const store = createInitialStore(multiQuestion)
    const result = selectOption(store, multiQuestion)
    expect(result.fastPath).toBe(false)
    expect(result.patch.answers?.[0]).toEqual(["React"])
    expect(result.patch.tab).toBe(1)
    expect(result.patch.selected).toBe(0)
  })

  it("custom option: enters editing mode", () => {
    // singleQuestion has custom enabled by default, custom is at index 2
    const store = { ...createInitialStore(singleQuestion), selected: 2 }
    const result = selectOption(store, singleQuestion)
    expect(result.startedEditing).toBe(true)
    expect(result.patch.editing).toBe(true)
    expect(result.fastPath).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// commitCustom
// ---------------------------------------------------------------------------

describe("commitCustom", () => {
  it("commits text and returns fastPath for single question", () => {
    const store: QuestionStore = {
      ...createInitialStore(singleQuestion),
      editing: true,
      custom: ["my answer"],
    }
    const result = commitCustom(store, singleQuestion, "my answer")
    expect(result.patch.editing).toBe(false)
    expect(result.patch.answers?.[0]).toEqual(["my answer"])
    expect(result.fastPath).toBe(true)
  })

  it("clears editing on empty text", () => {
    const store: QuestionStore = {
      ...createInitialStore(singleQuestion),
      editing: true,
      custom: [""],
    }
    const result = commitCustom(store, singleQuestion, "")
    expect(result.patch.editing).toBe(false)
    expect(result.fastPath).toBe(false)
  })

  it("clears previous custom answer when empty text submitted", () => {
    const store: QuestionStore = {
      ...createInitialStore(singleQuestion),
      editing: true,
      custom: ["old value"],
      answers: [["old value"]],
    }
    const result = commitCustom(store, singleQuestion, "  ")
    expect(result.patch.editing).toBe(false)
    expect(result.patch.custom?.[0]).toBe("")
    expect(result.patch.answers?.[0]).toEqual([])
  })

  it("multi-select: adds custom to existing answers", () => {
    const store: QuestionStore = {
      ...createInitialStore(singleMultiSelect),
      editing: true,
      custom: ["Purple"],
      answers: [["Red"]],
    }
    const result = commitCustom(store, singleMultiSelect, "Purple")
    expect(result.patch.answers?.[0]).toEqual(["Red", "Purple"])
    expect(result.fastPath).toBe(false)
  })

  it("multi-question: advances tab after commit", () => {
    const store: QuestionStore = {
      ...createInitialStore(multiQuestion),
      editing: true,
      custom: ["Vue"],
    }
    const result = commitCustom(store, multiQuestion, "Vue")
    expect(result.patch.tab).toBe(1)
    expect(result.patch.selected).toBe(0)
    expect(result.fastPath).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildFinalAnswers
// ---------------------------------------------------------------------------

describe("buildFinalAnswers", () => {
  it("returns per-question answers array", () => {
    const store: QuestionStore = {
      ...createInitialStore(multiQuestion),
      answers: [["React"], ["TypeScript"]],
    }
    const result = buildFinalAnswers(store, multiQuestion)
    expect(result).toEqual([["React"], ["TypeScript"]])
  })

  it("returns empty arrays for unanswered questions", () => {
    const store = createInitialStore(multiQuestion)
    const result = buildFinalAnswers(store, multiQuestion)
    expect(result).toEqual([[], []])
  })
})

// ---------------------------------------------------------------------------
// submitAnswers / rejectQuestion
// ---------------------------------------------------------------------------

describe("submitAnswers", () => {
  it("calls service.reply with request id and formatted answers", () => {
    const service = mockService()
    const request = makeRequest(multiQuestion)
    const store: QuestionStore = {
      ...createInitialStore(multiQuestion),
      answers: [["React"], ["TypeScript"]],
    }
    submitAnswers(store, multiQuestion, request, service)
    expect(service.reply).toHaveBeenCalledWith("req-123", [["React"], ["TypeScript"]])
  })
})

describe("rejectQuestion", () => {
  it("calls service.reject with request id", () => {
    const service = mockService()
    const request = makeRequest(singleQuestion)
    rejectQuestion(request, service)
    expect(service.reject).toHaveBeenCalledWith("req-123")
  })
})

// ---------------------------------------------------------------------------
// keyboardHints
// ---------------------------------------------------------------------------

describe("keyboardHints", () => {
  it("returns editing hints when editing", () => {
    const result = keyboardHints(singleQuestion, 0, true, false)
    expect(result).toContain("enter confirm")
    expect(result).toContain("esc cancel")
  })

  it("returns confirm hints on confirm tab", () => {
    const result = keyboardHints(multiQuestion, 2, false, false)
    expect(result).toContain("enter submit")
    expect(result).toContain("esc dismiss")
  })

  it("includes tab hint for multi-question", () => {
    const result = keyboardHints(multiQuestion, 0, false, false)
    expect(result).toContain("⇆ tab")
  })

  it("excludes tab hint for single question", () => {
    const result = keyboardHints(singleQuestion, 0, false, false)
    expect(result).not.toContain("⇆ tab")
  })

  it("shows toggle for multi-select", () => {
    const result = keyboardHints(singleMultiSelect, 0, false, true)
    expect(result).toContain("toggle")
  })
})
