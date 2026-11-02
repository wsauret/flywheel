import { beforeEach, describe, expect, it } from "bun:test"
import { Redacted } from "effect"
import { createRoot } from "solid-js"
import { isConfigured, statusText } from "../../../../src/tui/hooks/auth-modal-options.js"
import { signInPage } from "../../../../src/tui/terminal-attach.js"
import type { RuntimeAuthLoginResult } from "../../../../src/protocol/auth-login-protocol-types.js"
import {
  clearMocks,
  COPILOT_PROMPT,
  createModal,
  flush,
  providerOptions,
  rowIndexOf,
  runtimeAnswer,
  runtimeLogin,
  setAuthStatuses,
} from "./auth-modal-test-harness.js"
import { FREE_PLAN_REPLACE_QUESTION } from "../../../../src/infra/llm/free-plan-accounts.js"
import { keptFreePlanMessage } from "../../../../src/protocol/client/auth-login.js"

/** Opens the modal on the unconfigured Copilot row and waits for the flow's
 *  own question, which the runtime asks first. */
async function openCopilotPrompt(modal: ReturnType<typeof createModal>["modal"]): Promise<void> {
  modal.openAuthModal()
  modal.selectProvider(rowIndexOf(modal, "github_copilot"))
  for (let i = 0; i < 5 && modal.authView().kind !== "login-prompt"; i++) await Bun.sleep(0)
}

