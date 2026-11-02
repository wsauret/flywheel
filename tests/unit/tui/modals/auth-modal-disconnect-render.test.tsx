/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"

const [{ testRender }, { createComponent }, { ThemeProvider }, { AuthModal }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("../../../../src/tui/context/theme.js"),
  import("../../../../src/tui/modals/auth-modal.js"),
])

const noOp = (): void => {}
const EMPTY_PRESENTATION = { value: "", cursor: 0, selection: null, preferredVisualColumn: null } as const

describe("AuthModal disconnect confirmation", () => {
  const externalLogin = {
    id: "claude_agent_sdk" as const, label: "Anthropic Subscription", kind: "subscription" as const, source: "oauth" as const, expired: false, loginProgram: "Example CLI",
    loginMethod: "browser-auth" as const, modelSelectionAvailable: true, capabilityAccounts: [], group: "model" as const,
    accounts: [{ instanceId: "uuid-one", accountCorrelationId: "opaque-one", identity: "one@example.com", displayLabel: "one@example.com", plan: "Max", expired: false, source: "oauth" as const }],
  }
  const storedKey = {
    id: "anthropic_api" as const, label: "Anthropic API Key", kind: "singleton" as const, source: "stored_key" as const, expired: false,
    loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [], capabilityAccounts: [], group: "model" as const,
  }
  it.each([
    ["dark", "an account that an external program owns", { option: externalLogin, account: externalLogin.accounts[0]! }, "Disconnect one@example.com · Max?", "This logs one@example.com out of this Flywheel profile. Example CLI and other apps keep their own logins. Log in again to reconnect."],
    ["light", "a stored credential", { option: storedKey }, "Disconnect Anthropic API Key?", "Its stored credential is removed from this profile. Sign in again to reconnect."],
  ] as const)("asks in %s before it disconnects %s, with the words the web client uses", async (mode, _kind, disconnect, question, consequence) => {
    const result = await testRender(() => createComponent(ThemeProvider, { mode, get children() {
      return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, disconnect, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp, onConfirmDisconnect: noOp, onCancelDisconnect: noOp })
    } }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      const prose = frame.split("\n").map((line) => line.replace(/[│╭╮╰╯─]/g, "").trim()).filter((line) => line !== "").join(" ")
      expect(frame).toContain("Authentication › Disconnect")
      expect(prose).toContain(question)
      expect(prose).toContain(consequence)
      expect(frame).toContain("Disconnect y")
      expect(frame).toContain("Cancel esc")
      const theme = resolveTheme(flywheelTheme, mode)
      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.find((span) => span.text.includes(question.slice(0, 12)))?.fg.equals(theme.warning)).toBe(true)
      expect(spans.find((span) => span.text.trim() === "Disconnect")?.fg.equals(theme.primary)).toBe(true)
      expect(spans.find((span) => span.text.trim() === "Cancel")?.fg.equals(theme.textMuted)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })
})
