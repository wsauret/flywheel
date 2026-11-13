/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { LeadCloseFocus } from "../../../../../src/tui/modules/lead/close-confirm.js"
const { testRender } = await import("@opentui/solid")
const { createSignal } = await import("solid-js")
const { createTextAttributes } = await import("@opentui/core")
const { ThemeProvider, useTheme } = await import("../../../../../src/tui/context/theme.js")
const { LeadCloseConfirm } = await import("../../../../../src/tui/modules/lead/close-confirm.js")

for (const width of [80, 140]) {
  test(`the lead's close confirmation shows its question and both buttons, with Cancel focused, at width ${width}`, async () => {
    const pressed: string[] = []
    const [focus, setFocus] = createSignal<LeadCloseFocus>("cancel")
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <LeadCloseConfirm focus={focus} onCancel={() => { pressed.push("cancel") }} onConfirm={() => { pressed.push("close") }} />
    }
    const rendered = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width, height: 20 })
    try {
      await rendered.renderOnce()
      if (!colors) throw new Error("Harness did not mount")
      const frame = rendered.captureCharFrame()
      expect(frame).toContain("Close the lead chat?")
      const text = frame.split("\n").map((line) => line.replace(/^[│ ]+|[│ ]+$/gu, "")).filter(Boolean).join(" ")
      expect(text).toContain("The chats that it started keep working. /lead opens the lead again.")
      expect(frame).toContain("> Cancel")
      expect(frame).toContain(" Close lead ")
      expect(frame).toContain("enter choose")
      const spans = () => rendered.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans().some((span) => span.text.includes("> Cancel") && span.bg.equals(colors!.primary) && span.fg.equals(colors!.background))).toBe(true)
      expect(spans().some((span) => span.text.includes("Close lead") && !span.text.includes(">") && span.fg.equals(colors!.primary) && span.bg.equals(colors!.backgroundElement))).toBe(true)
      expect(spans().some((span) => span.text.includes("Close the lead chat?") && span.fg.equals(colors!.text))).toBe(true)
      const blink = createTextAttributes({ blink: true })
      expect(spans().every((span) => (span.attributes & blink) === 0)).toBe(true)

      setFocus("close")
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("> Close lead")
      expect(spans().some((span) => span.text.includes("> Close lead") && span.bg.equals(colors!.primary))).toBe(true)

      const lines = rendered.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Cancel"))
      await rendered.mockMouse.pressDown(lines[y]!.indexOf("Cancel"), y)
      await rendered.mockMouse.release(lines[y]!.indexOf("Cancel"), y)
      expect(pressed).toEqual(["cancel"])
    } finally { rendered.renderer.destroy() }
  })
}
