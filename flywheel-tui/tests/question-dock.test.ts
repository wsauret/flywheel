import { describe, it, expect } from "bun:test"
import type { AnyBlock, QuestionBlock } from "../src/infra/output-blocks"

/**
 * Replicated from shell-state.ts: scans outputBlocks from the end to find the
 * most recent unanswered, uncancelled question block.
 */
function findPendingQuestion(
  blocks: readonly AnyBlock[],
): QuestionBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === "question" && !b.answers && !b.cancelled) {
      return b
    }
  }
  return undefined
}

function makeQuestion(overrides: Partial<QuestionBlock> = {}): QuestionBlock {
  return {
    kind: "question",
    toolUseId: "tool_q1",
    questions: [
      {
        question: "Which framework?",
        options: [
          { label: "Express", description: "lightweight" },
          { label: "Fastify" },
        ],
      },
    ],
    timestamp: 1000,
    ...overrides,
  }
}

describe("findPendingQuestion", () => {
  it("returns undefined when blocks are empty", () => {
    expect(findPendingQuestion([])).toBeUndefined()
  })

  it("returns undefined when no question blocks exist", () => {
    const blocks: AnyBlock[] = [
      { kind: "text", content: "hello", timestamp: 1 },
      { kind: "system", message: "info", timestamp: 2 },
    ]
    expect(findPendingQuestion(blocks)).toBeUndefined()
  })

  it("returns the pending question block", () => {
    const q = makeQuestion()
    const blocks: AnyBlock[] = [
      { kind: "text", content: "hello", timestamp: 1 },
      q,
    ]
    expect(findPendingQuestion(blocks)).toEqual(q)
  })

  it("returns undefined when question has answers", () => {
    const blocks: AnyBlock[] = [
      makeQuestion({ answers: { "Which framework?": "Express" } }),
    ]
    expect(findPendingQuestion(blocks)).toBeUndefined()
  })

  it("returns undefined when question is cancelled", () => {
    const blocks: AnyBlock[] = [
      makeQuestion({ cancelled: true }),
    ]
    expect(findPendingQuestion(blocks)).toBeUndefined()
  })

  it("returns the most recent pending question when multiple exist", () => {
    const q1 = makeQuestion({ toolUseId: "q1" })
    const q2 = makeQuestion({ toolUseId: "q2" })
    const blocks: AnyBlock[] = [
      { kind: "text", content: "hello", timestamp: 1 },
      q1,
      { kind: "text", content: "more", timestamp: 2 },
      q2,
    ]
    expect(findPendingQuestion(blocks)!.toolUseId).toBe("q2")
  })

  it("skips answered questions and returns pending one", () => {
    const answered = makeQuestion({ toolUseId: "q1", answers: { "Which framework?": "Express" } })
    const pending = makeQuestion({ toolUseId: "q2" })
    expect(findPendingQuestion([answered, pending])!.toolUseId).toBe("q2")
  })

  it("returns undefined when all questions are resolved", () => {
    const blocks: AnyBlock[] = [
      makeQuestion({ toolUseId: "q1", answers: { "Which framework?": "A" } }),
      makeQuestion({ toolUseId: "q2", cancelled: true }),
    ]
    expect(findPendingQuestion(blocks)).toBeUndefined()
  })
})

describe("multi-question answer record construction", () => {
  /**
   * Replicated from question-dock.tsx submit(): builds the Record<questionText, string>
   * that gets sent to Claude. Multi-select values are comma-joined.
   */
  function buildAnswers(
    questions: Array<{ question: string; multiSelect?: boolean }>,
    selections: string[][],
    custom: string[],
    customOn: boolean[],
  ): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!
      const parts: string[] = [...(selections[i] ?? [])]
      if (customOn[i] && (custom[i] ?? "").trim()) {
        parts.push(custom[i]!.trim())
      }
      if (parts.length > 0) out[q.question] = parts.join(", ")
    }
    return out
  }

  it("single question single-select produces a one-key record", () => {
    const answers = buildAnswers(
      [{ question: "Framework?" }],
      [["React"]],
      [""],
      [false],
    )
    expect(answers).toEqual({ "Framework?": "React" })
  })

  it("multi-question single-select produces a record per question", () => {
    const answers = buildAnswers(
      [{ question: "Framework?" }, { question: "DB?" }],
      [["React"], ["Postgres"]],
      ["", ""],
      [false, false],
    )
    expect(answers).toEqual({ "Framework?": "React", "DB?": "Postgres" })
  })

  it("multi-select comma-joins selected labels", () => {
    const answers = buildAnswers(
      [{ question: "Features?", multiSelect: true }],
      [["Dark mode", "Auto-save"]],
      [""],
      [false],
    )
    expect(answers).toEqual({ "Features?": "Dark mode, Auto-save" })
  })

  it("appends custom text to selections when customOn is set", () => {
    const answers = buildAnswers(
      [{ question: "Features?", multiSelect: true }],
      [["Dark mode"]],
      ["Custom feature"],
      [true],
    )
    expect(answers).toEqual({ "Features?": "Dark mode, Custom feature" })
  })

  it("custom-only answer (no preset selected)", () => {
    const answers = buildAnswers(
      [{ question: "Name?" }],
      [[]],
      ["Alex"],
      [true],
    )
    expect(answers).toEqual({ "Name?": "Alex" })
  })

  it("omits questions with no selection and no custom text", () => {
    const answers = buildAnswers(
      [{ question: "Framework?" }, { question: "DB?" }],
      [["React"], []],
      ["", ""],
      [false, false],
    )
    expect(answers).toEqual({ "Framework?": "React" })
  })
})
