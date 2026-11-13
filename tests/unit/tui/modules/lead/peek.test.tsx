/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
import { leadRow, mountStrip } from "./_lead-fixtures.js"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const updates = (count: number) => Array.from({ length: count }, (_, index) => ({ text: `Update number ${index + 1}`, at: index }))

describe("the lead peek", () => {
  it("shows a row's request, its latest five updates oldest first, its changed files, and the count, in the chat's own words", async () => {
    const strip = await mountStrip([
      leadRow("busy", "working", { request: { entryId: "ask", text: "Please fix the flaky login test" }, updates: updates(6) }),
      leadRow("asks", "question"),
      leadRow("stuck", "cut"),
    ], { width: 100, height: 40, changes: { busy: ["src/login.ts", "tests/login.test.ts"] } })
    cleanups.push(strip.dispose)
    await strip.key("down")
    await strip.key("down")
    await strip.key("down")
    expect(await strip.key("space")).toBe(true)
    expect(strip.overlay.viewer.stack).toHaveLength(1)
    const frame = strip.rendered.captureCharFrame()
    expect(frame).toContain("Chat busy")
    expect(frame).toContain("Please fix the flaky login test")
    const shown = [2, 3, 4, 5, 6].map((index) => frame.indexOf(`Update number ${index}`))
    expect(shown.every((at) => at >= 0)).toBe(true)
    expect([...shown].sort((left, right) => left - right)).toEqual(shown)
    expect(frame).not.toMatch(/Update number 1(?!\d)/)
    expect(frame).toContain("src/login.ts")
    expect(frame).toContain("tests/login.test.ts")
    const count = strip.rendered.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes("2 need you"))
    expect(count.length).toBeGreaterThan(0)
    expect(count.every((span) => span.fg.equals(resolveTheme(flywheelTheme, "dark").warning))).toBe(true)
  })

  it("keeps its title, count, input, and hint in view on 80x24 with a long request, five updates, and many files, and pages the rest", async () => {
    const request = Array.from({ length: 6 }, (_, index) => `Request line ${index + 1} of the work to do.`).join("\n")
    const files = Array.from({ length: 10 }, (_, index) => `src/file-${index + 1}.ts`)
    const strip = await mountStrip([
      leadRow("busy", "working", { request: { entryId: "ask", text: request }, updates: updates(5) }),
      leadRow("asks", "question"),
    ], { width: 80, height: 24, changes: { busy: files } })
    cleanups.push(strip.dispose)
    await strip.key("down")
    await strip.key("down")
    await strip.key("space")
    const frame = strip.rendered.captureCharFrame()
    expect(frame).toContain("Chat busy")
    expect(frame).toContain("1 needs you")
    expect(frame).toContain("Message this chat")
    expect(frame).toContain("enter send · pgup pgdn scroll · esc back")
    expect(frame).toContain("Request line 1")
    expect(frame).not.toContain("+2 more")
    for (let page = 0; page < 3; page += 1) await strip.viewerKey("pagedown")
    const paged = strip.rendered.captureCharFrame()
    expect(paged).toContain("+2 more")
    expect(paged).toContain("Message this chat")
    expect(paged).toContain("enter send · pgup pgdn scroll · esc back")
  })

  it("sends the person's text unchanged, with its surrounding spaces", async () => {
    const strip = await mountStrip([leadRow("busy", "working")])
    cleanups.push(strip.dispose)
    await strip.key("down")
    await strip.key("space")
    for (const letter of "  go ") await strip.viewerKey(letter === " " ? "space" : letter)
    await strip.viewerKey("return")
    expect(strip.sent).toEqual(["session.send busy   go "])
  })

  it("sends typed text and Enter as one message to that chat, and Escape goes back to the list", async () => {
    const strip = await mountStrip([leadRow("busy", "working")])
    cleanups.push(strip.dispose)
    await strip.key("down")
    await strip.key("space")
    for (const letter of "go on") await strip.viewerKey(letter === " " ? "space" : letter)
    await strip.viewerKey("return")
    expect(strip.sent).toEqual(["session.send busy go on"])
    expect(strip.overlay.viewer.stack).toHaveLength(1)
    await strip.viewerKey("escape")
    expect(strip.overlay.viewer.stack).toHaveLength(0)
    expect(strip.focused()).toBe(true)
  })
})