describe("useAuthModal", () => {
  beforeEach(clearMocks)


  it("cursor navigation skips heading rows in both directions", () => {
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()

      // Up from the profile row wraps to the last provider, skipping headings.
      modals.input({ name: "up" })
      let row = modal.authRows()[modal.authModalCursor()]
      expect(row?.kind === "provider" && row.option.id).toBe("exa")

      // Down from the last provider wraps to the profile row, then the first provider.
      modals.input({ name: "down" })
      modals.input({ name: "down" })
      row = modal.authRows()[modal.authModalCursor()]
      expect(row?.kind === "provider" && row.option.id).toBe("anthropic_api")
      dispose()
    })
  })

  it("shows all providers under section headings", () => {
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openAuthModal()

      expect(providerOptions(modal).map(p => p.id)).toEqual([
        "anthropic_api", "openai_api", "opencode_go", "openrouter", "google_api", "google_vertex", "chatgpt", "github_copilot", "supergrok", "exa",
      ])
      const headings = modal.authRows().flatMap((row) => (row.kind === "heading" ? [row.label] : []))
      expect(headings).toEqual(["Model Providers", "Web Search"])
      const cursorRow = modal.authRows()[modal.authModalCursor()]
      expect(cursorRow?.kind).toBe("profile")
      dispose()
    })
  })


  it("a stored credential that needs attention renders as warning and unconfigured", () => {
    setAuthStatuses({ providerId: "anthropic_api", source: "invalid" })
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openAuthModal()
      const anthropic = providerOptions(modal)[0]!
      expect(statusText(anthropic)).toBe("needs attention")
      expect(isConfigured(anthropic)).toBe(false)
      dispose()
    })
  })


  it("opens provider settings for every configured provider kind", () => {
    setAuthStatuses({ providerId: "anthropic_api", source: "stored_key" }, { providerId: "openrouter", source: "stored_key" }, { providerId: "exa", source: "stored_key" })
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()
      for (const providerId of ["anthropic_api", "openrouter", "exa"]) {
        modal.selectProvider(rowIndexOf(modal, providerId)); expect(modal.authView()).toMatchObject({ kind: "provider-settings", option: { id: providerId } }); modals.input({ name: "left" })
      }
      dispose()
    })
  })

  it("expired OAuth provider shows expired status", () => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", expired: true })
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openAuthModal()
      const chatgpt = providerOptions(modal)[6]!
      expect(statusText(chatgpt)).toBe("expired")
      expect(isConfigured(chatgpt)).toBe(true)
      dispose()
    })
  })

  it("a terminal attached through the relay asks no runtime to open the sign-in page and opens it here", async () => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", expired: true })
    await createRoot(async (dispose) => {
      const opened: string[] = []
      const { modal, modals, sent } = createModal("default", undefined, { signInPage: signInPage({ kind: "relay" }), openBrowser: async (url) => { opened.push(url); return true } })
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      modals.input({ name: "r" })
      await flush()
      expect(sent("auth.login")).toEqual([{ type: "auth.login", providerId: "chatgpt", profileId: "default" }])
      expect(modal.authView()).toMatchObject({ kind: "browser-auth", url: "https://auth.openai.com/test" })
      expect(opened).toEqual(["https://auth.openai.com/test"])
      dispose()
    })
  })

  it("opens settings for expired ChatGPT and reconnects with r", async () => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", expired: true })
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      expect(modal.authView().kind).toBe("provider-settings")
      modals.input({ name: "r" })
      await flush()
      expect(sent("auth.login")).toEqual([{ type: "auth.login", providerId: "chatgpt", profileId: "default", openBrowser: true }])
      expect(sent("auth.account.disconnect")).toEqual([])
      expect(modal.authView()).toMatchObject({ kind: "browser-auth", url: "https://auth.openai.com/test" })
      dispose()
    })
  })

  it("a browser login takes the code that the provider's page shows, pasted into the login view", async () => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", expired: true })
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal()
      modal.openAuthModal(); modal.selectProvider(rowIndexOf(modal, "chatgpt")); modals.input({ name: "r" })
      for (let i = 0; i < 10 && modal.authView().kind !== "browser-auth"; i++) await Bun.sleep(1)
      modals.paste("  code-from-the-page#state  "); modals.input({ name: "return" })
      await flush()
      const completion = sent("auth.login.complete")
      expect(completion.map(({ operationId }) => operationId)).toEqual(["chatgpt-operation"])
      expect(completion.map(({ input }) => Redacted.value(input))).toEqual(["code-from-the-page#state"])
      dispose()
    })
  })

  it("answers Copilot's question through the runtime and stays pending until the runtime settles the login", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, sent, settle, showToast, clipboard } = createModal()
      await openCopilotPrompt(modal)
      expect(modal.authView()).toMatchObject({ kind: "login-prompt", providerId: "github_copilot", prompt: COPILOT_PROMPT })

      modals.input({ name: "return" })
      await flush()
      expect(sent("auth.login.answer")).toEqual([{ type: "auth.login.answer", providerId: "github_copilot", operationId: "copilot-operation", answer: "" }])
      expect(modal.authView()).toMatchObject({ kind: "device-code", userCode: "COPI-LOT1", url: "https://github.com/login/device" })
      expect(clipboard.copy).toHaveBeenCalledWith("COPI-LOT1")
      expect(sent("auth.refresh")).toEqual([])

      settle({ kind: "completed", operationId: "copilot-operation", providerId: "github_copilot" })
      await flush()
      expect(modal.authView().kind).toBe("list")
      expect(showToast).toHaveBeenCalledWith({ message: "Copilot Subscription auth active", variant: "success" })
      dispose()
    })
  })

  it("shows each progress message of the runtime's Copilot login once, then its end", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, settle, progress } = createModal()
      await openCopilotPrompt(modal)
      modals.input({ name: "return" })
      await flush()
      showToast.mockClear()

      progress({ kind: "progress", operationId: "copilot-operation", providerId: "github_copilot", message: "Exchanging for Copilot token..." })
      await flush()
      progress({ kind: "progress", operationId: "copilot-operation", providerId: "github_copilot", message: "Exchanging for Copilot token..." })
      await flush()
      expect(showToast.mock.calls).toEqual([[{ message: "Exchanging for Copilot token...", variant: "info" }]])
      expect(modal.authView().kind).toBe("device-code")

      settle({ kind: "completed", operationId: "copilot-operation", providerId: "github_copilot" })
      await flush()
      expect(showToast).toHaveBeenLastCalledWith({ message: "Copilot Subscription auth active", variant: "success" })
      dispose()
    })
  })

  it("reports a Copilot login that the runtime settles as failed", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, settle } = createModal()
      await openCopilotPrompt(modal)
      modals.input({ name: "return" })
      await flush()
      settle({ kind: "failed", operationId: "copilot-operation", providerId: "github_copilot", message: "refresh failed" })
      await flush()

      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Copilot Subscription login failed: refresh failed", variant: "error" }))
      expect(showToast.mock.calls.some(([toast]) => toast.message === "Copilot Subscription auth active")).toBe(false)
      dispose()
    })
  })

  it("asks the runtime's replace question after sign-in: return replaces, escape keeps the free account and stores nothing (PI-MODEL-038)", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, sent, ask } = createModal()
      await openCopilotPrompt(modal)
      modals.input({ name: "return" })
      await flush()
      const answered = Promise.withResolvers<{ kind: "completed"; providerId: string }>()
      runtimeAnswer.mockImplementationOnce(() => answered.promise)
      ask({ kind: "confirmation", operationId: "copilot-operation", providerId: "github_copilot", message: FREE_PLAN_REPLACE_QUESTION })
      await flush()
      expect(modal.authView()).toMatchObject({ kind: "login-confirmation", message: FREE_PLAN_REPLACE_QUESTION, choice: "replace" })

      modals.input({ name: "return" })
      await flush()
      expect(sent("auth.login.answer").at(-1)).toEqual({ type: "auth.login.answer", providerId: "github_copilot", operationId: "copilot-operation", answer: "confirm" })
      // The replacement runs in the runtime; the question shows that it does and takes no second answer.
      expect(modal.authView()).toMatchObject({ kind: "login-confirmation", submitting: true })
      modals.input({ name: "return" })
      answered.resolve({ kind: "completed", providerId: "github_copilot" })
      await flush()
      expect(sent("auth.login.answer").filter(({ answer }) => answer === "confirm")).toHaveLength(1)
      expect(modal.authView().kind).toBe("list")
      expect(showToast).toHaveBeenLastCalledWith({ message: "Copilot Subscription auth active", variant: "success" })
      dispose()
    })
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, sent, ask } = createModal()
      await openCopilotPrompt(modal)
      modals.input({ name: "return" })
      await flush()
      ask({ kind: "confirmation", operationId: "copilot-operation", providerId: "github_copilot", message: FREE_PLAN_REPLACE_QUESTION })
      await flush()

      modals.input({ name: "escape" })
      await flush()
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "copilot-operation" }])
      expect(sent("auth.login.answer").filter(({ answer }) => answer === "confirm")).toEqual([])
      expect(showToast).toHaveBeenLastCalledWith({ message: keptFreePlanMessage("Copilot Subscription"), variant: "info" })
      dispose()
    })
  })

  it("stops the runtime's Copilot flow when the modal closes, and ignores its later settlement", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, sent, settle } = createModal()
      await openCopilotPrompt(modal)
      modals.input({ name: "return" })
      await flush()
      modal.closeAuthModal()
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "copilot-operation" }])
      showToast.mockClear()

      settle({ kind: "completed", operationId: "copilot-operation", providerId: "github_copilot" })
      await flush()
      expect(modals.stack).toHaveLength(0)
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("unconfigured provider shows explicit status text", () => {
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openAuthModal()
      const anthropic = providerOptions(modal)[0]!
      expect(statusText(anthropic)).toBe("unconfigured")
      expect(isConfigured(anthropic)).toBe(false)
      dispose()
    })
  })

  it("selecting unconfigured API key provider switches to api-key-input view", () => {
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openAuthModal()

      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      expect(modal.authView().kind).toBe("api-key-input")
      dispose()
    })
  })



  it("API key input validates non-empty and sends the key to the runtime, redacted", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, sent, showToast } = createModal()
      modal.openAuthModal()

      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      expect(modal.authView().kind).toBe("api-key-input")
      modals.input({ name: "return" })
      expect(sent("auth.login")).toEqual([])

      for (const char of "sk-ant-test123") modals.input({ name: char })
      modals.input({ name: "return" })
      await flush()

      const [login] = sent("auth.login")
      expect(login).toMatchObject({ type: "auth.login", providerId: "anthropic_api", profileId: "default" })
      expect(login?.apiKey === undefined ? undefined : Redacted.value(login.apiKey)).toBe("sk-ant-test123")
      expect(sent("auth.refresh")).toEqual([])
      expect(showToast).toHaveBeenCalledWith({ message: "Anthropic API Key API key saved", variant: "success" })
      expect(modal.authView().kind).toBe("list")
      dispose()
    })
  })

  it("keeps the key entry open and names the reason when the runtime refuses the key", async () => {
    runtimeLogin.mockImplementation(async (request) => ({ kind: "failed", providerId: request.providerId, message: "invalid key" }))
    await createRoot(async (dispose) => {
      const { modal, modals, showToast } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      modals.input({ name: "x", sequence: "x" })
      modals.input({ name: "return" })
      await flush()
      expect(showToast).toHaveBeenCalledWith({ message: "API key save failed: invalid key", variant: "error" })
      expect(modal.authView().kind).toBe("api-key-input")
      dispose()
    })
  })

  it("pastes into the api-key draft, stripping control characters", () => {
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()

      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      expect(modal.authView().kind).toBe("api-key-input")

      const handled = modals.paste("sk-ant-\npasted\tkey")
      expect(handled).toBe(true)
      expect(modal.apiKeyDraft()).toBe("sk-ant-pastedkey")
      dispose()
    })
  })

  it("escape from api-key-input returns to list", () => {
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()

      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      expect(modal.authView().kind).toBe("api-key-input")

      modals.input({ name: "escape" })
      expect(modal.authView().kind).toBe("list")
      dispose()
    })
  })

  it("clears the API key owner when the modal closes from credential input", () => {
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      modals.input({ name: "a", sequence: "a" })
      expect(modal.apiKeyDraft().length).toBe(1)

      modal.closeAuthModal()
      expect(modal.apiKeyDraft().length).toBe(0)
      dispose()
    })
  })

  it("selects an account rename draft after a different prior auth draft", async () => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", accounts: [
      { instanceId: "account-1", accountCorrelationId: "opaque-1", identity: "one@example.com", displayLabel: "one@example.com", label: "Personal", expired: false, source: "oauth" },
      { instanceId: "account-2", accountCorrelationId: "opaque-2", identity: "two@example.com", displayLabel: "two@example.com", expired: false, source: "oauth" },
    ] })
    await createRoot(async (dispose) => {
      const { modal, modals } = createModal()
      await openCopilotPrompt(modal)
      modals.input({ name: "x", raw: "x" })
      modals.input({ name: "escape" })
      while (modal.authRows()[modal.authModalCursor()]?.kind !== "account") modals.input({ name: "down" })
      modals.input({ name: "r" })
      expect(modal.authInputPresentation()).toMatchObject({ value: "Personal", cursor: 8, selection: { start: 0, end: 8 } })
      modals.input({ name: "N", raw: "N" })
      expect(modal.authInputPresentation()).toMatchObject({ value: "N", cursor: 1, selection: null })
      dispose()
    })
  })

  it("selects a profile rename draft after a different prior auth draft", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals } = createModal()
      await openCopilotPrompt(modal)
      modals.input({ name: "x", raw: "x" })
      modals.input({ name: "escape" })
      // Cancelling the prompt returns to the Copilot row; the profile row is the first.
      for (let step = 0; step < 20 && modal.authRows()[modal.authModalCursor()]?.kind !== "profile"; step++) modals.input({ name: "up" })
      modals.input({ name: "r" })
      expect(modal.authInputPresentation()).toMatchObject({ value: "Default", cursor: 7, selection: { start: 0, end: 7 } })
      modals.input({ name: "N", raw: "N" })
      expect(modal.authInputPresentation()).toMatchObject({ value: "N", cursor: 1, selection: null })
      dispose()
    })
  })

  it("reports a rename failure after the frame has closed", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, runtime, showToast } = createModal()
      modal.openAuthModal()
      modals.input({ name: "r" })
      modals.paste("New name")
      runtime["auth.profile.rename"].mockRejectedValueOnce(new Error("disk unavailable"))
      modal.closeAuthModal()
      await flush()
      expect(modals.stack).toHaveLength(0)
      expect(showToast).toHaveBeenCalledWith({ message: "disk unavailable", variant: "error" })
      dispose()
    })
  })

  it("selecting unconfigured Copilot shows the flow's own question first", async () => {
    await createRoot(async (dispose) => {
      const { modal } = createModal()
      await openCopilotPrompt(modal)
      expect(modal.authView()).toMatchObject({ kind: "login-prompt", providerId: "github_copilot", label: "Copilot Subscription", prompt: COPILOT_PROMPT })
      dispose()
    })
  })

  it("SuperGrok starts directly with a complete link and does not copy a code", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, clipboard } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "supergrok"))
      await flush()
      expect(modal.authView()).toMatchObject({ kind: "device-code", providerId: "supergrok", url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234" })
      expect(modal.authView()).not.toHaveProperty("userCode")
      modals.input({ name: "c" })
      expect(clipboard.copy).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("selecting unconfigured ChatGPT asks the runtime to open the page and switches to browser-auth view", async () => {
    await createRoot(async (dispose) => {
      const { modal, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()
      expect(modal.authView().kind).toBe("browser-auth")
      expect(sent("auth.login")).toEqual([{ type: "auth.login", providerId: "chatgpt", profileId: "default", openBrowser: true }])
      expect(sent("auth.login.cancel")).toEqual([])
      dispose()
    })
  })

  it("escape from ChatGPT browser auth cancels login without an error toast", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()
      expect(modal.authView().kind).toBe("browser-auth")
      // Escape closes the whole modal and stops the runtime's flow; the
      // left arrow is the in-modal path back to the provider list.
      modals.input({ name: "escape" })
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "chatgpt-operation" }])
      expect(modals.stack.length).toBe(0)
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("a backdrop-style raw clear cancels the live login attempt", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()
      expect(modal.authView().kind).toBe("browser-auth")
      // The backdrop click path calls the stack's raw clear, bypassing
      // closeAuthModal; the entry's onClose must still stop the flow.
      modals.clear()
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "chatgpt-operation" }])
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("unconfigured api-key provider opens api-key-input instead of disconnecting", async () => {
    await createRoot(async (dispose) => {
      const { modal, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      expect(modal.authView().kind).toBe("api-key-input")
      await flush()
      expect(sent("auth.account.disconnect")).toEqual([])
      dispose()
    })
  })

  it("writes the key to the profile the modal shows", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal("work")
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "anthropic_api"))
      modals.input({ name: "a", sequence: "a" })
      modals.input({ name: "return" })
      await flush()
      expect(sent("auth.login").map(({ profileId }) => profileId)).toEqual(["work"])
      dispose()
    })
  })

})

