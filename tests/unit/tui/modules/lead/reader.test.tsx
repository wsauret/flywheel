/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { FrontendOutputBlock } from "../../../../../src/protocol/app-service-types.js"
import type { LeadRow } from "../../../../../src/protocol/modules/lead.js"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import { useLeadScreen } from "../../../../../src/tui/modules/lead/client.js"
import { textBlock } from "../../_output-window-transcript.js"
import { choiceQuestion, leadHarness, leadRow } from "./_lead-fixtures.js"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const userMessage = (id: string, content: string): FrontendOutputBlock => ({ kind: "userMessage", id, content, timestamp: 1, pending: false, injected: false })
/** Text blocks taller together than the reader, so where the window starts shows. */
const filler = (name: string, count: number): FrontendOutputBlock[] => Array.from({ length: count }, (_, index) => textBlock(`${name}-${index}`, `${name} line ${index}`))
/** The transcript text in the frame, top first. */
const transcriptLines = (frame: string): string[] => frame.split("\n").map((line) => line.replace(/[│┃|]/g, "").trim()).filter((line) => line.length > 0)

/** The reader opened on `row` over the shell's viewer layer, with keys routed
 *  to the top viewer as the shell routes them. */
async function openReader(row: LeadRow, transcript: readonly FrontendOutputBlock[] = [], options: { readonly pending?: boolean } = {}) {
  const lead = leadHarness([row], { [row.sessionId]: transcript })
  if (row.state === "question" && row.question && options.pending !== false) lead.setQuestions({ [row.sessionId]: choiceQuestion(row.question.toolUseId) })
  let open: ((row: LeadRow) => void) | undefined
  const Opener = () => { open = useLeadScreen().openReader; return null }
  const rendered = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
    {lead.client.provide?.(() => <box flexDirection="column"><Opener /><lead.Viewers /></box>)}
  </TickPoolProvider></ThemeProvider>, { width: 100, height: 30 })
  cleanups.push(() => { rendered.renderer.destroy(); lead.dispose() })
  open?.(row)
  // The window lays out its rows over a few frames before it settles on its place.
  for (let frame = 0; frame < 6; frame += 1) {
    await settle()
    await rendered.renderOnce()
  }
  const key = async (name: string, modifiers: { readonly ctrl?: boolean } = {}): Promise<void> => {
    lead.overlay.viewer.input({ name, sequence: name.length === 1 ? name : undefined, ...modifiers, preventDefault: () => {} })
    await settle()
    await rendered.renderOnce()
  }
  return { ...lead, rendered, key, frame: () => rendered.captureCharFrame() }
}

describe("the lead reader", () => {
  it("frames a question with the chat name and its request, shows the chat's context and question word for word, and sends an answer to that chat", async () => {
    const reader = await openReader(leadRow("asks", "question", { question: { toolUseId: "ask-1", context: "I found two **providers** in config." } }))
    const frame = reader.frame()
    expect(frame).toContain("Chat asks")
    expect(frame).toContain("Request  Request to asks")
    expect(frame).toContain("I found two providers in config.")
    expect(frame).toContain("Which provider?")
    expect(frame).toContain("Alpha")
    // The request shows on the frame's request line only.
    expect(frame.split("Request to asks")).toHaveLength(2)
    await reader.key("return")
    expect(reader.sent).toEqual(["question.answer asks ask-1"])
    expect(reader.overlay.viewer.stack).toHaveLength(0)
  })

  it("leaves a question pending with its draft on Escape and skips it on ctrl+x", async () => {
    const reader = await openReader(leadRow("asks", "question", { question: { toolUseId: "ask-1", context: null } }))
    await reader.key("down")
    for (const letter of "Beta") await reader.key(letter)
    await reader.key("escape")
    expect(reader.overlay.viewer.stack).toHaveLength(0)
    expect(reader.sent).toEqual([])
    expect(reader.host.questionDrafts.get("asks", "ask-1")?.editorText.flat()).toContain("Beta")
    const again = await openReader(leadRow("asks", "question", { question: { toolUseId: "ask-1", context: null } }))
    await again.key("x", { ctrl: true })
    expect(again.sent).toEqual(["question.cancel asks ask-1"])
  })

  it("shows the form only for the question its row names: a loading line before it arrives, and answered elsewhere once another takes its place", async () => {
    const reader = await openReader(leadRow("asks", "question", { question: { toolUseId: "ask-1", context: "Context of asks" } }))
    reader.setQuestions({ asks: choiceQuestion("ask-2") })
    await reader.rendered.renderOnce()
    expect(reader.frame()).toContain("This question was answered elsewhere. · esc back")
    expect(reader.frame()).not.toContain("Alpha")
    await reader.key("return")
    expect(reader.sent).toEqual([])
    const early = await openReader(leadRow("late", "question", { question: { toolUseId: "ask-9", context: null } }), [], { pending: false })
    expect(early.frame()).toContain("Loading the question… · esc back")
  })

  it("shows a result's final message in full and marks it read once", async () => {
    const reader = await openReader(leadRow("done", "result", { result: { entryId: "final" } }), [
      userMessage("ask", "Please fix the build"), ...filler("earlier", 40), textBlock("final", "The build passes now.\n\nI changed two files."),
    ])
    expect(reader.loadedAround).toEqual(["done final"])
    const frame = reader.frame()
    expect(frame).toContain("The build passes now.")
    expect(frame).toContain("I changed two files.")
    expect(frame).not.toContain("Please fix the build")
    expect(frame).not.toContain("Request ")
    await reader.rendered.renderOnce()
    expect(reader.sent).toEqual(["lead.result.mark_read done final"])
  })

  it("leaves a result unread while the transcript does not hold its final message", async () => {
    const reader = await openReader(leadRow("done", "result", { result: { entryId: "final" } }), [userMessage("ask", "Please fix the build")])
    expect(reader.loadedAround).toEqual(["done final"])
    expect(reader.frame()).toContain("Please fix the build")
    expect(reader.sent).toEqual([])
  })

  it("starts a failure at its crash record and other rows at the newest person message, pages on, and sends nothing for them", async () => {
    const transcript = [userMessage("old", "First request"), ...filler("before", 40), userMessage("newest", "Second request"), textBlock("crash", "Turn ended unexpectedly."), ...filler("after", 60)]
    const failed = await openReader(leadRow("broke", "failed", { failure: { entryId: "crash" }, request: { entryId: "newest", text: "Second request" } }), transcript)
    expect(failed.loadedAround).toEqual(["broke crash"])
    expect(transcriptLines(failed.frame())[2]).toStartWith("• Turn ended unexpectedly.")
    expect(failed.frame()).not.toContain("before line")
    expect(failed.frame()).not.toContain("after line 40")
    await failed.key("pagedown")
    await failed.key("pagedown")
    await failed.rendered.renderOnce()
    expect(failed.frame()).not.toContain("Turn ended unexpectedly.")
    for (const row of [leadRow("broke", "failed", { failure: { entryId: null }, request: { entryId: "newest", text: "Second request" } }), leadRow("broke", "cut", { request: { entryId: "newest", text: "Second request" } }), leadRow("broke", "working", { request: { entryId: "newest", text: "Second request" } })]) {
      const reader = await openReader(row, transcript)
      expect(reader.loadedAround).toEqual(["broke newest"])
      expect(reader.frame()).toContain("Second request")
      expect(reader.frame()).not.toContain("before line")
      expect(reader.sent).toEqual([])
    }
  })
})
