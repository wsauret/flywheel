import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import type { QuestionBlock } from "../../../../src/infra/output-blocks.js"

function entry(question: string, optionLabels: string[], header?: string): QuestionBlock["questions"][number] {
  return {
    question,
    ...(header !== undefined ? { header } : {}),
    choices: [
      ...optionLabels.map((label, index) => ({ kind: "option" as const, choiceId: `choice-${index + 1}`, label })),
      { kind: "freeform" as const, label: "Other" },
    ],
    multiSelect: false,
  }
}

async function renderQuestionHistory(block: QuestionBlock, width = 100): Promise<string> {
  const [{ QuestionHistoryBlock }, { ThemeProvider }, { TickPoolProvider }, { BlockDisclosureProvider, createBlockDisclosureChannel }] = await Promise.all([
    import("../../../../src/tui/output-blocks/question-history-block.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/block-disclosure.js"),
  ])

  const result = await testRender(
    () =>
      createComponent(BlockDisclosureProvider, {
        value: createBlockDisclosureChannel(),
        get children() {
          return createComponent(TickPoolProvider, {
            get children() {
              return createComponent(ThemeProvider, {
                mode: "dark",
                get children() {
                  return createComponent(QuestionHistoryBlock, { block })
                },
              })
            },
          })
        },
      }),
    { width, height: 14 },
  )

  try {
    await result.renderOnce()
    // Multi-line rows need a second pass: the first layout measures the list
    // width, the second re-lays-out rows whose content grew taller.
    await result.renderOnce()
    return result.captureCharFrame()
  } finally {
    result.renderer.destroy()
  }
}

describe("QuestionHistoryBlock", () => {
  it("renders an Ask User heading with one railed row per answered question", async () => {
    const frame = await renderQuestionHistory({
      kind: "question",
      toolUseId: "tool_mq",
      questions: [
        entry("Which store should hold the cache?", ["SQLite", "Memory"], "Store scope"),
        entry("Which unit source should we use?", ["Mart", "History"], "Unit source"),
      ],
      answers: {
        "Which store should hold the cache?": "SQLite",
        "Which unit source should we use?": "Mart",
      },
      timestamp: 1000,
    })

    expect(frame).toContain("Ask User")
    expect(frame).toContain("├ Store scope SQLite")
    expect(frame).toContain("└ Unit source Mart")
  })

  it("wraps a long freeform answer in full under the rail", async () => {
    const question = "What should we do when the border cannot be represented exactly?"
    const answer = "Use a normal border until OpenTUI exposes per-edge border width controls, then revisit the thickening behavior."
    const frame = await renderQuestionHistory({
      kind: "question",
      toolUseId: "tool_freeform",
      questions: [entry(question, ["Skip thickening"], "Border")],
      answers: { [question]: `Other: ${answer}` },
      timestamp: 1000,
    }, 60)

    const flat = frame.split("\n").map((line) => line.trim()).join(" ").replace(/\s+/g, " ")
    expect(frame).toContain("└ Border Other: Use a normal border")
    expect(flat).toContain("then revisit the thickening behavior.")
    expect(frame).not.toContain("…")
  })

  it("renders a cancelled unanswered question with the Cancelled marker", async () => {
    const frame = await renderQuestionHistory({
      kind: "question",
      toolUseId: "tool_err",
      questions: [entry("Continue?", ["Yes"], "Scope")],
      cancelled: true,
      timestamp: 1000,
    })

    expect(frame).toContain("└ Scope Cancelled")
  })
})
