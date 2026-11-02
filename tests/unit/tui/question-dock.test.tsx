/** @jsxImportSource @opentui/solid */

import { describe, expect, it, mock } from "bun:test"
import { createSignal, For, Show } from "solid-js"
import { testRender } from "@opentui/solid"
import { createTextAttributes, TextRenderable, type Renderable } from "@opentui/core"

import type { QuestionBlock } from "../../../src/infra/output-blocks.js"
import { QuestionInputProvider, type QuestionInputContext, useQuestionInput } from "../../../src/tui/components/question-input.js"
import { ThemeProvider } from "../../../src/tui/context/theme.js"
import { createDraftCache } from "../../../src/tui/hooks/create-draft-cache.js"
import { QuestionDock } from "../../../src/tui/question-dock.js"
import flywheelTheme from "../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../src/tui/context/theme/resolve.js"

const theme = resolveTheme(flywheelTheme, "dark")

const question: QuestionBlock = {
  kind: "question",
  toolUseId: "tool-question",
  questions: [{
    question: "Choose a color",
    choices: [
      { kind: "option", choiceId: "choice-1", label: "Red" },
      { kind: "freeform", label: "Other" },
    ],
    multiSelect: false,
  }],
  timestamp: 1,
}
const textQuestion: QuestionBlock = {
  ...question,
  questions: [{
    question: "Describe the change",
    choices: [
      { kind: "option", choiceId: "revise", label: "Revise", description: "Name the revision", recommended: true, requiresText: true },
      { kind: "freeform", label: "Other" },
    ],
    multiSelect: false,
  }],
}
const twoQuestionBlock: QuestionBlock = {
  ...question,
  questions: [
    question.questions[0]!,
    { question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }, { kind: "freeform", label: "Other" }], multiSelect: false },
  ],
}

/** The frame text left of the visible terminal cursor, on the cursor's row. */
function cursorAt(result: Awaited<ReturnType<typeof testRender>>): string {
  const cursor = result.renderer.getCursorState()
  expect(cursor.visible).toBe(true)
  // Terminal cursor coordinates are one-based.
  return result.captureCharFrame().split("\n")[cursor.y - 1]?.slice(0, cursor.x - 1) ?? ""
}

