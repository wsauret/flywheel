/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { QuestionBlock } from "../../../../../src/infra/output-blocks.js"
import type { FrontendOutputBlock } from "../../../../../src/protocol/app-service-types.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { leadQuestionCall, type LeadQuestionOutcome } from "../../../../../src/protocol/modules/lead.js"
import { ClientExtensionProviders, ClientExtensionsProvider } from "../../../../../src/tui/context/client-extensions.js"
import { NavigationProvider } from "../../../../../src/tui/context/navigation.js"
import { createBlockDisclosureChannel } from "../../../../../src/tui/context/block-disclosure.js"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import { LeadStrip } from "../../../../../src/tui/modules/lead/strip.js"
import { OutputWindow } from "../../../../../src/tui/output-window/output-window.js"
import type { TuiStripKeyEvent } from "../../../../../src/tui/tui-module.js"
import { transcriptOf } from "../../_output-window-transcript.js"
import { withHeldDeadlines } from "../../../protocol/client/_connection-fixtures.js"
import { LEAD_ID, leadHarness } from "./_lead-fixtures.js"

const CONTEXT = "The login page has two forms."
const theme = resolveTheme(flywheelTheme, "dark")

function question(toolUseId: string, text: string, timestamp: number): QuestionBlock {
  return {
    kind: "question", toolUseId, timestamp, questions: [{
      question: text, header: "Form", multiSelect: false, choices: [
        { kind: "option", choiceId: "a", label: "Sign-in form", description: "The form on the start page", recommended: true },
        { kind: "option", choiceId: "b", label: "Sign-up form" },
        { kind: "freeform", label: "Other" },
      ],
    }],
  }
}

/** The message by which the runtime posts a chat's question to the lead. */
function questionMessage(chat: string, toolUseId: string, timestamp: number): FrontendOutputBlock {
  return {
    kind: "userMessage", id: `msg:${chat}:${leadQuestionCall(toolUseId)}`, content: "Question text", timestamp, pending: false, injected: false,
    from: { sessionId: chat, name: `Chat ${chat}`, relation: "other" },
  }
}

