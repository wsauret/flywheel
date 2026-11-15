/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
import { textBlock } from "../../_output-window-transcript.js"
import { testRender } from "@opentui/solid"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import { UserMessageBlock } from "../../../../../src/tui/output-blocks/user-message-block.js"
import { leadReportLink } from "../../../../../src/protocol/modules/lead.js"
import { choiceQuestion, leadHarness, leadRow, mountStrip } from "./_lead-fixtures.js"

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
  expect(await strip.key("return")).toBe(true)
  return strip
}

/** What the viewer sent to the chats, without the seen marks that opening a failed chat sends. */
const chatSends = (strip: { readonly sent: readonly string[] }): readonly string[] => strip.sent.filter((line) => !line.startsWith("lead.chat.mark_seen"))

/** The chat the viewer's own title names, not a row of the list under it. */
const title = (frame: string): string | undefined => /│\s+Chat (\w+)\s+x\s+│/.exec(frame)?.[1]

describe("the lead's full-chat viewer", () => {
  it("opens on a click on a row, with the list focused on that row for Escape", async () => {
    const strip = await mountStrip([leadRow("busy", "working"), leadRow("asks", "question")], { width: 100, height: 40 })
    cleanups.push(strip.dispose)
    const row = strip.lines().findIndex((line) => line.includes("Chat busy"))
    await strip.rendered.mockMouse.click(10, row)
    await strip.viewerKey("pagedown")
    expect(title(strip.rendered.captureCharFrame())).toBe("busy")
    await strip.viewerKey("escape")
    expect(strip.focused()).toBe(true)
  })

  it("names a chat by the title that the Sessions list shows, in its row and in the view's header, never by its short title", async () => {
    // The fixture's catalog row holds a short title too.
    const strip = await mountStrip([leadRow("root", "result")], { width: 100, height: 40, titles: { root: "List Project Root Files" } })
    cleanups.push(strip.dispose)
    const row = strip.lines().findIndex((line) => line.includes("List Project Root Files"))
    expect(row).toBeGreaterThanOrEqual(0)
    await strip.rendered.mockMouse.click(10, row)
    await strip.viewerKey("pagedown")
    const frame = strip.rendered.captureCharFrame()
    expect(frame).toMatch(/│\s+List Project Root Files\s+x\s+│/)
    expect(frame).not.toContain("Short")
  })

  it("marks a failed or cut chat seen once when it opens, so its row leaves the list", async () => {
    const strip = await mountStrip([leadRow("broke", "failed"), leadRow("stopped", "cut")], { width: 100, height: 40 })
    cleanups.push(strip.dispose)
    await strip.key("down")
    await strip.key("return")
    await strip.viewerKey("tab")
    expect(strip.sent).toEqual(["lead.chat.mark_seen broke failed broke-end", "lead.chat.mark_seen stopped cut stopped-end"])
  })

  it("marks a failed chat seen when ctrl+t opens it as a tab from the list", async () => {
    const strip = await mountStrip([leadRow("broke", "failed")], { width: 100, height: 40 })
    cleanups.push(strip.dispose)
    await strip.key("down")
    expect(await strip.key("t", { ctrl: true })).toBe(true)
    expect(strip.sent).toEqual(["lead.chat.mark_seen broke failed broke-end", "navigate broke"])
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
    expect(chatSends(strip)).toEqual([])
    await strip.viewerKey("tab", { shift: true })
    await strip.viewerKey("return")
    expect(chatSends(strip)).toEqual(["session.send asks yes"])
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
    expect(chatSends(strip)).toEqual(["session.send asks same", "session.send broke same beta"])
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
    expect(await strip.key("return")).toBe(true)
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
    // Enter opens the row the viewer opened from.
    await strip.key("return")
    expect(title(strip.rendered.captureCharFrame())).toBe("asks")
  })

  it("holds each chat it shows as a tab does, and its close ends the view as a closed tab, but not when the chat opens as a tab", async () => {
    const strip = await openViewer()
    await strip.viewerKey("tab")
    await strip.viewerKey("escape")
    expect(strip.shows).toEqual(["show asks", "end asks", "show broke", "end broke"])
    strip.shows.length = 0
    await strip.key("return")
    await strip.viewerKey("t", { ctrl: true })
    expect(strip.shows).toEqual(["show asks", "to tab asks"])
  })

  it("opens the chat as a tab and closes, from the viewer and from the list", async () => {
    const strip = await openViewer()
    await strip.viewerKey("tab")
    await strip.viewerKey("t", { ctrl: true })
    expect(strip.overlay.viewer.stack).toHaveLength(0)
    expect(chatSends(strip)).toEqual(["navigate broke"])
    expect(await strip.key("t", { ctrl: true })).toBe(true)
    expect(chatSends(strip)).toEqual(["navigate broke", "navigate asks"])
  })

  it("shows a report in the lead's transcript as one line, and its link opens the chat at the final message, marked", async () => {
    // The line names each chat by its title now, as the Sessions list does.
    const lead = leadHarness([], {}, undefined, { done: "DAG Failures", long: "Investigate why the nightly DAG failures started after the warehouse migration" })
    cleanups.push(lead.dispose)
    const row = await testRender(() => <ThemeProvider mode="dark">{lead.client.provide?.(() => <UserMessageBlock block={{
      kind: "userMessage", id: "msg:done:lead-report:final", content: "The build passes now.\nAll 40 tests ran.", timestamp: 1, pending: false, injected: false,
      from: { sessionId: "done", name: "New Chat", relation: "other" },
    }} />)}</ThemeProvider>, { width: 80, height: 4 })
    cleanups.push(() => { row.renderer.destroy() })
    await row.renderOnce()
    const frame = row.captureCharFrame()
    expect(frame).toContain("Report · DAG Failures · open")
    expect(frame).not.toContain("The build passes now.")

    // A long title is cut, so the line stays one row with its open action.
    const long = await testRender(() => <ThemeProvider mode="dark">{lead.client.provide?.(() => <UserMessageBlock block={{
      kind: "userMessage", id: "msg:long:lead-report:final", content: "Done.", timestamp: 1, pending: false, injected: false,
      from: { sessionId: "long", name: "New Chat", relation: "other" },
    }} />)}</ThemeProvider>, { width: 80, height: 4 })
    cleanups.push(() => { long.renderer.destroy() })
    await long.renderOnce()
    const lines = long.captureCharFrame().split("\n").filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("Report · Investigate why the nightly DAG failure… · open")

    const strip = await mountStrip([], { width: 100, height: 40, transcripts: { done: [textBlock("other", "Earlier work."), textBlock("final", "The build passes now.")] } })
    cleanups.push(strip.dispose)
    expect(await strip.client.openUri(leadReportLink("done", "final"))).toBe(true)
    await strip.viewerKey("pagedown")
    expect(title(strip.rendered.captureCharFrame())).toBe("done")
    const marked = strip.rendered.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes("The build passes now."))
    expect(marked.length).toBeGreaterThan(0)
    expect(marked.every((span) => span.bg.equals(resolveTheme(flywheelTheme, "dark").backgroundElement))).toBe(true)
    const other = strip.rendered.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes("Earlier work."))
    expect(other.some((span) => span.bg.equals(resolveTheme(flywheelTheme, "dark").backgroundElement))).toBe(false)
  })
})