describe("QuestionDock", () => {
  async function renderQuestionDock(options: {
    width?: number
    docked?: boolean
    onAnswer?: ReturnType<typeof mock>
    question?: QuestionBlock
    draftCache?: ReturnType<typeof createDraftCache>
    captureFocus?: () => boolean
  } = {}) {
    const [current, setCurrent] = createSignal(options.question ?? question)
    let questionInput: QuestionInputContext | undefined
    const onAnswer = options.onAnswer ?? mock(() => {})
    const width = options.width ?? 100
    const draftCache = options.draftCache ?? createDraftCache()

    function Harness() {
      questionInput = useQuestionInput()
      return (
        <QuestionDock
          sessionId="session-a"
          question={current()}
          draftCache={draftCache}
          width={width}
          captureFocus={options.captureFocus ?? (() => true)}
          onAnswer={async (answers) => (await onAnswer(answers)) !== false}
          onCancel={async () => true}
        />
      )
    }

    const result = await testRender(() => (
      <ThemeProvider mode="dark">
        <QuestionInputProvider>
          {options.docked
            ? <box height="100%" flexDirection="column"><box flexGrow={1}><text>Transcript</text></box><Harness /></box>
            : <Harness />}
        </QuestionInputProvider>
      </ThemeProvider>
    ), { width, height: 24 })
    // The dock measures its content on its first frame and takes its rows on the next.
    await result.renderOnce()
    await result.renderOnce()
    const input = questionInput
    if (!input) throw new Error("question input did not mount")
    return { result, input, onAnswer, setQuestion: setCurrent }
  }

  it("retains choice renderables and continues an unsent draft after an equal question reread", async () => {
    const { result, input, setQuestion } = await renderQuestionDock({ question: textQuestion })
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    try {
      const choices = descendants(result.renderer.root).filter(node => node instanceof TextRenderable && /Revise|Other/.test(node.plainText))
      expect(choices.length).toBe(2)
      input.paste("draft")
      await result.renderOnce()
      setQuestion(structuredClone(textQuestion))
      await result.renderOnce()
      expect(choices.every(row => descendants(result.renderer.root).includes(row))).toBe(true)
      expect(result.captureCharFrame()).toContain("draft")
      input.paste(" continued")
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("draft continued")
    } finally { result.renderer.destroy() }
  })

  it("keeps the choices in the frame when the question is taller than the frame", async () => {
    const patch = Array.from({ length: 60 }, (_, index) => `-removed line ${index}`).join("\n")
    const { result } = await renderQuestionDock({ question: { ...question, questions: [{ ...question.questions[0]!, question: `Apply?\n\n\`\`\`diff\n${patch}\n\`\`\`` }] } })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("1. Red")
      expect(frame).toContain("esc cancel")
    } finally {
      result.renderer.destroy()
    }
  })

  it("restores an Other draft after the question dock remounts", async () => {
    const draftCache = createDraftCache()
    const first = await renderQuestionDock({ draftCache })

    first.input.input({ name: "down" })
    for (const character of "Amber") first.input.input({ name: character.toLowerCase(), sequence: character, raw: character })
    await first.result.renderOnce()
    first.result.renderer.destroy()

    const second = await renderQuestionDock({ draftCache })
    try {
      expect(second.result.captureCharFrame()).toContain("Other - Amber")
    } finally {
      second.result.renderer.destroy()
    }
  })

  it("shows a sending state while a final answer is in flight", async () => {
    const response = Promise.withResolvers<boolean>()
    const { result, input } = await renderQuestionDock({ onAnswer: mock(() => response.promise) })
    try {
      input.input({ name: "1" })
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Sending response...")
      expect(result.captureCharFrame()).not.toContain("esc cancel")
      response.resolve(false)
      await response.promise
      await Promise.resolve()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("esc cancel")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders Other as one editable row with inline validation", async () => {
    const { result, input } = await renderQuestionDock()

    try {
      const initialFrame = result.captureCharFrame()
      expect(initialFrame).toContain("Other -")
      expect(initialFrame).toContain("1-9 select")

      input.input({ name: "down" })
      input.input({ name: "return" })
      await result.renderOnce()

      const invalidFrame = result.captureCharFrame()
      expect(cursorAt(result)).toEndWith("Other - ")
      expect(invalidFrame).toContain("Enter a response")
      expect(invalidFrame).toContain("shift/ctrl+enter newline · enter submit")
      expect(invalidFrame).not.toContain("1-9 select")
    } finally {
      result.renderer.destroy()
    }
  })

  it("starts every editable option answer immediately after its title", async () => {
    const { result } = await renderQuestionDock({ question: textQuestion })
    try {
      const titleLine = result.captureCharFrame().split("\n").find((line) => line.includes("Revise"))
      const recommended = result.captureSpans().lines
        .flatMap((line) => line.spans)
        .find((span) => span.text === " (Recommended)")

      expect(titleLine).toContain("Revise - Name the revision (Recommended) - ")
      expect(cursorAt(result)).toEndWith("(Recommended) - ")
      expect(recommended?.fg.equals(theme.success)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("wraps the complete editable option at narrow widths", async () => {
    const { result } = await renderQuestionDock({ width: 28, question: textQuestion })
    try {
      const frame = result.captureCharFrame()
      const recommended = result.captureSpans().lines
        .flatMap((line) => line.spans)
        .filter((span) => span.fg.equals(theme.success))
        .map((span) => span.text)
        .join("")

      expect(frame).toContain("Revise - Name the")
      expect(frame).toContain("revision (Recommended)")
      expect(cursorAt(result)).toEndWith("- ")
      expect(recommended).toContain(" (Recommended)")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the selected single-choice glyph when focus moves", async () => {
    const { result, input } = await renderQuestionDock({ question: twoQuestionBlock })
    try {
      input.input({ name: "1" })
      input.input({ name: "left" })
      input.input({ name: "down" })
      await result.renderOnce()

      const frame = result.captureCharFrame()
      expect(frame).toContain("● 1. Red")
      expect(frame).toContain("○ 2. Other")
    } finally {
      result.renderer.destroy()
    }
  })

  it("wraps the complete pasted Other draft and settles the dock height", async () => {
    const { result, input, onAnswer } = await renderQuestionDock({ width: 80, docked: true })
    const answer = "This answer must remain fully visible through the final words. ".repeat(5).trim()

    try {
      for (let frame = 0; frame < 6; frame++) await result.renderOnce()
      input.input({ name: "down" })
      input.paste(answer)
      for (let frame = 0; frame < 6; frame++) await result.renderOnce()

      const frame = result.captureCharFrame()
      expect(frame).toContain("This answer must remain")
      expect(frame).toContain("words")
      for (let nextFrame = 0; nextFrame < 6; nextFrame++) {
        await result.renderOnce()
        expect(result.captureCharFrame()).toBe(frame)
      }
      input.input({ name: "return" })
      expect(onAnswer).toHaveBeenCalledWith({ "Choose a color": { kind: "freeform", text: answer } })
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the first Other character visible when the label fills the row", async () => {
    const { result, input } = await renderQuestionDock({ width: 18 })

    try {
      input.input({ name: "down" })
      for (const char of "abc") input.input({ name: char, sequence: char, raw: char })
      await result.renderOnce()

      expect(result.captureCharFrame()).toContain("abc")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders the caret after the last typed character", async () => {
    const { result, input } = await renderQuestionDock()

    try {
      input.input({ name: "down" })
      for (const char of "abc") input.input({ name: char, sequence: char, raw: char })
      await result.renderOnce()

      expect(result.captureCharFrame()).toContain("Other - abc")
      expect(cursorAt(result)).toEndWith("Other - abc")

      input.input({ name: "left" })
      await result.renderOnce()

      // The cursor covers the letter it inserts before and adds no cell.
      expect(result.captureCharFrame()).toContain("Other - abc")
      expect(cursorAt(result)).toEndWith("Other - ab")

      input.input({ name: "up" })
      await result.renderOnce()

      expect(result.renderer.getCursorState().visible).toBe(false)
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the terminal cursor on the visible caret line of a tall answer", async () => {
    const { result, input } = await renderQuestionDock({ docked: true })

    try {
      input.input({ name: "down" })
      input.paste(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"))
      for (let frame = 0; frame < 6; frame++) await result.renderOnce()

      expect(cursorAt(result)).toEndWith("line 29")
      expect(result.renderer.getCursorState().color.equals(theme.primary)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("hides the terminal cursor while an overlay covers the dock", async () => {
    const [captureFocus, setCaptureFocus] = createSignal(true)
    const { result, input } = await renderQuestionDock({ captureFocus })

    try {
      input.input({ name: "down" })
      await result.renderOnce()
      expect(result.renderer.getCursorState().visible).toBe(true)

      setCaptureFocus(false)
      await result.renderOnce()
      expect(result.renderer.getCursorState().visible).toBe(false)

      setCaptureFocus(true)
      await result.renderOnce()
      expect(cursorAt(result)).toEndWith("Other - ")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders Shift+Enter as a new editable row", async () => {
    const onAnswer = mock(() => {})
    const { result, input } = await renderQuestionDock({ width: 42, onAnswer })

    try {
      input.input({ name: "down" })
      for (const char of "first") input.input({ name: char, sequence: char, raw: char })
      input.input({ name: "return", shift: true })
      for (const char of "second") input.input({ name: char, sequence: char, raw: char })
      await result.renderOnce()

      const lines = result.captureCharFrame().split("\n")
      const firstRow = lines.findIndex((line) => line.includes("first"))
      const secondRow = lines.findIndex((line) => line.includes("second"))
      expect(firstRow).toBeGreaterThanOrEqual(0)
      expect(secondRow).toBe(firstRow + 1)

      input.input({ name: "return" })
      expect(onAnswer).toHaveBeenCalledWith({
        "Choose a color": { kind: "freeform", text: "first\nsecond" },
      })
    } finally {
      result.renderer.destroy()
    }
  })

  it("places the Other caret from a click on a wrapped row", async () => {
    const onAnswer = mock(() => {})
    const { result, input } = await renderQuestionDock({ width: 42, onAnswer })
    const answer = "alpha beta gamma delta epsilon zeta eta theta"

    try {
      input.input({ name: "down" })
      for (const char of answer) input.input({ name: char.toLowerCase(), sequence: char, raw: char })
      await result.renderOnce()

      const lines = result.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("epsilon"))
      const x = y < 0 ? -1 : (lines[y]?.indexOf("epsilon") ?? -1)
      expect(x).toBeGreaterThanOrEqual(0)
      await result.mockMouse.pressDown(x, y)
      await result.mockMouse.release(x, y)
      input.input({ name: "x", sequence: "X", raw: "X" })
      input.input({ name: "return" })

      expect(onAnswer).toHaveBeenCalledWith({
        "Choose a color": { kind: "freeform", text: "alpha beta gamma delta Xepsilon zeta eta theta" },
      })
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders the shared editor selection colors inside the wrapped Other row", async () => {
    const { result, input } = await renderQuestionDock({ width: 42 })

    try {
      input.input({ name: "down" })
      for (const char of "alpha beta gamma") input.input({ name: char, sequence: char, raw: char })
      for (let index = 0; index < 5; index++) input.input({ name: "left", shift: true })
      await result.renderOnce()

      const selected = result.captureSpans().lines
        .flatMap((line) => line.spans)
        .filter((span) => span.bg.equals(theme.selectionBackground))
      expect(selected.map((span) => span.text).join("")).toContain("gamma")
      expect(selected.every((span) => span.fg.equals(theme.selectionForeground))).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("titles a single question with its header", async () => {
    const headed: QuestionBlock = { ...question, questions: [{ ...question.questions[0]!, header: "Workflow" }] }
    const titled = await renderQuestionDock({ question: headed })
    try {
      const titleLine = titled.result.captureCharFrame().split("\n").map((line) => line.replace("┃", "").trim()).find((line) => line.length > 0)
      expect(titleLine).toBe("Workflow")
    } finally {
      titled.result.renderer.destroy()
    }
    const untitled = await renderQuestionDock()
    try {
      expect(untitled.result.captureCharFrame()).toContain("Ask User")
    } finally {
      untitled.result.renderer.destroy()
    }
  })

  it("names what Enter does on each question and drops question navigation inside a text row", async () => {
    const block: QuestionBlock = {
      ...question,
      questions: [
        { question: "Features?", choices: [{ kind: "option", choiceId: "dark", label: "Dark mode" }, { kind: "freeform", label: "Other" }], multiSelect: true },
        { question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }, { kind: "freeform", label: "Other" }], multiSelect: true },
      ],
    }
    const { result, input } = await renderQuestionDock({ question: block, width: 140 })
    try {
      expect(result.captureCharFrame()).toContain("space toggle · enter next · ↑↓ navigate · ←→ question")
      const hints = result.captureSpans().lines.flatMap(line => line.spans).filter(span => span.text.includes("space toggle"))
      expect(hints.length).toBeGreaterThan(0)
      for (const hint of hints) {
        expect(hint.fg).toEqual(theme.textMuted)
        expect(hint.attributes & createTextAttributes({ dim: true })).toBe(0)
      }

      input.input({ name: "down" })
      await result.renderOnce()
      const textRow = result.captureCharFrame()
      expect(textRow).toContain("shift/ctrl+enter newline · enter next")
      expect(textRow).not.toContain("←→ question")

      input.input({ name: "up" })
      input.input({ name: "right" })
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("space toggle · enter submit")
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows a missing-text message under the choice that needs the text", async () => {
    const block: QuestionBlock = {
      ...question,
      questions: [{
        question: "Describe the change",
        choices: [
          { kind: "option", choiceId: "revise", label: "Revise", requiresText: true },
          { kind: "option", choiceId: "keep", label: "Keep" },
          { kind: "freeform", label: "Other" },
        ],
        multiSelect: false,
      }],
    }
    const { result, input } = await renderQuestionDock({ question: block })
    try {
      input.input({ name: "return" })
      input.input({ name: "return" })
      await result.renderOnce()

      const lines = result.captureCharFrame().split("\n")
      const message = lines.findIndex((line) => line.includes("Enter a response"))
      expect(message).toBeGreaterThan(lines.findIndex((line) => line.includes("1. Revise")))
      expect(message).toBeLessThan(lines.findIndex((line) => line.includes("2. Keep")))
    } finally {
      result.renderer.destroy()
    }
  })

  // The shell gives the transcript only the rows the prompt area leaves, so a
  // dock frame taller than its content blanks the whole transcript.
  it("takes no rows until measured, then takes its content height in one step", async () => {
    const [docked, setDocked] = createSignal(false)
    const transcript = Array.from({ length: 60 }, (_, index) => `transcript line ${index}`)
    const result = await testRender(() => (
      <ThemeProvider mode="dark">
        <QuestionInputProvider>
          <box height="100%" flexDirection="column">
            <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column" justifyContent="flex-end" overflow="hidden">
              <For each={transcript}>{(line) => <text>{line}</text>}</For>
            </box>
            <box flexShrink={1} minHeight={0}>
              <Show when={docked()}>
                <QuestionDock sessionId="session-a" question={question} draftCache={createDraftCache()} width={100} captureFocus={() => true} onAnswer={async () => true} onCancel={async () => true} />
              </Show>
            </box>
          </box>
        </QuestionInputProvider>
      </ThemeProvider>
    ), { width: 100, height: 40 })
    const rows = () => {
      const lines = result.captureCharFrame().split("\n")
      return {
        transcript: lines.filter((line) => line.startsWith("transcript line")).length,
        dock: lines.filter((line) => line.startsWith("┃")).length,
      }
    }
    try {
      await result.renderOnce()
      const heights = [rows().transcript]
      setDocked(true)
      for (let frame = 0; frame < 4; frame++) {
        await result.renderOnce()
        const frameRows = rows()
        expect(frameRows.transcript).toBeGreaterThan(20)
        heights.push(frameRows.transcript)
      }
      expect(heights.filter((height, frame) => frame > 0 && height !== heights[frame - 1])).toHaveLength(1)
      expect(result.captureCharFrame()).toContain("1. Red")
      expect(rows().dock).toBeLessThan(12)
    } finally {
      result.renderer.destroy()
    }
  })

  it("wraps a long option description instead of cutting it", async () => {
    const block: QuestionBlock = {
      ...question,
      questions: [{
        question: "Launch?",
        choices: [
          { kind: "option", choiceId: "launch", label: "Launch", description: "Start the implement workflow with the confirmed specification" },
          { kind: "freeform", label: "Other" },
        ],
        multiSelect: false,
      }],
    }
    const { result } = await renderQuestionDock({ question: block, width: 40 })
    try {
      const flat = result.captureCharFrame().replace(/[\s\u2503]+/g, " ")
      expect(flat).toContain("Start the implement workflow with the confirmed specification")
    } finally {
      result.renderer.destroy()
    }
  })
})
