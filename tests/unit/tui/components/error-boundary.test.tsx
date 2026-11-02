/** @jsxImportSource @opentui/solid */
import { describe, expect, it, mock } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { FrontendMutation, RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import type { BugReportResult } from "../../../../src/protocol/modules/bug-reports.js"
import { ErrorComponent } from "../../../../src/tui/components/error-boundary.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

const theme = resolveTheme(flywheelTheme, "dark")

async function crashScreen(crash = new TypeError("render failed")) {
  const sending = Promise.withResolvers<BugReportResult>()
  const dispatch = mock(async (_command: FrontendMutation) => await sending.promise)
  const client: Pick<RuntimeClient, "dispatch"> = { dispatch: runtimeDispatch({ "bugReport.submit": dispatch }) }
  const copy = mock(async (_text: string) => {})
  const [version, setVersion] = createSignal("1.2.3")
  const result = await testRender(() => <ThemeProvider mode="dark">
    <ErrorComponent error={crash} appService={client} appVersion={version()} sessionId="chat-1"
      clipboard={{ copy, readImage: async () => null }} onExit={() => {}} />
  </ThemeProvider>, { width: 130, height: 28 })
  return { ...result, sending, dispatch, copy, error: crash, setVersion }
}

describe("crash report screen", () => {
  it("keeps local Copy without a report notice when reporting is disabled", async () => {
    const screen = await crashScreen()
    try {
      screen.sending.resolve({ ok: false, kind: "disabled", error: "Bug reports are off" })
      await Bun.sleep(0)
      await screen.renderOnce()
      const frame = screen.captureCharFrame()
      expect(frame).toContain("Fatal Error")
      expect(frame).toContain("Copy Report")
      expect(frame).not.toContain("Could not send")
      expect(frame).not.toContain("Sending bug report")
    } finally { screen.renderer.destroy() }
  })

  it("says in muted text that a build that is not an official release sent no report, and keeps Copy", async () => {
    const screen = await crashScreen()
    try {
      screen.sending.resolve({ ok: false, kind: "not-release", error: "No bug report was sent because this build is not an official Flywheel release.", reportText: "account-assembled report" })
      await Bun.sleep(0)
      await screen.renderOnce()
      const frame = screen.captureCharFrame()
      expect(frame).toContain("No bug report was sent because this build is not an official Flywheel release.")
      expect(frame).not.toContain("Could not send")
      const statusSpan = screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("No bug report was sent"))
      expect(statusSpan?.fg.equals(theme.textMuted)).toBe(true)
      expect(frame).toContain("Copy Report")
    } finally { screen.renderer.destroy() }
  })

  it("sends once on mount, then shows the receipt without sending again on a reactive update", async () => {
    const screen = await crashScreen()
    try {
      await screen.renderOnce()
      expect(screen.captureCharFrame()).toContain("Sending bug report...")
      expect(screen.dispatch).toHaveBeenCalledTimes(1)
      expect(screen.dispatch).toHaveBeenCalledWith({
        type: "bugReport.submit", kind: "crash", surface: "tui", sessionId: "chat-1",
        error: { name: "TypeError", message: "render failed", stack: screen.error.stack },
      })
      screen.sending.resolve({ ok: true, reportId: "FW-1234" })
      screen.setVersion("1.2.4")
      await Bun.sleep(0)
      await screen.renderOnce()
      expect(screen.captureCharFrame()).toContain("Report sent automatically (FW-1234). To stop automatic reports, turn off Bug reports in Settings.")
      expect(screen.dispatch).toHaveBeenCalledTimes(1)
    } finally { screen.renderer.destroy() }
  })

  it.each(["refusal", "transport"] as const)("copies the assembled report or sanitized local error after a %s failure", async (kind) => {
    const error = new Error("render failed")
    error.stack = `Error: render failed\n${"x".repeat(12050)}`
    const screen = await crashScreen(error)
    try {
      if (kind === "refusal") screen.sending.resolve({ ok: false, kind: "unavailable", error: "offline", reportText: "account-assembled report" })
      else screen.sending.reject(new Error("offline"))
      await Bun.sleep(0)
      await screen.renderOnce()
      const frame = screen.captureCharFrame()
      expect(frame).toContain("Could not send bug report: offline")
      const statusSpan = screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Could not send"))
      expect(statusSpan?.fg.equals(theme.error)).toBe(true)
      expect(screen.dispatch).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ stack: error.stack.slice(0, 12000) }) }))
      const lines = frame.split("\n")
      const y = lines.findIndex((line) => line.includes("Copy Report"))
      expect(y).toBeGreaterThanOrEqual(0)
      await screen.mockMouse.click(lines[y]!.indexOf("Copy Report") + 1, y)
      await Bun.sleep(0)
      await screen.renderOnce()
      expect(screen.copy).toHaveBeenCalledTimes(1)
      const text = screen.copy.mock.calls[0]?.[0]
      if (kind === "refusal") expect(text).toBe("account-assembled report")
      else {
        const report = JSON.parse(text!)
        expect(report.error.stack).toBe(error.stack.slice(0, 12000))
        expect(report).toMatchObject({
          version: "1.2.3", platform: `${process.platform} ${process.arch}`,
          surface: "tui", sessionId: "chat-1", failure: "offline",
        })
      }
      expect(screen.captureCharFrame()).toContain("Copied!")
    } finally { screen.renderer.destroy() }
  })
})
