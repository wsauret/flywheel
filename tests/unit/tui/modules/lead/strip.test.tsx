/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
import { LEAD_ID, leadRow, mountStrip as mountLeadStrip } from "./_lead-fixtures.js"

type Rendered = Awaited<ReturnType<typeof mountStrip>>["rendered"]
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

async function mountStrip(...args: Parameters<typeof mountLeadStrip>) {
  const strip = await mountLeadStrip(...args)
  cleanups.push(strip.dispose)
  return strip
}

const theme = resolveTheme(flywheelTheme, "dark")
const HINT = "  ↑↓ move · enter open · ctrl+t tab · x close · esc input"

/** The text of the row painted in the selection style. */
const selectedRow = (rendered: Rendered): string | undefined => rendered.captureSpans().lines
  .find((line) => line.spans.some((span) => span.text.trim().length > 0 && span.bg.equals(theme.selectionBackground)))
  ?.spans.map((span) => span.text).join("").trim()

describe("the lead list", () => {
  it("shows one short row for each chat, needs-you first and the longest wait first: a mark, the title, the chat's status, and an age", async () => {
    const strip = await mountStrip([
      leadRow("done", "result", { status: "All tests pass." }),
      leadRow("busy", "working", { status: "Edited core.py" }),
      leadRow("asks", "question", { waitingSince: Date.now() - 10 * 60_000, status: "Which provider should I use?" }),
      leadRow("broke", "failed", { waitingSince: Date.now() - 20 * 60_000, status: "failed" }),
    ])
    expect(strip.lines()).toEqual([
      "  ✗ Chat broke  failed  5m",
      "  ? Chat asks   Which provider should I use?  5m",
      "  ● Chat busy   Edited core.py  5m",
      "  ✓ Chat done   All tests pass.  5m",
    ])
  })

  it("paints each state's mark in its own tone, with every chat that needs the person in the warning tone", async () => {
    const strip = await mountStrip([leadRow("asks", "question"), leadRow("broke", "failed"), leadRow("stopped", "cut"), leadRow("busy", "working"), leadRow("unread", "result")])
    const markTone = (mark: string) => strip.rendered.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.startsWith(mark))?.fg
    expect(markTone("?")?.equals(theme.warning)).toBe(true)
    expect(markTone("✗")?.equals(theme.warning)).toBe(true)
    expect(markTone("■")?.equals(theme.warning)).toBe(true)
    expect(markTone("●")?.equals(theme.primary)).toBe(true)
    expect(markTone("✓")?.equals(theme.success)).toBe(true)
    // The list shows five rows at most, so a done row is a list of its own.
    const done = await mountStrip([leadRow("done", "done")])
    const doneTone = done.rendered.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.startsWith("·"))?.fg
    expect(doneTone?.equals(theme.textMuted)).toBe(true)
  })

  it("x closes the selected chat with no question, and the selection moves to the next row, to the row before at the end, or back to the input", async () => {
    const strip = await mountStrip([leadRow("a", "working"), leadRow("b", "done", { since: Date.now() - 6 * 60_000 }), leadRow("c", "done", { since: Date.now() - 7 * 60_000 })])
    // x types into the input while the list has no focus.
    expect(await strip.key("x")).toBe(false)
    await strip.key("down")
    expect(await strip.key("x")).toBe(true)
    expect(strip.sent).toEqual(["session.close a"])
    expect(strip.overlay.dialog.stack).toHaveLength(0)
    expect(selectedRow(strip.rendered)).toStartWith("· Chat b")
    // The row leaves once the runtime records the close.
    strip.setView((view) => ({ ...view, rows: view.rows.filter((row) => row.sessionId !== "a") }))
    await strip.rendered.renderOnce()
    await strip.key("down")
    await strip.key("x")
    expect(selectedRow(strip.rendered)).toStartWith("· Chat b")
    strip.setView((view) => ({ ...view, rows: view.rows.filter((row) => row.sessionId !== "c") }))
    await strip.rendered.renderOnce()
    await strip.key("x")
    expect(strip.sent).toEqual(["session.close a", "session.close c", "session.close b"])
    expect(strip.focused()).toBe(false)
  })

  it("shows a muted close mark at the right end of the row under the pointer only; a click on it closes the chat, and a click elsewhere on the row opens it", async () => {
    const strip = await mountStrip([leadRow("a", "working"), leadRow("b", "done")], { width: 80, height: 30 })
    const rowOf = (title: string) => strip.lines().findIndex((line) => line.includes(title))
    expect(strip.lines().some((line) => line.includes("×"))).toBe(false)
    await strip.rendered.mockMouse.moveTo(10, rowOf("Chat b"))
    await strip.rendered.renderOnce()
    const frame = strip.rendered.captureCharFrame().split("\n")
    const markLine = frame[rowOf("Chat b")]!
    expect(markLine.trimEnd().endsWith("×")).toBe(true)
    expect(frame[rowOf("Chat a")]).not.toContain("×")
    const markColumn = markLine.lastIndexOf("×")
    // The mark sits at the list's right inset, inside the 80 columns, and the row text did not move.
    expect(markColumn).toBe(80 - 2 - 1)
    const markSpan = strip.rendered.captureSpans().lines[rowOf("Chat b")]!.spans.find((span) => span.text.includes("×"))
    expect(markSpan?.fg.equals(theme.textMuted)).toBe(true)
    expect(markSpan?.bg.equals(theme.backgroundElement)).toBe(true)

    await strip.rendered.mockMouse.click(markColumn, rowOf("Chat b"))
    await strip.rendered.renderOnce()
    expect(strip.sent).toEqual(["session.close b"])
    expect(strip.overlay.viewer.stack).toHaveLength(0)

    await strip.rendered.mockMouse.click(10, rowOf("Chat a"))
    await strip.rendered.renderOnce()
    expect(strip.sent).toEqual(["session.close b"])
    expect(strip.overlay.viewer.stack).toHaveLength(1)
  })

  it("renders nothing with no rows or on another chat's screen", async () => {
    const empty = await mountStrip([])
    expect(empty.lines()).toEqual([])
    const other = await mountStrip([leadRow("busy", "working")], { sessionId: "chat-9" })
    expect(other.lines()).toEqual([])
    other.setSessionId(LEAD_ID)
    await other.rendered.renderOnce()
    expect(other.lines()).toHaveLength(1)
  })

  it("cuts the title at 24 columns and the status at 48, or the room that is left, with an ellipsis, so no row wraps at widths 80 and 140", async () => {
    for (const [width, status] of [[80, `${"word ".repeat(8)}w…`], [140, `${"word ".repeat(9)}wo…`]] as const) {
      const strip = await mountStrip([leadRow("long", "working", { status: "word ".repeat(80) })], { width, titles: { long: "A very long chat title that goes on" } })
      expect(strip.lines()).toEqual([`  ● A very long chat title…   ${status}  5m`])
    }
  })

  it("shows 5 of 30 rows and '+25 more', keeps the selection in view, and counts the rows scrolled above and below", async () => {
    const strip = await mountStrip(Array.from({ length: 30 }, (_, index) => leadRow(`c${String(index).padStart(2, "0")}`, "working", { since: Date.now() - index * 60_000 })))
    expect(strip.lines()).toHaveLength(6)
    expect(strip.lines()[5]).toBe("  +25 more")
    await strip.key("down")
    for (let step = 0; step < 9; step += 1) await strip.key("down")
    expect(strip.lines()).toHaveLength(8)
    expect(strip.lines()[0]).toBe("  +5 above")
    expect(strip.lines()[6]).toBe("  +20 more")
    expect(selectedRow(strip.rendered)).toStartWith("● Chat c09")
  })

  it("shows the key hint only while the list has focus; Down takes focus only on an empty input, and Up from the top or Escape gives it back", async () => {
    const strip = await mountStrip([leadRow("a", "working"), leadRow("b", "result")])
    expect(strip.lines()).not.toContain(HINT)
    strip.setComposerEmpty(false)
    expect(await strip.key("down")).toBe(false)
    expect(strip.focused()).toBe(false)
    strip.setComposerEmpty(true)
    expect(await strip.key("down")).toBe(true)
    expect(strip.focused()).toBe(true)
    expect(strip.lines().at(-1)).toBe(HINT)
    expect(selectedRow(strip.rendered)).toStartWith("● Chat a")
    expect(await strip.key("up")).toBe(true)
    expect(strip.focused()).toBe(false)
    expect(strip.lines()).not.toContain(HINT)
    await strip.key("down")
    expect(await strip.key("escape")).toBe(true)
    expect(strip.focused()).toBe(false)
  })

  it("claims no Space, ctrl+o, or ctrl+g, which therefore reach the input", async () => {
    const strip = await mountStrip([leadRow("a", "question")])
    expect(strip.chords()).toEqual(["up", "down", "enter", "ctrl+t", "x"])
    await strip.key("down")
    expect(await strip.key("space")).toBe(false)
    expect(await strip.key("o", { ctrl: true })).toBe(false)
    expect(await strip.key("g", { ctrl: true })).toBe(false)
    expect(strip.overlay.viewer.stack).toHaveLength(0)
  })

  it("keeps the selection on its chat when rows reorder and moves it to the next row when its row goes", async () => {
    const strip = await mountStrip([leadRow("a", "working"), leadRow("b", "working", { since: Date.now() - 6 * 60_000 }), leadRow("c", "working", { since: Date.now() - 7 * 60_000 })])
    await strip.key("down")
    await strip.key("down")
    expect(selectedRow(strip.rendered)).toStartWith("● Chat b")
    strip.setView((view) => ({ ...view, rows: [leadRow("new", "question"), ...view.rows] }))
    await strip.rendered.renderOnce()
    expect(selectedRow(strip.rendered)).toStartWith("● Chat b")
    strip.setView((view) => ({ ...view, rows: view.rows.filter((row) => row.sessionId !== "b") }))
    await strip.rendered.renderOnce()
    expect(selectedRow(strip.rendered)).toStartWith("● Chat c")
  })

  it("opens no view when a question row arrives while the person types", async () => {
    const strip = await mountStrip([leadRow("busy", "working")])
    strip.setComposerEmpty(false)
    strip.setView((view) => ({ ...view, rows: [...view.rows, leadRow("asks", "question")] }))
    await strip.rendered.renderOnce()
    expect(strip.overlay.viewer.stack).toHaveLength(0)
    expect(strip.focused()).toBe(false)
    expect(strip.lines()[0]).toContain("Chat asks")
  })
})