// Attempt correlation: a login's answer or settlement may only mutate state,
// toast, or navigate while its attempt is still the current one. The fake
// runtime answers each login with its own operation, and a test settles it on
// demand, as a runtime that finishes late does.
describe("useAuthModal attempt correlation", () => {
  beforeEach(clearMocks)

  /** Answers each ChatGPT login with a browser step of a fresh operation. */
  function numberedChatGPTOperations(): void {
    let count = 0
    runtimeLogin.mockImplementation(async (request) => ({ kind: "browser", operationId: `chatgpt-${++count}`, providerId: request.providerId, authorizeUri: "https://auth.test" }))
  }

  const completed = (operationId: string) => ({ kind: "completed" as const, operationId, providerId: "chatgpt" })

  it("a cancelled login that settles late produces no side effects", async () => {
    numberedChatGPTOperations()
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, settle, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()
      expect(modal.authView().kind).toBe("browser-auth")

      // The left arrow returns to the provider list, which stops the runtime's flow.
      modals.input({ name: "left" })
      expect(modal.authView().kind).toBe("list")
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "chatgpt-1" }])
      showToast.mockClear()

      settle(completed("chatgpt-1"))
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      expect(modals.stack.length).toBe(1)
      dispose()
    })
  })

  it("a superseded login cannot apply; only the current attempt's settlement does", async () => {
    numberedChatGPTOperations()
    await createRoot(async (dispose) => {
      const { modal, showToast, settle } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()

      settle(completed("chatgpt-1"))
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      expect(modal.authView().kind).toBe("browser-auth")

      settle(completed("chatgpt-2"))
      await flush()
      expect(showToast).toHaveBeenCalledWith({ message: "ChatGPT Subscription auth active", variant: "success" })
      expect(modal.authView().kind).toBe("list")
      dispose()
    })
  })

  it("a login answer that arrives after the attempt ended cannot change the view, and stops its flow", async () => {
    const answer = Promise.withResolvers<RuntimeAuthLoginResult>()
    runtimeLogin.mockImplementation(() => answer.promise)
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()

      modals.input({ name: "escape" })
      answer.resolve({ kind: "browser", operationId: "late", providerId: "chatgpt", authorizeUri: "https://auth.test" })
      await flush()
      expect(modal.authView().kind).toBe("list")
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "late" }])
      dispose()
    })
  })

  it("closing the modal invalidates the in-flight login", async () => {
    numberedChatGPTOperations()
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, settle } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()

      modal.closeAuthModal()
      expect(modals.stack.length).toBe(0)
      showToast.mockClear()

      settle(completed("chatgpt-1"))
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      expect(modals.stack.length).toBe(0)
      dispose()
    })
  })

  it("a stale login failure produces no toast or navigation", async () => {
    numberedChatGPTOperations()
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, settle } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()

      modals.input({ name: "escape" })
      showToast.mockClear()

      settle({ kind: "failed", operationId: "chatgpt-1", providerId: "chatgpt", message: "network down" })
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("a replacement modal detaches auth and cancels its in-flight login", async () => {
    numberedChatGPTOperations()
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, settle, sent } = createModal()
      modal.openAuthModal()
      modal.selectProvider(rowIndexOf(modal, "chatgpt"))
      await flush()

      const newer = modals.replace("newer-modals")
      expect(sent("auth.login.cancel")).toEqual([{ type: "auth.login.cancel", operationId: "chatgpt-1" }])
      showToast.mockClear()
      settle(completed("chatgpt-1"))
      await flush()

      expect(newer.isOpen()).toBe(true)
      expect(modals.stack).toHaveLength(1)
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("disconnect sends the profile the modal shows, and a refusal names the provider", async () => {
    setAuthStatuses({ providerId: "anthropic_api", source: "stored_key" })
    await createRoot(async (dispose) => {
      const { modal, modals, showToast, runtime, sent } = createModal()
      runtime["auth.account.disconnect"].mockImplementationOnce(async () => ({ ok: false, error: "file locked" }))
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "d" })
      modals.input({ name: "y" })
      for (let i = 0; i < 10 && showToast.mock.calls.length === 0; i++) await Bun.sleep(0)

      expect(sent("auth.account.disconnect")).toEqual([{ type: "auth.account.disconnect", providerId: "anthropic_api", profileId: "default" }])
      expect(showToast).toHaveBeenCalledWith({ message: "Anthropic API Key disconnect failed: file locked", variant: "error" })
      dispose()
    })
  })
})
