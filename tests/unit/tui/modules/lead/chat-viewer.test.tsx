/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
import { textBlock } from "../../_output-window-transcript.js"
import { choiceQuestion, leadRow, mountStrip } from "./_lead-fixtures.js"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** Three chats in list order: `asks` and `broke` need the person, `busy` works. */
async function openViewer() {
  const strip = await mountStrip([
    leadRow("busy", "working"),
    leadRow("asks", "question", { waitingSince: Date.now() - 20 * 60_000 }),
    leadRow("broke", "failed", { waitingSince: Date.now() - 10 * 60_000 }),
  ], { width: 100, height: 40 })
  cleanups.push(strip.dispose)
  await strip.key("down")
  expect(await strip.key("o", { ctrl: true })).toBe(true)
  return strip
}

/** The chat the viewer's own title names, not a row of the list under it. */
const title = (frame: string): string | undefined => /│\s+Chat (\w+)\s+x\s+│/.exec(frame)?.[1]

describe("the lead's full-chat viewer", () => {
  it("declares its chords to the kernel", async () => {
    const strip = await mountStrip([leadRow("busy", "working")])
    cleanups.push(strip.dispose)
    expect(strip.chords()).toEqual(expect.arrayContaining(["space", "ctrl+o", "ctrl+t"]))
  })

  it("shows the row's chat over the lead, moves through the list order on Tab and Shift+Tab, and stays at the ends", async () => {
    const strip = await openViewer()
    expect(strip.overlay.viewer.stack).toHaveLength(1)
    expect(title(strip.rendered.captureCharFrame())).toBe("asks")
    await strip.viewerKey("tab")
    expect(title(strip.rendered.captureCharFrame())).toBe("broke")
    await strip.viewerKey("tab")
    expect(title(strip.rendered.captureCharFrame())).toBe("busy")
    await strip.viewerKey("tab")
    expect(title(strip.rendered.captureCharFrame())).toBe("busy")
    // The harness draws the viewer under the list; with the list gone, the viewer's navigation row is on screen.
    strip.setSessionId("elsewhere")
    await strip.viewerKey("pagedown")
    expect(strip.rendered.captureCharFrame()).toContain("Previous chat")
    expect(strip.rendered.captureCharFrame()).not.toContain("Next chat")
    for (let step = 0; step < 3; step += 1) await strip.viewerKey("tab", { shift: true })
    expect(title(strip.rendered.captureCharFrame())).toBe("asks")
  })

  it("keeps each chat's draft with that chat across Tab", async () => {
    const strip = await openViewer()
    for (const letter of "yes") await strip.viewerKey(letter)
    await strip.viewerKey("tab")
    await strip.viewerKey("return")
    expect(strip.sent).toEqual([])
    await strip.viewerKey("tab", { shift: true })
    await strip.viewerKey("return")
    expect(strip.sent).toEqual(["session.send asks yes"])
  })

  it("leaves another chat's draft unchanged when a send's receipt arrives after Tab", async () => {
    const strip = await openViewer()
    const release = strip.holdSends()
    for (const letter of "same") await strip.viewerKey(letter)
    await strip.viewerKey("return")
    await strip.viewerKey("tab")
    for (const letter of "same beta") await strip.viewerKey(letter === " " ? "space" : letter)
    release()
    await strip.viewerKey("pagedown")
    await strip.viewerKey("return")
    expect(strip.sent).toEqual(["session.send asks same", "session.send broke same beta"])
  })

  it("marks a result read once its final message shows, and Shift+Tab still moves on after its row goes", async () => {
    // List order: the working chat, then the unread result.
    const strip = await mountStrip([
      leadRow("done", "result", { result: { entryId: "final" } }),
      leadRow("busy", "working"),
    ], { width: 100, height: 40, transcripts: { done: [textBlock("final", "The build passes now.")] } })
    cleanups.push(strip.dispose)
    await strip.key("down")
    await strip.key("down")
    expect(await strip.key("o", { ctrl: true })).toBe(true)
    expect(title(strip.rendered.captureCharFrame())).toBe("done")
    expect(strip.sent).toEqual(["lead.result.mark_read done final"])
    strip.setView((view) => ({ ...view, rows: view.rows.filter((row) => row.sessionId !== "done") }))
    await strip.viewerKey("tab", { shift: true })
    expect(title(strip.rendered.captureCharFrame())).toBe("busy")
  })

  it("shows the count on its border in the warning tone, also while the chat's question shows, and Left does not close it then", async () => {
    const strip = await openViewer()
    strip.setQuestions({ asks: choiceQuestion("asks-ask") })
    await strip.viewerKey("pagedown")
    const frame = strip.rendered.captureCharFrame()
    expect(frame).toContain("Which provider?")
    expect(frame).toContain("2 need you")
    const count = strip.rendered.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes("2 need you"))
    expect(count.length).toBeGreaterThan(0)
    expect(count.every((span) => span.fg.equals(resolveTheme(flywheelTheme, "dark").warning))).toBe(true)
    await strip.viewerKey("left")
    expect(strip.overlay.viewer.stack).toHaveLength(1)
    await strip.viewerKey("return")
    expect(strip.sent).toEqual(["question.answer asks asks-ask"])
  })

  it("sends typed text to the chat it shows", async () => {
    const strip = await openViewer()
    for (const letter of "ok") await strip.viewerKey(letter)
    await strip.viewerKey("return")
    expect(strip.sent).toEqual(["session.send asks ok"])
  })

  it("sends the person's text unchanged, with its surrounding spaces", async () => {
    const strip = await openViewer()
    for (const letter of " ok ") await strip.viewerKey(letter === " " ? "space" : letter)
    await strip.viewerKey("return")
    expect(strip.sent).toEqual(["session.send asks  ok "])
  })

  it("goes back to the lead with the list focused on the same row on Escape", async () => {
    const strip = await openViewer()
    await strip.viewerKey("tab")
    await strip.viewerKey("escape")
    expect(strip.overlay.viewer.stack).toHaveLength(0)
    expect(strip.focused()).toBe(true)
    // The reader opens on the row the viewer opened from.
    await strip.key("return")
    expect(strip.rendered.captureCharFrame()).toContain("Request  Request to asks")
  })

  it("opens the chat as a tab and closes, from the viewer and from the list", async () => {
    const strip = await openViewer()
    await strip.viewerKey("tab")
    await strip.viewerKey("t", { ctrl: true })
    expect(strip.overlay.viewer.stack).toHaveLength(0)
    expect(strip.sent).toEqual(["navigate broke"])
    expect(await strip.key("t", { ctrl: true })).toBe(true)
    expect(strip.sent).toEqual(["navigate broke", "navigate asks"])
  })
})
