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

/** The text of the row painted in the selection style. */
const selectedRow = (rendered: Rendered): string | undefined => rendered.captureSpans().lines
  .find((line) => line.spans.some((span) => span.text.trim().length > 0 && span.bg.equals(theme.selectionBackground)))
  ?.spans.map((span) => span.text).join("").trim()

describe("the lead list", () => {
  it("shows one row for each chat, needs-you first and the longest wait first, in the chat's own words with a state word and an age", async () => {
    const strip = await mountStrip([
      leadRow("done", "result", { update: "All tests pass." }),
      leadRow("busy", "working", { update: "Reading the auth module." }),
      leadRow("asks", "question", { waitingSince: Date.now() - 10 * 60_000, update: "Which provider should I use?" }),
      leadRow("broke", "failed", { waitingSince: Date.now() - 20 * 60_000 }),
    ])
    expect(strip.lines()).toEqual([
      expect.stringMatching(/^ {2}✗ failed {4}Chat broke {2}Update from broke +5m$/),
      expect.stringMatching(/^ {2}\? question {2}Chat asks {2}Which provider should I use\? +5m$/),
      expect.stringMatching(/^ {2}● working {3}Chat busy {2}Reading the auth module\. +5m$/),
      expect.stringMatching(/^ {2}✓ result {4}Chat done {2}All tests pass\. +5m$/),
      "  ↓ list · ctrl+g longest wait",
    ])
  })

  it("paints each state's mark in its own tone, with every chat that needs the person in an accent tone", async () => {
    const strip = await mountStrip([leadRow("asks", "question"), leadRow("broke", "failed"), leadRow("stopped", "cut"), leadRow("busy", "working"), leadRow("done", "result")])
    const markTone = (mark: string) => strip.rendered.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === mark)?.fg
    expect(markTone("?")?.equals(theme.warning)).toBe(true)
    expect(markTone("✗")?.equals(theme.error)).toBe(true)
    expect(markTone("■")?.equals(theme.warning)).toBe(true)
    expect(markTone("●")?.equals(theme.primary)).toBe(true)
    expect(markTone("✓")?.equals(theme.success)).toBe(true)
  })

  it("renders nothing with no rows or on another chat's screen", async () => {
    const empty = await mountStrip([])
    expect(empty.lines()).toEqual([])
    const other = await mountStrip([leadRow("busy", "working")], { sessionId: "chat-9" })
    expect(other.lines()).toEqual([])
    other.setSessionId(LEAD_ID)
    await other.rendered.renderOnce()
    expect(other.lines()).toHaveLength(2)
  })

  it("never wraps a long row at widths 80 and 140", async () => {
    for (const width of [80, 140]) {
      const strip = await mountStrip([leadRow("long", "working", { update: "word ".repeat(80) })], { width })
      expect(strip.lines()).toHaveLength(2)
      expect(strip.lines()[0]).toEndWith("5m")
    }
  })

  it("shows 6 of 30 rows, '+24 more', and the hint line on 24 terminal rows, and keeps the selection in view", async () => {
    const strip = await mountStrip(Array.from({ length: 30 }, (_, index) => leadRow(`c${String(index).padStart(2, "0")}`, "working", { since: Date.now() - index * 60_000 })))
    expect(strip.lines()).toHaveLength(8)
    expect(strip.lines()[6]).toBe("  +24 more")
    await strip.key("down")
    for (let step = 0; step < 9; step += 1) await strip.key("down")
    expect(strip.lines()).toHaveLength(8)
    expect(selectedRow(strip.rendered)).toStartWith("● working   Chat c09")
    expect(strip.lines()[7]).toBe("  ↑↓ move · enter open · space peek · ctrl+o chat · ctrl+t tab · esc input")
  })

  it("takes focus on Down only while the composer is empty, and Space types nothing", async () => {
    const strip = await mountStrip([leadRow("a", "working"), leadRow("b", "result")])
    strip.setComposerEmpty(false)
    expect(await strip.key("down")).toBe(false)
    expect(strip.focused()).toBe(false)
    strip.setComposerEmpty(true)
    expect(await strip.key("down")).toBe(true)
    expect(strip.focused()).toBe(true)
    expect(selectedRow(strip.rendered)).toStartWith("● working   Chat a")
    expect(await strip.key("space")).toBe(true)
    expect(await strip.key("escape")).toBe(true)
    expect(strip.focused()).toBe(false)
  })

  it("keeps the selection on its chat when rows reorder and moves it to the next row when its row goes", async () => {
    const strip = await mountStrip([leadRow("a", "working"), leadRow("b", "working", { since: Date.now() - 6 * 60_000 }), leadRow("c", "working", { since: Date.now() - 7 * 60_000 })])
    await strip.key("down")
    await strip.key("down")
    expect(selectedRow(strip.rendered)).toStartWith("● working   Chat b")
    strip.setView((view) => ({ ...view, rows: [leadRow("new", "question"), ...view.rows] }))
    await strip.rendered.renderOnce()
    expect(selectedRow(strip.rendered)).toStartWith("● working   Chat b")
    strip.setView((view) => ({ ...view, rows: view.rows.filter((row) => row.sessionId !== "b") }))
    await strip.rendered.renderOnce()
    expect(selectedRow(strip.rendered)).toStartWith("● working   Chat c")
  })

  it("opens the chat that has waited longest on ctrl+g, and nothing while no chat waits", async () => {
    const strip = await mountStrip([leadRow("busy", "working"), leadRow("late", "cut", { waitingSince: Date.now() - 60_000 }), leadRow("early", "failed", { waitingSince: Date.now() - 90 * 60_000 })])
    expect(await strip.key("g", { ctrl: true })).toBe(true)
    expect(strip.overlay.viewer.stack).toHaveLength(1)
    expect(strip.rendered.captureCharFrame()).toContain("Chat early")
    const idle = await mountStrip([leadRow("busy", "working")])
    expect(await idle.key("g", { ctrl: true })).toBe(false)
    expect(idle.overlay.viewer.stack).toHaveLength(0)
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
