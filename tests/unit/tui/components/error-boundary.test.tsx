/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { FrontendMutation, RuntimeClient } from "../../../../src/protocol/runtime/app-service-types.js"
import { AUTOMATIC_REPORTS_OFF_STATUS, AUTOMATIC_REPORTS_QUESTION, DO_NOT_TRACK_REPORT_STATUS, type BugReportConsentResult, type BugReportResult } from "../../../../src/protocol/modules/bug-reports.js"
import { ErrorComponent } from "../../../../src/tui/components/error-boundary.js"
import { createTuiErrorReports } from "../../../../src/tui/modules.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

const theme = resolveTheme(flywheelTheme, "dark")
const doNotTrack = process.env.DO_NOT_TRACK
beforeEach(() => { delete process.env.DO_NOT_TRACK })
afterEach(() => {
  if (doNotTrack === undefined) delete process.env.DO_NOT_TRACK
  else process.env.DO_NOT_TRACK = doNotTrack
})

async function crashScreen(crash = new TypeError("render failed")) {
  const sending = Promise.withResolvers<BugReportResult>()
  const dispatch = mock(async (_command: FrontendMutation) => await sending.promise)
  const consent = mock(async (command: FrontendMutation): Promise<BugReportConsentResult> => ({ ok: true, automatic: "allow" in command && command.allow === true }))
  const client: Pick<RuntimeClient, "dispatch"> = { dispatch: runtimeDispatch({ "bugReport.submit": dispatch, "bugReport.consent": consent }) }
  const copy = mock(async (_text: string) => {})
  const [version, setVersion] = createSignal("1.2.3")
  const result = await testRender(() => <ThemeProvider mode="dark">
    <ErrorComponent error={crash} appService={client} appVersion={version()} sessionId="chat-1"
      clipboard={{ copy, readImage: async () => null }} onExit={() => {}} createReports={createTuiErrorReports} />
  </ThemeProvider>, { width: 130, height: 28 })
  return { ...result, sending, dispatch, consent, copy, error: crash, setVersion }
}

async function press(screen: Awaited<ReturnType<typeof crashScreen>>, label: string) {
  const lines = screen.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(label))
  expect(y).toBeGreaterThanOrEqual(0)
  await screen.mockMouse.click(lines[y]!.indexOf(label) + 1, y)
  for (let turn = 0; turn < 4; turn++) await Bun.sleep(0)
  await screen.renderOnce()
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
      expect(screen.captureCharFrame()).toContain("Report sent automatically (FW-1234). To stop automatic reports, turn off Automatic crash reports in Settings.")
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

  it("asks once before the first automatic report, and a yes saves the answer and sends this report", async () => {
    const screen = await crashScreen()
    try {
      screen.sending.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" })
      await Bun.sleep(0)
      await screen.renderOnce()
      const asked = screen.captureCharFrame()
      expect(asked).toContain(AUTOMATIC_REPORTS_QUESTION.slice(0, 40))
      expect(asked).toContain("Don't send")
      expect(asked).not.toContain(AUTOMATIC_REPORTS_OFF_STATUS.slice(0, 40))
      screen.dispatch.mockImplementation(async () => ({ ok: true, reportId: "FW-5678" }))
      await press(screen, "Send reports")
      expect(screen.consent).toHaveBeenCalledWith({ type: "bugReport.consent", allow: true })
      expect(screen.dispatch).toHaveBeenCalledTimes(2)
      const sent = screen.captureCharFrame()
      expect(sent).toContain("Report sent automatically (FW-5678).")
      expect(sent).not.toContain("Send reports")
    } finally { screen.renderer.destroy() }
  })

  it("a no saves the answer, sends nothing, says why in muted text, and keeps Copy", async () => {
    const screen = await crashScreen()
    try {
      screen.sending.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" })
      await Bun.sleep(0)
      await screen.renderOnce()
      await press(screen, "Don't send")
      expect(screen.consent).toHaveBeenCalledWith({ type: "bugReport.consent", allow: false })
      expect(screen.dispatch).toHaveBeenCalledTimes(1)
      const frame = screen.captureCharFrame()
      expect(frame).not.toContain("Send reports")
      const statusSpan = screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("No bug report was sent because automatic"))
      expect(statusSpan?.fg.equals(theme.textMuted)).toBe(true)
      await press(screen, "Copy Report")
      expect(screen.copy).toHaveBeenCalledWith("account-assembled report")
    } finally { screen.renderer.destroy() }
  })

  it("keeps the question open after an answer that could not be saved, and says so in error text", async () => {
    const screen = await crashScreen()
    try {
      screen.sending.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" })
      await Bun.sleep(0)
      await screen.renderOnce()
      screen.consent.mockImplementationOnce(async () => ({ ok: false, error: "the file is locked" }))
      await press(screen, "Send reports")
      const frame = screen.captureCharFrame()
      expect(frame).toContain(AUTOMATIC_REPORTS_QUESTION.slice(0, 40))
      expect(frame).not.toContain("Could not send bug report")
      const statusSpan = screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Could not save your answer: the file is locked"))
      expect(statusSpan?.fg.equals(theme.error)).toBe(true)
      expect(screen.dispatch).toHaveBeenCalledTimes(1)
    } finally { screen.renderer.destroy() }
  })

  it("follows the answer another surface saved first", async () => {
    const screen = await crashScreen()
    try {
      screen.sending.resolve({ ok: false, kind: "consent-needed", error: AUTOMATIC_REPORTS_OFF_STATUS, reportText: "account-assembled report" })
      await Bun.sleep(0)
      await screen.renderOnce()
      screen.consent.mockImplementationOnce(async () => ({ ok: true, automatic: false }))
      await press(screen, "Send reports")
      expect(screen.dispatch).toHaveBeenCalledTimes(1)
      expect(screen.captureCharFrame()).toContain("No bug report was sent because automatic crash reports are off.")
    } finally { screen.renderer.destroy() }
  })

  it.each(["1", "true"])("with DO_NOT_TRACK=%s sends nothing, asks nothing, and still copies the report", async (value) => {
    process.env.DO_NOT_TRACK = value
    const screen = await crashScreen()
    try {
      await screen.renderOnce()
      expect(screen.dispatch).not.toHaveBeenCalled()
      const frame = screen.captureCharFrame()
      expect(frame).toContain(DO_NOT_TRACK_REPORT_STATUS)
      expect(frame).not.toContain("Send reports")
      await press(screen, "Copy Report")
      expect(JSON.parse(screen.copy.mock.calls[0]![0]).error).toMatchObject({ name: "TypeError", message: "render failed" })
    } finally { screen.renderer.destroy() }
  })
})
