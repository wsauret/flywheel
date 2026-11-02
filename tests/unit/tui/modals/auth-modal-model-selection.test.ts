import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { subscriptionSpendAccountCorrelationId } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { openRouterAuthView, providerModelView } from "./_auth-modal-model-fixtures.js"
import { createModal, settle } from "./_auth-modal-model-harness.js"

describe("auth modal provider model selection", () => {

  it("preserves the model identity and search editor through a quiet catalog publication", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, query, setProviderModelQueryRows, setProviderModelQueryRevision, publishCatalog, holdNextProviderModelQuery } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      modals.paste("claude")
      expect(query).toHaveBeenCalledTimes(1)
      modals.input({ name: "down" })
      const editor = modal.authInputPresentation()
      const release = holdNextProviderModelQuery()
      setProviderModelQueryRevision(9)
      setProviderModelQueryRows([{ modelId: "claude-new", checked: true, optInAvailable: true, configured: true }, ...providerModelView.rows])
      await publishCatalog()
      expect(modal.authView()).toMatchObject({ kind: "provider-models", loading: false, query: "claude", cursor: 1 })
      expect(modal.authInputPresentation()).toEqual(editor)
      release()
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(modal.authView()).toMatchObject({ kind: "provider-models", loading: false, query: "claude", cursor: 2, eligibilityRevision: 9 })
      expect(modal.authInputPresentation()).toEqual(editor)
      dispose()
    })
  })

  it("schedules profile discovery and applies published rows without a broad auth refresh", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query, catalogRequests, failProviderCatalog, setProviderModelQueryRows, setProviderModelQueryRevision, publishCatalog } = createModal()
      failProviderCatalog()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      expect(modal.authView().kind).toBe("provider-models")
      const initial = modal.authView()
      expect(initial.kind === "provider-models" ? initial.rows.length : -1).toBe(0)
      setProviderModelQueryRows(providerModelView.rows)
      setProviderModelQueryRevision(8)
      await publishCatalog()
      for (let i = 0; i < 10; i++) {
        const current = modal.authView()
        if (current.kind !== "provider-models" || current.rows.length > 0) break
        await Bun.sleep(0)
      }
      expect(catalogRequests).toHaveBeenCalledWith({ type: "auth.catalog.refresh", scope: { kind: "profile", profileId: "default" } })
      expect(dispatch.mock.calls.some(([request]) => request.type === "auth.refresh")).toBe(false)
      expect(query.mock.calls.filter(([request]) => request.type === "provider_models.query")).toHaveLength(2)
      const refreshed = modal.authView()
      expect(refreshed.kind === "provider-models" ? refreshed.rows.length : -1).toBe(providerModelView.rows.length)
      dispose()
    })
  })

  it("keeps unavailable status without loading and schedules again on reopening", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, catalogRequests, failProviderCatalog, keepCatalogUnavailable } = createModal()
      failProviderCatalog()
      keepCatalogUnavailable()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      for (let i = 0; i < 10; i++) await Bun.sleep(0)
      const view = modal.authView()
      expect(view.kind).toBe("provider-models")
      if (view.kind === "provider-models") {
        expect(view.loading).toBe(false)
        expect(view.error).toBeDefined()
      }
      expect(catalogRequests).toHaveBeenCalledTimes(1)
      modals.input({ name: "left" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      for (let i = 0; i < 10 && catalogRequests.mock.calls.length < 2; i++) await Bun.sleep(0)
      expect(catalogRequests).toHaveBeenCalledTimes(2)
      dispose()
    })
  })

  it("opens models with Enter and disconnects with d once confirmed", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, query, dispatch } = createModal()
      const disconnects = () => dispatch.mock.calls.filter(([request]) => request.type === "auth.account.disconnect")
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      await settle()
      expect(modal.authView()).toMatchObject({ kind: "provider-settings", option: { id: "anthropic_api" } })
      modals.input({ name: "return" })
      await settle()
      expect(query).toHaveBeenCalledWith({ type: "provider_models.query", profileId: "default", target: { kind: "singleton", providerId: "anthropic_api" } })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", target: { kind: "singleton", providerId: "anthropic_api" }, cursor: 0 })
      modals.input({ name: "left" })
      modals.input({ name: "d" })
      modals.input({ name: "y" })
      for (let i = 0; i < 5 && disconnects().length === 0; i++) await Bun.sleep(0)
      expect(disconnects()).toEqual([[{ type: "auth.account.disconnect", providerId: "anthropic_api", profileId: "default" }]])
      dispose()
    })
  })

  it("toggles the exact OpenRouter account free-route preference with f", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal(() => openRouterAuthView)
      modal.openAuthModal()
      const openrouter = modal.authRows().findIndex((row) => (row.kind === "provider" || row.kind === "account") && row.option.id === "openrouter")
      modal.selectProvider(openrouter)
      await settle()
      expect(modal.authView()).toMatchObject({ kind: "provider-settings", freeRoutes: { enabled: false, changing: false } })

      modals.input({ name: "f" })
      await settle()
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "provider_free_routes.set", target: { kind: "singleton", providerId: "openrouter" }, enabled: true }))
      expect(modal.authView()).toMatchObject({ kind: "provider-settings", freeRoutes: { enabled: true, changing: false } })
      dispose()
    })
  })

  it("removes a free-route control omitted by the mutation result", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, setNextFreeRouteResult } = createModal(() => openRouterAuthView)
      modal.openAuthModal()
      modal.selectProvider(modal.authRows().findIndex((row) => row.kind === "provider" && row.option.id === "openrouter"))
      setNextFreeRouteResult("missing")
      modals.input({ name: "f" })
      await settle()
      expect(modal.authView().kind).toBe("provider-settings")
      expect("freeRoutes" in modal.authView()).toBe(false)
      dispose()
    })
  })

  it("refreshes canonical free-route state and reports a concise save failure", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, setNextFreeRouteResult } = createModal(() => openRouterAuthView)
      modal.openAuthModal()
      modal.selectProvider(modal.authRows().findIndex((row) => row.kind === "provider" && row.option.id === "openrouter"))
      setNextFreeRouteResult("error")
      modals.input({ name: "f" })
      await settle()
      expect(modal.authView()).toMatchObject({ kind: "provider-settings", freeRoutes: { enabled: false, changing: false, feedback: "Free-route preference could not be saved" } })
      dispose()
    })
  })

  it("opens models only when the subscription row is focused", async () => {
    await createRoot(async (dispose) => {
      const accountCorrelationId = subscriptionSpendAccountCorrelationId("default", "opencode_go", "go-account")
      const account = { instanceId: "go-account", accountCorrelationId, identity: "go-account", displayLabel: "OpenCode Go", expired: false, source: "stored_key" as const }
      const capability = {
        accountCorrelationId,
        providerId: "opencode_go",
        providerDisplayName: "OpenCode Go",
        providerStatus: "ok" as const,
        modes: [
          { mode: "prepaid" as const, envelopeId: "prepaid", evidence: { kind: "prepaid" as const, availability: "funded" as const }, decision: "unreviewed" as const },
          { mode: "automatic" as const, envelopeId: "automatic", evidence: { kind: "automatic-billing" as const, enablement: "unknown" as const }, decision: "unreviewed" as const },
        ],
      }
      const authView = {
        providers: [{ providerId: "opencode_go", kind: "subscription", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 30, group: "model", displayName: "OpenCode Go Subscription", accounts: [account] }],
        warnings: [],
        authFilePath: "/profiles/default/auth.json",
        profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
        subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1, accounts: [capability] },
      } satisfies RuntimeAuthView
      const { modal, modals, query } = createModal(() => authView)
      expect(modal.openAuthAccountDetail(authView, 9, "opencode_go", accountCorrelationId)).toBe(true)
      expect(modal.subscriptionSpendConsent.state()).toMatchObject({ kind: "detail", cursor: -1 })

      modals.input({ name: "down" })
      expect(modal.subscriptionSpendConsent.state()).toMatchObject({ kind: "detail", cursor: 0 })
      modals.input({ name: "return" })
      await settle()
      expect(query).not.toHaveBeenCalled()
      expect(modal.authView().kind).toBe("provider-settings")

      modals.input({ name: "up" })
      modals.input({ name: "return" })
      await settle()
      expect(query).toHaveBeenCalledWith({ type: "provider_models.query", profileId: "default", target: { kind: "subscription", providerId: "opencode_go", accountCorrelationId } })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", target: { kind: "subscription", providerId: "opencode_go", accountCorrelationId } })
      dispose()
    })
  })

  it("wraps model rows and applies a toggle after the matching ack", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "up" })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", cursor: 1 })
      modals.input({ name: "space" })
      await settle()
      expect(dispatch).toHaveBeenCalledWith({ type: "provider_model.set", queriedProfileId: "default", queriedEligibilityRevision: 7, target: { kind: "singleton", providerId: "anthropic_api" }, modelId: "claude-sonnet-4", checked: false })
      const view = modal.authView()
      expect(view).toMatchObject({ kind: "provider-models", eligibilityRevision: 8 })
      expect(view.kind === "provider-models" ? view.rows.map((row) => row.checked) : []).toEqual([false, false])
      dispose()
    })
  })

  it("keeps the highlighted model while a narrower query still matches it", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()

      for (const name of "claude") modals.input({ name })
      modals.input({ name: "down" })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", query: "claude", cursor: 1 })
      modals.input({ name: "-", sequence: "-" })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", query: "claude-", cursor: 1 })
      modals.input({ name: "o" })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", query: "claude-o", cursor: 0 })
      dispose()
    })
  })

  it("filters model rows while typing and deselects the complete account with Ctrl+D", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()

      for (const name of "sonnet") modals.input({ name })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", query: "sonnet", cursor: 0 })
      modals.input({ name: "space" })
      await settle()
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "provider_model.set", modelId: "claude-sonnet-4" }))

      modals.input({ name: "d", ctrl: true })
      for (let attempt = 0; attempt < 5 && dispatch.mock.calls.length < 2; attempt += 1) await Bun.sleep(0)
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "provider_models.deselect_all", target: { kind: "singleton", providerId: "anthropic_api" } }))
      expect(modal.authView()).toMatchObject({ kind: "provider-models", query: "sonnet" })
      const view = modal.authView()
      expect(view.kind === "provider-models" ? view.rows.every((row) => !row.checked) : false).toBe(true)
      dispose()
    })
  })

  it("rechecks access only when the server offers it and keeps the cursor on the next surviving row", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, publishCatalog, setProviderModelQueryRows, setProviderModelQueryRevision, setProviderModelRecheckAvailable } = createModal()
      const opus = { modelId: "claude-opus-4-1", checked: false, optInAvailable: true, configured: true, accessState: "verified" } as const
      const sonnet = { modelId: "claude-sonnet-4", checked: false, optInAvailable: true, configured: true, accessState: "pending" } as const
      const haiku = { modelId: "claude-haiku-4", checked: false, optInAvailable: true, configured: true, accessState: "pending" } as const
      setProviderModelQueryRows([opus, sonnet, haiku])
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()

      modals.input({ name: "r", ctrl: true })
      await settle()
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "provider_models.recheck" }))

      modals.input({ name: "down" })
      setProviderModelRecheckAvailable(true)
      setProviderModelQueryRevision(8)
      setProviderModelQueryRows([opus, haiku])
      await publishCatalog()
      const view = modal.authView()
      expect(view).toMatchObject({ kind: "provider-models", recheckAvailable: true, cursor: 1 })
      expect(view.kind === "provider-models" ? view.rows.map((row) => row.modelId) : []).toEqual([opus.modelId, haiku.modelId])

      modals.input({ name: "r", ctrl: true })
      await settle()
      expect(dispatch).toHaveBeenCalledWith({ type: "provider_models.recheck", queriedProfileId: "default", queriedEligibilityRevision: 8, target: { kind: "singleton", providerId: "anthropic_api" } })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", rechecking: false, cursor: 1 })
      dispose()
    })
  })

  it("toggles the profile automatic-new-model policy from the profile row", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal()
      modal.openAuthModal()
      expect(modal.authRows()[1]).toMatchObject({ kind: "profile-policy", enabled: true, changing: false })

      modals.input({ name: "a" })
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const policy = modal.authRows()[1]
        if (policy?.kind !== "profile-policy" || !policy.changing) break
        await Bun.sleep(0)
      }
      expect(dispatch).toHaveBeenCalledWith({ type: "provider_models.set_auto_enable", queriedProfileId: "default", queriedEligibilityRevision: 7, enabled: false })
      expect(modal.authRows()[1]).toMatchObject({ kind: "profile-policy", enabled: false, changing: false })
      dispose()
    })
  })

  it("settles profile automatic-new-model failures on the profile row", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, failNextAutoEnableMutation } = createModal()
      modal.openAuthModal()

      failNextAutoEnableMutation("save failed")
      modals.input({ name: "a" })
      for (let attempt = 0; attempt < 5; attempt += 1) await Bun.sleep(0)
      expect(modal.authRows()[1]).toMatchObject({ kind: "profile-policy", enabled: true, changing: false, feedback: "save failed" })
      dispose()
    })
  })

  it("navigates non-actionable fallback rows without dispatching fake controls", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, failProviderCatalog, setProviderModelQueryRows } = createModal()
      failProviderCatalog()
      setProviderModelQueryRows([
        { modelId: "gpt-5", checked: true, optInAvailable: false, configured: true },
        { modelId: "gpt-4.1", checked: false, optInAvailable: false, configured: true },
      ])
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()

      modals.input({ name: "down" })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", cursor: 1 })
      modals.input({ name: "space" })
      modals.input({ name: "d", ctrl: true })
      await settle()
      expect(dispatch).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("preserves search typed while the provider catalog is loading", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, holdNextProviderModelQuery } = createModal()
      modal.openAuthModal()
      const providerIndex = modal.authRows().findIndex((row) => (row.kind === "provider" || row.kind === "account") && row.option.id === "anthropic_api")
      modal.selectProvider(providerIndex)
      const release = holdNextProviderModelQuery()
      modal.openAccountModels()
      for (const name of "sonnet") modals.input({ name })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", loading: true, query: "sonnet" })

      release()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const view = modal.authView()
        if (view.kind === "provider-models" && !view.loading) break
        await Bun.sleep(0)
      }

      expect(modal.authView()).toMatchObject({ kind: "provider-models", loading: false, query: "sonnet", cursor: 0 })
      dispose()
    })
  })

})
