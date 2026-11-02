/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"

const [{ testRender }, { createComponent }, { ThemeProvider }, { AuthModal }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("../../../../src/tui/context/theme.js"),
  import("../../../../src/tui/modals/auth-modal.js"),
])

const noOp = (): void => {}
const EMPTY_PRESENTATION = { value: "", cursor: 0, selection: null, preferredVisualColumn: null } as const

// The views that a login in progress shows: the device code, and the browser page with its pasted code.
describe("AuthModal device-code view", () => {
  const url = "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234"
  const renderDeviceCode = async (userCode?: string) => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "device-code", providerId: "xai", label: "Grok", url, ...(userCode === undefined ? {} : { userCode }) },
          rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 60, height: 14 })
    await result.renderOnce()
    return result
  }

  it("shows the complete provider link and waiting status without code controls when no code is supplied", async () => {
    const result = await renderDeviceCode()
    try {
      const frame = result.captureCharFrame()
      // Modal borders and wrapping may split the link across rows; the characters must all remain.
      expect(frame.replace(/[│\s]/g, "")).toContain(url)
      expect(frame).toContain("Waiting for authorization...")
      expect(frame).not.toContain("Enter code")
      expect(frame).not.toContain("c copy")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the code and copy control when a code is supplied", async () => {
    const result = await renderDeviceCode("ABCD-1234")
    try {
      const frame = result.captureCharFrame()
      expect(frame.replace(/[│\s]/g, "")).toContain(url)
      expect(frame).toContain("Enter code: ABCD-1234")
      expect(frame).toContain("Waiting for authorization...")
      expect(frame).toContain("c copy code")
    } finally {
      result.renderer.destroy()
    }
  })
})

describe("AuthModal browser login view", () => {
  it("shows the whole sign-in page link and a field for the code that the page shows", async () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=client-id&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=state-value"
    const render = async (submitted: boolean) => {
      const result = await testRender(() => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "browser-auth", providerId: "claude_agent_sdk", label: "Anthropic Subscription", url, ...(submitted ? { submitted: true as const } : {}) }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
        },
      }), { width: 60, height: 24 })
      await result.renderOnce()
      return result
    }
    const waiting = await render(false)
    const checking = await render(true)
    try {
      const frame = waiting.captureCharFrame()
      expect(frame.replace(/[│\s]/g, "")).toContain(url)
      expect(frame.replace(/[│\s]+/g, " ")).toContain("If the page shows a code, paste it here.")
      expect(frame).toContain("Code or address")
      expect(frame).toContain("enter finish login")
      const after = checking.captureCharFrame()
      expect(after).toContain("Finishing login…")
      expect(after).not.toContain("Code or address")
    } finally {
      waiting.renderer.destroy()
      checking.renderer.destroy()
    }
  })
})