/** The lead's tab over `blocks` with the lead's strip below it, whose key claim is the kernel's in its simplest form. */
async function mountLead(blocks: readonly FrontendOutputBlock[], outcomes: { readonly [key: string]: LeadQuestionOutcome } = {}, failingReads: { readonly [key: string]: number } = {}, height = 60) {
  const lead = leadHarness([])
  for (const [key, outcome] of Object.entries(outcomes)) lead.outcomes.set(key, outcome)
  for (const [key, failures] of Object.entries(failingReads)) lead.failingReads.set(key, failures)
  const disclosure = createBlockDisclosureChannel()
  const [focused, setFocused] = createSignal(false)
  const [composerEmpty, setComposerEmpty] = createSignal(true)
  let handler: ((event: TuiStripKeyEvent) => boolean) | undefined
  let pasteHandler: ((text: string) => boolean) | undefined
  const result = await testRender(() => (
    <ThemeProvider mode="dark"><TickPoolProvider><ClientExtensionsProvider value={[lead.client]}><ClientExtensionProviders><NavigationProvider value={() => {}}>
      <box flexDirection="column">
        <OutputWindow
          layoutSlot={{ sessionId: LEAD_ID }}
          transcript={{ ...transcriptOf(blocks), ...disclosure }}
          running={false}
          sessionIntro={{
            moduleRows: () => [], runtimeIdentity: () => ({ version: "0.0.1", buildId: null }), showBuild: () => false,
            projectRoot: () => "/Users/test/project", accountHome: "/Users/test", userDataRoot: "/Users/test/.flywheel",
            branchName: () => undefined, sessionKind: () => "chat", modelLabel: () => "model", profileName: () => "default",
            fontTipDismissed: () => false, tabsHintDismissed: () => false, onDismissTabsHint: () => {}, availableWidth: () => 80, noProviderReady: () => false,
          }}
        />
        <LeadStrip sessionId={LEAD_ID} read={moduleDomainReader(() => undefined)} width={() => 100} openSurface={() => {}} composer={{ empty: composerEmpty }}
          keys={{ claim: (input) => { handler = input.onKey; pasteHandler = input.onPaste; return { focused, setFocused } } }} />
      </box>
    </NavigationProvider></ClientExtensionProviders></ClientExtensionsProvider></TickPoolProvider></ThemeProvider>
  ), { width: 100, height })
  const frame = async (): Promise<string> => {
    for (let turn = 0; turn < 4; turn += 1) {
      await result.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await result.renderOnce()
    return result.captureCharFrame()
  }
  const key = async (name: string, modifiers: Omit<TuiStripKeyEvent, "name"> = {}): Promise<boolean> => {
    const taken = handler?.({ name, ...modifiers }) ?? false
    await frame()
    return taken
  }
  const paste = async (text: string): Promise<boolean> => {
    const taken = pasteHandler?.(text) ?? false
    await frame()
    return taken
  }
  return { ...lead, result, frame, key, paste, focused, setComposerEmpty, dispose: () => { result.renderer.destroy(); lead.dispose() } }
}

describe("a chat's question in the lead's transcript (PI-LEAD-005)", () => {
  it("shows the question word for word under a line that names its chat, answers it through the chat's own answer, and settles in place to the answer", async () => {
    const tab = await mountLead([questionMessage("c1", "ask-1", 1000)], {
      "c1 ask-1": { state: "pending", question: question("ask-1", "Which form should change?", 1000), context: CONTEXT },
    })
    tab.setQuestions({ c1: question("ask-1", "Which form should change?", 1000) })
    try {
      let frame = await tab.frame()
      expect(frame).toContain("Question · Chat c1 · open")
      expect(frame).toContain(CONTEXT)
      expect(frame).toContain("Which form should change?")
      expect(frame).toContain("Sign-in form")
      expect(frame).toContain("(Recommended)")
      expect(frame).toContain("The form on the start page")
      expect(frame).toContain("Sign-up form")
      expect(frame).toContain("Other")
      expect(frame).toContain("Submit")
      // The widget never takes focus by itself: keys reach the lead's input until the person moves into it. Plain Up
      // stays with the input, which recalls queued messages and history with it (PI-INTERACTION-123).
      expect(tab.focused()).toBe(false)
      expect(await tab.key("up")).toBe(false)
      tab.setComposerEmpty(false)
      expect(await tab.key("up", { shift: true })).toBe(false)
      tab.setComposerEmpty(true)
      expect(tab.focused()).toBe(false)
      expect(await tab.key("up", { shift: true })).toBe(true)
      expect(tab.focused()).toBe(true)
      await tab.key("2")
      await tab.key("return")
      expect(tab.sent).toContain("question.answer c1 ask-1")

      // The question settles wherever the person answers it, and the widget changes in place to the answer.
      tab.outcomes.set("c1 ask-1", { state: "answered", answers: { "Which form should change?": "Sign-up form" } })
      tab.setQuestions({})
      frame = await tab.frame()
      expect(frame).toContain("Question · Chat c1 · open")
      expect(frame).toContain("Answered: Sign-up form")
      expect(frame).not.toContain("The form on the start page")
      expect(tab.focused()).toBe(false)
    } finally { tab.dispose() }
  })

  it("keeps several questions pending at once, each answered on its own, and moves between them with shift and the arrows", async () => {
    const tab = await mountLead([questionMessage("c1", "ask-1", 1000), questionMessage("c2", "ask-2", 2000)], {
      "c1 ask-1": { state: "pending", question: question("ask-1", "First question?", 1000), context: null },
      "c2 ask-2": { state: "pending", question: question("ask-2", "Second question?", 2000), context: null },
    })
    try {
      const frame = await tab.frame()
      expect(frame).toContain("First question?")
      expect(frame).toContain("Second question?")
      // Shift+Up enters the newest, and again moves to the one before it.
      await tab.key("up", { shift: true })
      await tab.key("up", { shift: true })
      await tab.key("1")
      await tab.key("return")
      expect(tab.sent.filter((line) => line.startsWith("question."))).toEqual(["question.answer c1 ask-1"])
      // A sent answer gives the keys back to the lead's input; Escape leaves a widget with its question pending.
      expect(tab.focused()).toBe(false)
      await tab.key("up", { shift: true })
      expect(tab.focused()).toBe(true)
      await tab.key("escape")
      expect(tab.focused()).toBe(false)
      expect(tab.sent.filter((line) => line.startsWith("question."))).toEqual(["question.answer c1 ask-1"])
    } finally { tab.dispose() }
  })

  it("shows which widget holds the keys by its rail and its cursor row, with no row moved", async () => {
    const tab = await mountLead([questionMessage("c1", "ask-1", 1000)], {
      "c1 ask-1": { state: "pending", question: question("ask-1", "Which form should change?", 1000), context: null },
    })
    try {
      const look = async () => {
        await tab.frame()
        const lines = tab.result.captureSpans().lines
        const spans = (text: string) => lines.find((line) => line.spans.some((span) => span.text.includes(text)))?.spans ?? []
        return {
          rows: (await tab.frame()).split("\n").findIndex((row) => row.includes("Sign-up form")),
          rail: spans("Which form should change?").find((span) => span.text.includes("┃"))?.fg,
          cursor: spans("Sign-in form").find((span) => span.text.includes("Sign-in form"))?.fg,
        }
      }
      const idle = await look()
      expect(idle.rail?.equals(theme.border)).toBe(true)
      expect(idle.cursor?.equals(theme.textMuted)).toBe(true)
      await tab.key("up", { shift: true })
      const focused = await look()
      expect(focused.rail?.equals(theme.primary)).toBe(true)
      expect(focused.cursor?.equals(theme.text)).toBe(true)
      expect(focused.rows).toBe(idle.rows)
      // Up and Down inside the focused widget move its option cursor.
      await tab.key("down")
      const spans = tab.result.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.find((span) => span.text.includes("Sign-up form"))?.fg.equals(theme.text)).toBe(true)
      expect(spans.find((span) => span.text.includes("Sign-in form"))?.fg.equals(theme.textMuted)).toBe(true)
      await tab.key("up")
      expect(tab.result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Sign-in form"))?.fg.equals(theme.text)).toBe(true)
    } finally { tab.dispose() }
  })

  it("scrolls the transcript to a widget that a key moves focus to, and leaves the view when the widget shows in full", async () => {
    const tab = await mountLead([questionMessage("c1", "ask-1", 1000), questionMessage("c2", "ask-2", 2000)], {
      "c1 ask-1": { state: "pending", question: question("ask-1", "First question?", 1000), context: null },
      "c2 ask-2": { state: "pending", question: question("ask-2", "Second question?", 2000), context: null },
    }, {}, 22)
    try {
      const before = await tab.frame()
      expect(before).not.toContain("First question?")
      expect(before).toContain("Second question?")
      // The newest widget shows in full, so entering it moves nothing.
      await tab.key("up", { shift: true })
      expect(await tab.frame()).toBe(before)
      await tab.key("up", { shift: true })
      const revealed = (await tab.frame()).split("\n")
      const top = revealed.findIndex((row) => row.includes("First question?"))
      expect(top).toBeGreaterThanOrEqual(0)
      // The widget's heading line, which names its chat, shows too.
      expect(revealed.slice(0, top).some((row) => row.includes("Chat c1"))).toBe(true)
      // The whole widget shows: its last row, the key hint, comes before the next chat's line.
      const next = revealed.findIndex((row, index) => index > top && row.includes("Chat c2"))
      expect(revealed.slice(top, next < 0 ? undefined : next).some((row) => row.includes("shift+↑ from the empty input"))).toBe(true)
    } finally { tab.dispose() }
  })

  it("answers with the mouse: a click picks an option and only Submit sends it, and Skip skips another question", async () => {
    const tab = await mountLead([questionMessage("c1", "ask-1", 1000), questionMessage("c2", "ask-2", 2000)], {
      "c1 ask-1": { state: "pending", question: question("ask-1", "First question?", 1000), context: null },
      "c2 ask-2": { state: "pending", question: question("ask-2", "Second question?", 2000), context: null },
    })
    try {
      const click = async (text: string, nth = 0): Promise<void> => {
        const rows = (await tab.frame()).split("\n")
        const y = rows.flatMap((row, index) => row.includes(text) ? [index] : [])[nth]
        if (y === undefined) throw new Error(`no row shows ${text}`)
        await tab.result.mockMouse.click(rows[y]!.indexOf(text) + 1, y)
        await tab.frame()
      }
      await click("Sign-up form")
      expect(tab.sent.filter((line) => line.startsWith("question."))).toEqual([])
      await click("Submit")
      await click("Skip", 1)
      expect(tab.sent.filter((line) => line.startsWith("question."))).toEqual(["question.answer c1 ask-1", "question.cancel c2 ask-2"])
    } finally { tab.dispose() }
  })

  it("gives a widget the keys on a click in its Other field, so typed and pasted text land in the answer", async () => {
    const tab = await mountLead([questionMessage("c1", "ask-1", 1000)], {
      "c1 ask-1": { state: "pending", question: question("ask-1", "Which form should change?", 1000), context: null },
    })
    try {
      // On a plain option the widget has no field for text, so a paste stays with the lead's input.
      await tab.frame()
      await tab.key("up", { shift: true })
      expect(tab.focused()).toBe(true)
      expect(await tab.paste("stray")).toBe(false)
      await tab.key("escape")
      const rows = (await tab.frame()).split("\n")
      const y = rows.findIndex((row) => row.includes("Other"))
      await tab.result.mockMouse.click(rows[y]!.indexOf("Other") + 1, y)
      await tab.frame()
      expect(tab.focused()).toBe(true)
      await tab.key("h", { sequence: "h" })
      await tab.key("i", { sequence: "i" })
      expect(await tab.paste(" there")).toBe(true)
      expect(await tab.frame()).toContain("hi there")
      await tab.key("return")
      expect(tab.sent.filter((line) => line.startsWith("question."))).toEqual(["question.answer c1 ask-1"])
    } finally { tab.dispose() }
  })

  it("reads a question again with backoff after a read fails, with no change of the chat's question", async () => {
    await withHeldDeadlines(250, async (expire) => {
      const tab = await mountLead([questionMessage("c1", "ask-1", 1000)], {
        "c1 ask-1": { state: "pending", question: question("ask-1", "Which form should change?", 1000), context: null },
      }, { "c1 ask-1": 1 })
      try {
        expect(await tab.frame()).not.toContain("Which form should change?")
        expire()
        expect(await tab.frame()).toContain("Which form should change?")
        expect(tab.questionReads).toEqual(["c1 ask-1", "c1 ask-1"])
      } finally { tab.dispose() }
    })
  })

  it("reads again on a change of a chat's question only for the widgets that still wait, not for settled ones", async () => {
    const settled = ["ask-1", "ask-2", "ask-3"]
    const tab = await mountLead([...settled.map((id, index) => questionMessage("c1", id, 1000 + index)), questionMessage("c1", "ask-4", 2000)], {
      ...Object.fromEntries(settled.map((id) => [`c1 ${id}`, { state: "answered", answers: { "Which form should change?": "Sign-in form" } } satisfies LeadQuestionOutcome])),
      "c1 ask-4": { state: "pending", question: question("ask-4", "Which form should change?", 2000), context: null },
    })
    try {
      await tab.frame()
      const before = tab.questionReads.length
      tab.setQuestions({ c1: question("ask-5", "Another question?", 3000) })
      await tab.frame()
      expect(tab.questionReads.slice(before)).toEqual(["c1 ask-4"])
    } finally { tab.dispose() }
  })

  it("shows a question that the person skipped, or that the chat withdrew, as settled", async () => {
    const tab = await mountLead([questionMessage("c1", "ask-1", 1000), questionMessage("c2", "ask-2", 2000)], {
      "c1 ask-1": { state: "skipped" }, "c2 ask-2": { state: "withdrawn" },
    })
    try {
      const frame = await tab.frame()
      expect(frame).toContain("Skipped")
      expect(frame).toContain("Withdrawn by the chat")
    } finally { tab.dispose() }
  })
})
