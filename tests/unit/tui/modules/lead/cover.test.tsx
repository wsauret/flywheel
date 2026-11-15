/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { testRender, useTerminalDimensions } from "@opentui/solid"
import { ModalProvider, useOverlay } from "../../../../../src/tui/components/modal.js"
import { QuestionInputProvider } from "../../../../../src/tui/components/question-input.js"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import { ToastProvider } from "../../../../../src/tui/context/toast.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import { useLeadScreen, type LeadScreen } from "../../../../../src/tui/modules/lead/client.js"
import { choiceQuestion, leadHarness, leadRow } from "./_lead-fixtures.js"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const WIDTH = 120
const HEIGHT = 32
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The lead's screen as the shell lays it out: the transcript, then a
 *  composer frame across the whole width at the bottom, with the shell's own
 *  overlay provider drawing the viewer layer over it. */
async function leadScreen(open: (screen: LeadScreen) => void) {
  const asks = leadRow("asks", "question")
  let lead: ReturnType<typeof leadHarness> | undefined
  let screen: LeadScreen | undefined
  function Screen() {
    lead = leadHarness([asks], {}, useOverlay())
    lead.setQuestions({ asks: choiceQuestion("asks-ask") })
    const dimensions = useTerminalDimensions()
    return lead.client.provide(() => {
      screen = useLeadScreen()
      return <box flexDirection="column" width={dimensions().width} height={dimensions().height}>
        <box flexGrow={1}><text>{"Lead transcript"}</text></box>
        <box border borderStyle="rounded" width={dimensions().width} height={5} flexShrink={0}><text>{"Lead composer"}</text></box>
      </box>
    })
  }
  const rendered = await testRender(() => <ToastProvider><ThemeProvider mode="dark"><TickPoolProvider><QuestionInputProvider>
    <ModalProvider clipboard={{ copy: async () => {}, readImage: async () => null }}><Screen /></ModalProvider>
  </QuestionInputProvider></TickPoolProvider></ThemeProvider></ToastProvider>, { width: WIDTH, height: HEIGHT })
  cleanups.push(() => { rendered.renderer.destroy(); lead?.dispose() })
  await rendered.renderOnce()
  if (!screen) throw new Error("the lead screen did not mount")
  open(screen)
  for (let frame = 0; frame < 4; frame += 1) {
    await settle()
    await rendered.renderOnce()
  }
  return rendered.captureCharFrame().split("\n").slice(0, HEIGHT)
}

describe("a lead view over the lead's screen", () => {
  it("the chat viewer covers the whole terminal, so no border of the lead's composer shows beside or below it", async () => {
    const lines = await leadScreen((screen) => { screen.openChat("asks") })
    expect(lines.join("\n")).not.toContain("Lead composer")
    expect(lines.join("\n")).not.toContain("Lead transcript")
    // The terminal's edge columns and rows lie outside the view's frame.
    const edges = [lines[0] ?? "", lines.at(-1) ?? "", ...lines.map((line) => `${line.charAt(0)}${line.charAt(WIDTH - 1)}`)]
    expect(edges.join("").trim()).toBe("")
  })
})
