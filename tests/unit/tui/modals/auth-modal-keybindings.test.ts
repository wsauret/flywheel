import { LOCAL_SIGN_IN } from "./auth-modal-test-harness.js"
import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import type { AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js"
import type { RuntimeAuthProfileDeletionPreview } from "../../../../src/protocol/auth-profile-selection-protocol-types.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { useAuthModal } from "../../../../src/tui/hooks/use-auth-modal.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery, type DispatchAnswer } from "../../../helpers/runtime-dispatch.js"

function createModal(providers: readonly AuthProviderStatus[], profileId: "default" | "work" = "default", profileAvailable = true, preview: RuntimeAuthProfileDeletionPreview = { kind: "automatic", source: { id: profileId, displayName: "Work" }, successor: { id: "default", displayName: "Default" } }) {
  const showToast = mock(() => {})
  // `dispatch` records every request. The runtime answers a login with the
  // page to sign in on, and every other request with success.
  const dispatch = mock((_request: FrontendMutation) => {})
  const profileDelete = mock<DispatchAnswer<"auth.profile.delete">>(async (request) => ({ id: request.id }))
  const runtime = runtimeDispatch({
    "auth.login": async (request) => ({ kind: "browser", operationId: "browser-operation", providerId: request.providerId, authorizeUri: "https://auth.example/authorize" }),
    "auth.login.cancel": async () => ({ ok: true }),
    "auth.account.disconnect": async () => ({ ok: true }),
    "auth.profile.select": async (request) => ({ id: request.id }),
    "auth.profile.delete": profileDelete,
  })
  const deletionQuery = mock(async () => preview)
  const query = runtimeQuery({
    authProfileDeletionPreview: deletionQuery,
    "provider_models.query": async () => ({ profileId, eligibilityRevision: 1, target: { kind: "singleton", providerId: "anthropic_api" }, providerDisplayName: "Anthropic", catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" }, rows: [] }),
  })
  const modals = createModalStack()
  const modal = useAuthModal({
    auth: () => ({
      providers,
      warnings: [],
      profile: { id: profileId, displayName: profileId === "default" ? "Default" : "Work", source: profileId === "default" ? "default" : "sticky", availableProfiles: [{ id: "default", displayName: "Default" }, ...(profileAvailable ? [{ id: "work", displayName: "Work" }] : [])] },
      subscriptionSpendConsent: { kind: "available", profileId, usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
    }),
    modal: modals,
    renderModal: () => "mock-auth-modal",
    showToast,
    appService: { subscribe: () => () => {}, onLane: fakeLanes().onLane, dispatch: recordedDispatch(dispatch, runtime), query },
    openBrowser: async () => true,
    signInPage: LOCAL_SIGN_IN,
    clipboard: { copy: async () => {}, readImage: async () => null },
  })
  /** The requests of one type the modal sent to the runtime. */
  const sent = (type: FrontendMutation["type"]) => dispatch.mock.calls.flatMap(([request]) => request.type === type ? [request] : [])
  return { modal, modals, dispatch, profileDelete, sent, showToast, deletionQuery }
}

describe("auth modal list keybindings", () => {

  it("keeps one subscription compact while preserving a confirmed disconnect and reconnect", async () => {
    await createRoot(async (dispose) => {
      const account = { instanceId: "account-1", accountCorrelationId: "opaque-account-1", identity: "me@example.com", displayLabel: "me@example.com", expired: true, source: "oauth" as const }
      const { modal, modals, sent } = createModal([{ providerId: "chatgpt", kind: "subscription", source: "oauth", expired: true, modelCapable: true, loginMethod: "browser-auth", statusRank: 60, group: "model", displayName: "ChatGPT", accounts: [account] }])
      modal.openAuthModal()

      expect(modal.authRows().filter((row) => row.kind === "account")).toEqual([])
      const onChatGPT = (): boolean => { const row = modal.authRows()[modal.authModalCursor()]; return row?.kind === "provider" && row.option.id === "chatgpt" }
      while (!onChatGPT()) modals.input({ name: "down" })
      expect(modal.authRows()[modal.authModalCursor()]?.kind).toBe("provider")
      modals.input({ name: "d" })
      expect(modal.disconnectConfirmation()).toMatchObject({ option: { id: "chatgpt" }, account: { instanceId: "account-1" } })
      modals.input({ name: "r" })
      modals.input({ name: "return" })
      modals.input({ name: "escape" })
      await Bun.sleep(0)
      expect(sent("auth.account.disconnect")).toEqual([])
      expect(modal.disconnectConfirmation()).toBeUndefined()
      expect(modal.authView().kind).toBe("list")
      expect(modals.stack).toHaveLength(1)

      modals.input({ name: "d" })
      modals.input({ name: "y" })
      expect(modal.disconnectConfirmation()).toBeUndefined()
      for (let i = 0; i < 10 && sent("auth.account.disconnect").length === 0; i++) await Bun.sleep(0)
      expect(sent("auth.account.disconnect")).toEqual([{ type: "auth.account.disconnect", providerId: "chatgpt", instanceId: "account-1", profileId: "default" }])

      modals.input({ name: "r" })
      expect(modal.authView().kind).toBe("list")
      expect(sent("auth.account.rename")).toEqual([])

      modals.input({ name: "return" })
      expect(modal.authView().kind).toBe("provider-settings")
      modals.input({ name: "d" })
      expect(modal.disconnectConfirmation()).toMatchObject({ option: { id: "chatgpt" }, account: { instanceId: "account-1" } })
      modals.input({ name: "n" })
      expect(modal.disconnectConfirmation()).toBeUndefined()
      expect(modal.authView().kind).toBe("provider-settings")
      expect(sent("auth.account.disconnect")).toHaveLength(1)
      modals.input({ name: "r" })
      for (let i = 0; i < 10 && sent("auth.login").length === 0; i++) await Bun.sleep(0)
      expect(sent("auth.login")).toEqual([{ type: "auth.login", providerId: "chatgpt", profileId: "default", openBrowser: true, instanceId: "account-1" }])
      dispose()
    })
  })

  it("nests account rows after a provider has a second subscription", () => {
    createRoot((dispose) => {
      const accounts = [
        { instanceId: "account-1", accountCorrelationId: "opaque-account-1", identity: "one@example.com", displayLabel: "one@example.com", expired: false, source: "oauth" as const },
        { instanceId: "account-2", accountCorrelationId: "opaque-account-2", identity: "two@example.com", displayLabel: "two@example.com", expired: false, source: "oauth" as const },
      ]
      const { modal, modals } = createModal([{ providerId: "chatgpt", kind: "subscription", source: "oauth", expired: false, modelCapable: true, loginMethod: "browser-auth", statusRank: 60, group: "model", displayName: "ChatGPT", accounts }])
      modal.openAuthModal()

      expect(modal.authRows().flatMap((row) => row.kind === "account" ? [row.account.instanceId] : [])).toEqual(["account-1", "account-2"])
      while (modal.authRows()[modal.authModalCursor()]?.kind !== "account") modals.input({ name: "down" })
      modals.input({ name: "r" })
      expect(modal.authView()).toMatchObject({ kind: "rename-input", instanceId: "account-1" })
      dispose()
    })
  })

  it("offers no rename for an account of an external login, from the list or from its settings", () => {
    createRoot((dispose) => {
      const accounts = [
        { instanceId: "uuid-one", accountCorrelationId: "opaque-account-1", identity: "one@example.com", displayLabel: "one@example.com", expired: false, source: "oauth" as const },
        { instanceId: "uuid-two", accountCorrelationId: "opaque-account-2", identity: "two@example.com", displayLabel: "two@example.com", expired: false, source: "oauth" as const },
      ]
      const { modal, modals, sent } = createModal([{ providerId: "claude_agent_sdk", kind: "subscription", source: "oauth", expired: false, modelCapable: true, loginMethod: "browser-auth", loginProgram: "Example CLI", statusRank: 5, group: "model", displayName: "Anthropic Subscription", accounts }])
      modal.openAuthModal()

      while (modal.authRows()[modal.authModalCursor()]?.kind !== "account") modals.input({ name: "down" })
      modals.input({ name: "r" })
      expect(modal.authView().kind).toBe("list")
      modals.input({ name: "return" })
      expect(modal.authView().kind).toBe("provider-settings")
      modals.input({ name: "n" })
      expect(modal.authView().kind).toBe("provider-settings")
      expect(sent("auth.account.rename")).toEqual([])
      dispose()
    })
  })

  it("d inside the api-key editor types into the draft instead of disconnecting", () => {
    createRoot((dispose) => {
      const { modal, modals, sent } = createModal([{ providerId: "anthropic_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic", accounts: [] }])
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      expect(modal.authView().kind).toBe("api-key-input")
      modals.input({ name: "d", sequence: "d" })
      expect(modal.apiKeyDraft()).toBe("d")
      expect(sent("auth.account.disconnect")).toEqual([])
      dispose()
    })
  })

  it("returns from a cancelled API key entry to the provider row it opened from", () => {
    createRoot((dispose) => {
      const { modal, modals } = createModal([{ providerId: "anthropic_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic", accounts: [] }])
      modal.openAuthModal()
      modals.input({ name: "down" })
      const providerRow = modal.authModalCursor()
      expect(modal.authRows()[providerRow]).toMatchObject({ kind: "provider", option: { id: "anthropic_api" } })
      modals.input({ name: "return" })
      expect(modal.authView().kind).toBe("api-key-input")
      modals.input({ name: "escape" })
      expect(modal.authView().kind).toBe("list")
      expect(modal.authModalCursor()).toBe(providerRow)
      dispose()
    })
  })

  it("uses selection editing and clears API key state before the next input", () => {
    createRoot((dispose) => {
      const { modal, modals } = createModal([{ providerId: "anthropic_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic", accounts: [] }])
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      for (const char of "abcd") modals.input({ name: char, sequence: char })
      modals.input({ name: "left", shift: true })
      modals.input({ name: "left", shift: true })
      modals.input({ name: "x", sequence: "x" })
      expect(modal.apiKeyDraft().length).toBe(3)

      modals.input({ name: "escape" })
      expect(modal.apiKeyDraft().length).toBe(0)
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "z", ctrl: true })
      expect(modal.apiKeyDraft().length).toBe(0)
      dispose()
    })
  })

  it("d on an unconfigured provider is a no-op", () => {
    createRoot((dispose) => {
      const { modal, modals, sent } = createModal([{ providerId: "chatgpt", kind: "subscription", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "browser-auth", statusRank: 60, group: "model", displayName: "ChatGPT", accounts: [] }])
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "d" })
      expect(sent("auth.account.disconnect")).toEqual([])
      dispose()
    })
  })

  it("Enter on a configured model-incapable provider opens settings and d disconnects after confirmation", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal([{ providerId: "anthropic_api", kind: "singleton", source: "stored_key", expired: false, modelCapable: false, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic", accounts: [] }])
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      expect(modal.authView().kind).toBe("provider-settings")
      expect(sent("auth.account.disconnect")).toEqual([])
      modals.input({ name: "d" })
      expect(modal.disconnectConfirmation()).toEqual({ option: expect.objectContaining({ id: "anthropic_api" }) })
      modals.input({ name: "escape" })
      await Bun.sleep(0)
      expect(sent("auth.account.disconnect")).toEqual([])
      expect(modal.authView().kind).toBe("provider-settings")
      modals.input({ name: "d" })
      modals.input({ name: "y" })
      for (let i = 0; i < 10 && sent("auth.account.disconnect").length === 0; i++) await Bun.sleep(0)
      expect(sent("auth.account.disconnect")).toEqual([{ type: "auth.account.disconnect", providerId: "anthropic_api", profileId: "default" }])
      dispose()
    })
  })
  it("confirms deletion for a real profile and dispatches the delete mutation", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, showToast } = createModal([], "work")
      modal.openAuthModal()
      modals.input({ name: "d" })
      expect(modal.authView()).toMatchObject({ kind: "profile-delete-confirmation", choice: "cancel" })
      await Bun.sleep(0)
      modals.input({ name: "left" })
      modals.input({ name: "enter" })
      await Bun.sleep(0)
      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "default" })
      expect(showToast).toHaveBeenCalledWith({ message: "Profile Work deleted", variant: "success" })
      expect(modal.authView()).toEqual({ kind: "list" })
      dispose()
    })
  })

  it("does not offer deletion for an unavailable session profile", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal([], "work", false)
      modal.openAuthModal()
      modals.input({ name: "d" })
      expect(modal.authView()).toEqual({ kind: "list" })
      expect(dispatch).not.toHaveBeenCalled()
      dispose()
    })
  })
  it("allows deleting the last Default and cancels without dispatch", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal([], "default", false, { kind: "fresh-default", source: { id: "default", displayName: "Default" } })
      modal.openAuthModal()
      modals.input({ name: "d" })
      modals.input({ name: "escape" })
      await Bun.sleep(0)
      expect(modal.authView()).toEqual({ kind: "list" })
      expect(dispatch).not.toHaveBeenCalled()
      modals.input({ name: "d" })
      await Bun.sleep(0)
      modals.input({ name: "tab" })
      modals.input({ name: "enter" })
      modals.input({ name: "enter" })
      await Bun.sleep(0)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "default", successorId: null })
      dispose()
    })
  })
  it("requires an explicit successor and keeps it after failure for retry", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, profileDelete } = createModal([], "work", true, { kind: "choose", source: { id: "work", displayName: "Work" }, candidates: [{ id: "personal", displayName: "Personal" }, { id: "other", displayName: "Other" }] })
      modal.openAuthModal()
      modals.input({ name: "d" })
      await Bun.sleep(0)
      modals.input({ name: "tab" })
      modals.input({ name: "enter" })
      expect(dispatch).not.toHaveBeenCalled()
      profileDelete.mockResolvedValueOnce({ ok: false, error: "cleanup failed" })
      modals.input({ name: "down" })
      modals.input({ name: "enter" })
      await Bun.sleep(0)
      expect(modal.authView()).toMatchObject({ id: "work", successorId: "personal", error: "cleanup failed" })
      modals.input({ name: "enter" })
      await Bun.sleep(0)
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenLastCalledWith({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "personal" })
      expect(modal.authView()).toEqual({ kind: "list" })
      dispose()
    })
  })
  it("retries a failed deletion preview and defaults back to Cancel", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, deletionQuery } = createModal([], "work")
      deletionQuery.mockRejectedValueOnce(new Error("preview unavailable"))
      modal.openAuthModal()
      modals.input({ name: "d" })
      await Bun.sleep(0)
      expect(modal.authView()).toMatchObject({ phase: "preview-error", error: "preview unavailable", choice: "cancel" })
      modals.input({ name: "tab" })
      modals.input({ name: "enter" })
      await Bun.sleep(0)
      expect(modal.authView()).toMatchObject({ phase: "ready", choice: "cancel" })
      expect(deletionQuery).toHaveBeenCalledTimes(2)
      expect(dispatch).not.toHaveBeenCalled()
      dispose()
    })
  })
})
