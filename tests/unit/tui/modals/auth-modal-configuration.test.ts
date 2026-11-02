import { beforeEach, describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { clearMocks, createModal, setAuthStatuses } from "./auth-modal-test-harness.js"

describe("auth modal provider configuration", () => {
  beforeEach(clearMocks)

  it("opens the auth modal and closes it on Escape", () => {
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()
      expect(modals.stack.length).toBe(1)
      modals.input({ name: "escape" })
      expect(modals.stack.length).toBe(0)
      dispose()
    })
  })

  it("focuses provider attention without starting reconnect", () => {
    setAuthStatuses({ providerId: "anthropic_api", source: "invalid", attention: { kind: "malformed", message: "Stored authentication data is malformed." } })
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openAuthModal()
      expect(modal.focusProvider("anthropic_api")).toBe(true)
      expect(modal.authView()).toEqual({ kind: "list" })
      expect(modal.authRows()[modal.authModalCursor()]).toMatchObject({ kind: "provider", option: { id: "anthropic_api" } })
      dispose()
    })
  })

  it("focuses the first selectable account for a multi-account provider", () => {
    const accounts = [
      { instanceId: "one", accountCorrelationId: "one", identity: "one@example.com", displayLabel: "one@example.com", expired: false, source: "oauth" as const },
      { instanceId: "two", accountCorrelationId: "two", identity: "two@example.com", displayLabel: "two@example.com", expired: false, source: "oauth" as const },
    ]
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", accounts })
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()

      expect(modal.focusProvider("chatgpt")).toBe(true)
      expect(modal.authRows()[modal.authModalCursor()]).toMatchObject({ kind: "account", account: { instanceId: "one" } })
      modals.input({ name: "enter" })
      expect(modal.authView()).toMatchObject({ kind: "provider-settings", target: { kind: "account", account: { instanceId: "one" } } })
      dispose()
    })
  })

  it("opens provider attention settings with the canonical auth path", () => {
    setAuthStatuses({ providerId: "anthropic_api", source: "invalid", attention: { kind: "malformed", message: "Stored authentication data is malformed." } })
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()
      modal.focusProvider("anthropic_api")

      modals.input({ name: "enter" })

      expect(modal.authView()).toMatchObject({ kind: "provider-settings", attentionPath: "/scratch/auth/auth.json" })
      dispose()
    })
  })
})
