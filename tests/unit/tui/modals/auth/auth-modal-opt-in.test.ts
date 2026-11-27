import { beforeEach, describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { RuntimeAuthLoginResult } from "../../../../../src/protocol/auth/auth-login-protocol-types.js"
import { clearMocks, createModal, flush, rowIndexOf, runtimeLogin, setAuthStatuses } from "./auth-modal-test-harness.js"

describe("useAuthModal opt-in warning", () => {
  beforeEach(clearMocks)

  it("shows the warning of a provider that the profile keeps off on keep: return keeps it off and changes nothing, and a confirmed turn on logs in with turnOn (PI-MODEL-096)", async () => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", expired: true })
    const optIn = (request: { readonly turnOn?: true }): RuntimeAuthLoginResult | undefined => request.turnOn === true ? undefined : { kind: "needs_opt_in", providerId: "chatgpt", profileId: "default", displayName: "ChatGPT", warning: "WARNING" }
    for (const confirm of [false, true]) {
      await createRoot(async (dispose) => {
        runtimeLogin.mockImplementation(async (request) => optIn(request) ?? { kind: "browser", providerId: "chatgpt", operationId: "op", authorizeUri: "https://auth.openai.com/test" })
        const { modal, modals, sent, showToast } = createModal()
        modal.openAuthModal()
        modal.selectProvider(rowIndexOf(modal, "chatgpt"))
        modals.input({ name: "r" })
        await flush()
        expect(modal.authView()).toMatchObject({ kind: "login-confirmation", message: "WARNING", question: "turn-on", choice: "keep" })
        if (confirm) modals.input({ name: "left" })
        modals.input({ name: "return" })
        await flush()
        if (confirm) {
          expect(sent("auth.login").at(-1)).toMatchObject({ providerId: "chatgpt", profileId: "default", turnOn: true })
          expect(modal.authView()).toMatchObject({ kind: "browser-auth" })
        } else {
          expect(sent("auth.login")).toHaveLength(1)
          expect(showToast).toHaveBeenLastCalledWith({ message: "ChatGPT Subscription stays off. Nothing was changed.", variant: "info" })
        }
        dispose()
      })
    }
  })

  it("after turn on, a sign-in that reports no step yet shows the provider list, as a sign-in of a provider that is on does, and the end shows its outcome", async () => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", expired: true })
    const pending = Promise.withResolvers<RuntimeAuthLoginResult>()
    await createRoot(async (dispose) => {
      runtimeLogin.mockImplementation(async (request) => request.turnOn === true ? pending.promise : { kind: "needs_opt_in", providerId: "chatgpt", profileId: "default", displayName: "ChatGPT", warning: "WARNING" })
      const { modal, modals, showToast } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      modals.input({ name: "r" })
      await flush()
      modals.input({ name: "left" })
      modals.input({ name: "return" })
      await flush()
      expect(modal.authView()).toEqual({ kind: "list" })
      pending.resolve({ kind: "failed", providerId: "chatgpt", message: "Sign-in timed out" })
      await flush()
      expect(showToast).toHaveBeenLastCalledWith({ message: "ChatGPT Subscription login failed: Sign-in timed out", variant: "error", duration: 8000 })
      dispose()
    })
  })
})
