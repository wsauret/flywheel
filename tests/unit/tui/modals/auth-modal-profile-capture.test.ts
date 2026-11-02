import { beforeEach, describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { RuntimeAuthLoginResult } from "../../../../src/protocol/auth-login-protocol-types.js"
import { clearMocks, createModal, flush, rowIndexOf, runtimeLogin } from "./auth-modal-test-harness.js"

describe("auth modal profile capture", () => {
  beforeEach(clearMocks)

  it("cycles the inline profile row and reloads auth after acceptance", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal()
      modal.openAuthModal()
      expect(modal.authRows()[modal.authModalCursor()]).toMatchObject({ kind: "profile", position: 1, total: 2, scopeLabel: "New Session Defaults" })
      modals.input({ name: "right" })
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.select", scope: { kind: "defaults" }, id: "work" })
      expect(modal.authModalCursor()).toBe(0)
      dispose()
    })
  })

  it("stops a browser login whose answer arrives after the modal closed", async () => {
    const answer = Promise.withResolvers<RuntimeAuthLoginResult>()
    runtimeLogin.mockImplementation(() => answer.promise)
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()
      modal.closeAuthModal()
      answer.resolve({ kind: "browser", operationId: "late-browser", providerId: "chatgpt", authorizeUri: "https://auth.test" })
      await flush()
      expect(modals.stack).toHaveLength(0)
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "late-browser" }])
      dispose()
    })
  })

  it("reports nothing for an API key save that answers after the modal closed", async () => {
    const answer = Promise.withResolvers<RuntimeAuthLoginResult>()
    runtimeLogin.mockImplementation(() => answer.promise)
    await createRoot(async (dispose) => {
      const { modal, modals, showToast } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      modals.input({ name: "a", sequence: "a" })
      modals.input({ name: "return" })
      await flush()
      modal.closeAuthModal()
      answer.resolve({ kind: "completed", providerId: "anthropic_api" })
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })
})
