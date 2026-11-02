import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AuthModalDeps } from "../../../../src/tui/hooks/auth-modal-types.js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { openRouterAuthView, providerModelView } from "./_auth-modal-model-fixtures.js"
import { createModal, settle } from "./_auth-modal-model-harness.js"

describe("auth modal provider model read and mutation ordering", () => {

  it.each(["space", "d"] as const)("waits for a superseding quiet read before applying %s with the fresh revision", async (key) => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query, setProviderModelQueryRows, setProviderModelQueryRevision, publishCatalog, holdNextProviderModelQuery } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()
      const releaseFirst = holdNextProviderModelQuery()
      setProviderModelQueryRevision(9)
      await publishCatalog()
      const releaseSecond = holdNextProviderModelQuery()
      setProviderModelQueryRevision(10)
      await publishCatalog()
      expect(query).toHaveBeenCalledTimes(3)
      try {
        modals.input({ name: key, ctrl: key === "d" })
        modals.paste("opus")
        setProviderModelQueryRevision(11)
        await publishCatalog()
        await settle()
        expect(query).toHaveBeenCalledTimes(3)
        expect(modal.authView()).toMatchObject({ loading: false, query: "opus", eligibilityRevision: 7 })
        expect(dispatch).not.toHaveBeenCalled()
        releaseFirst()
        await settle()
        expect(dispatch).not.toHaveBeenCalled()
        setProviderModelQueryRows(providerModelView.rows.map((row) => ({ ...row, checked: true })))
        releaseSecond()
        await settle()
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
          type: key === "space" ? "provider_model.set" : "provider_models.deselect_all",
          queriedProfileId: "default",
          queriedEligibilityRevision: 11,
          target: { kind: "singleton", providerId: "anthropic_api" },
          ...(key === "space" ? { modelId: "claude-opus-4-1", checked: true } : {}),
        }))
      } finally {
        releaseFirst()
        releaseSecond()
        await settle()
        dispose()
      }
    })
  })

  it.each(["reopened", "profile", "missing", "unavailable", "catalog"] as const)("drops a held-read action when its target becomes %s", async (change) => {
    await createRoot(async (dispose) => {
      let auth: RuntimeAuthView = openRouterAuthView
      const { modal, modals, dispatch, query, setProviderModelQueryRows, setProviderModelQueryRevision, failProviderCatalog, publishCatalog, holdNextProviderModelQuery } = createModal(() => auth)
      const openModels = async () => {
        modal.openAuthModal()
        const provider = modal.authRows().findIndex((row) => row.kind === "provider" && row.option.id === "openrouter")
        modal.selectProvider(provider)
        await settle()
        modal.openAccountModels()
        await settle()
      }
      await openModels()
      expect(modal.authView()).toMatchObject({ kind: "provider-models", loading: false })
      const release = holdNextProviderModelQuery()
      setProviderModelQueryRevision(9)
      await publishCatalog()
      expect(query).toHaveBeenCalledTimes(2)
      try {
        modals.input({ name: change === "catalog" ? "d" : "space", ctrl: change === "catalog" })
        if (change === "reopened") {
          modal.closeAuthModal()
          await openModels()
        } else if (change === "profile") {
          auth = { ...auth, profile: { ...auth.profile, id: "other" } }
        } else if (change === "catalog") {
          failProviderCatalog()
        } else {
          setProviderModelQueryRows(change === "missing"
            ? [providerModelView.rows[1]]
            : providerModelView.rows.map((row) => ({ ...row, optInAvailable: false })))
        }
        release()
        await settle()
        expect(dispatch).not.toHaveBeenCalled()
      } finally {
        release()
        await settle()
        dispose()
      }
    })
  })

  it("refreshes stale model inputs without moving the focused row", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, query, failNextProviderModelMutation, setProviderModelQueryRevision, setProviderModelQueryRows } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "up" })
      modals.input({ name: "space" })
      await settle()
      failNextProviderModelMutation("auth profile inputs changed during provider-model preference mutation")
      setProviderModelQueryRevision(9)
      setProviderModelQueryRows([providerModelView.rows[1], providerModelView.rows[0]])

      modals.input({ name: "space" })
      for (let attempt = 0; attempt < 5 && query.mock.calls.length < 2; attempt += 1) await Bun.sleep(0)

      expect(query).toHaveBeenCalledTimes(2)
      expect(modal.authView()).toMatchObject({ kind: "provider-models", eligibilityRevision: 9, cursor: 0 })
      const refreshed = modal.authView()
      expect(refreshed.kind === "provider-models" ? refreshed.error : undefined).toBeUndefined()
      dispose()
    })
  })

  it("serializes rapid toggles so each keypress changes the latest state", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, holdNextProviderModelMutation } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "up" })
      const release = holdNextProviderModelMutation()

      modals.input({ name: "space" })
      modals.input({ name: "space" })
      await settle()
      expect(dispatch).toHaveBeenCalledTimes(1)
      release()
      for (let attempt = 0; attempt < 5 && dispatch.mock.calls.length < 2; attempt += 1) await Bun.sleep(0)

      const view = modal.authView()
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(dispatch.mock.calls.map(([request]) => request.type === "provider_model.set" ? request.checked : undefined)).toEqual([false, true])
      expect(view.kind === "provider-models" ? view.rows[1]?.checked : undefined).toBe(true)
      expect(view).toMatchObject({ kind: "provider-models", cursor: 1 })
      dispose()
    })
  })

  it("keeps a queued toggle bound to its model when search hides it", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, holdNextProviderModelMutation } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()
      const release = holdNextProviderModelMutation()

      modals.input({ name: "space" })
      modals.input({ name: "space" })
      for (const name of "sonnet") modals.input({ name })
      release()
      for (let attempt = 0; attempt < 5 && dispatch.mock.calls.length < 2; attempt += 1) await Bun.sleep(0)

      expect(dispatch.mock.calls.filter(([request]) => request.type === "provider_model.set").map(([request]) => request.type === "provider_model.set" ? request.modelId : undefined)).toEqual(["claude-opus-4-1", "claude-opus-4-1"])
      dispose()
    })
  })

  it("drops a queued deselect-all after navigation changes the exact provider", async () => {
    await createRoot(async (dispose) => {
      const auth: AuthModalDeps["auth"] = () => ({
        providers: [
          { providerId: "anthropic_api", kind: "singleton", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic API Key", accounts: [] },
          { providerId: "openrouter", kind: "singleton", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 80, group: "model", displayName: "OpenRouter API Key", accounts: [] },
        ],
        warnings: [],
        profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
        subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
      })
      const { modal, modals, dispatch, holdNextProviderModelMutation } = createModal(auth)
      modal.openAuthModal()
      const anthropic = modal.authRows().findIndex((row) => (row.kind === "provider" || row.kind === "account") && row.option.id === "anthropic_api")
      modal.selectProvider(anthropic)
      modal.openAccountModels()
      await settle()
      const release = holdNextProviderModelMutation()
      modals.input({ name: "space" })
      modals.input({ name: "d", ctrl: true })

      modal.closeAuthModal()
      modal.openAuthModal()
      const openrouter = modal.authRows().findIndex((row) => (row.kind === "provider" || row.kind === "account") && row.option.id === "openrouter")
      modal.selectProvider(openrouter)
      modal.openAccountModels()
      await settle()
      release()
      for (let attempt = 0; attempt < 5; attempt += 1) await Bun.sleep(0)

      expect(dispatch.mock.calls.some(([request]) => request.type === "provider_models.deselect_all")).toBe(false)
      dispose()
    })
  })

  it("keeps a queued toggle bound to its model across a stale reorder", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query, failNextProviderModelMutation, setProviderModelQueryRevision, setProviderModelQueryRows } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "up" })
      failNextProviderModelMutation("stale provider-model preference mutation")
      setProviderModelQueryRevision(9)
      setProviderModelQueryRows([providerModelView.rows[1], providerModelView.rows[0]])

      modals.input({ name: "space" })
      modals.input({ name: "space" })
      for (let attempt = 0; attempt < 5 && dispatch.mock.calls.length < 2; attempt += 1) await Bun.sleep(0)

      expect(query).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenLastCalledWith({ type: "provider_model.set", queriedProfileId: "default", queriedEligibilityRevision: 9, target: { kind: "singleton", providerId: "anthropic_api" }, modelId: "claude-sonnet-4", checked: false })
      expect(modal.authView()).toMatchObject({ kind: "provider-models", cursor: 0 })
      dispose()
    })
  })

  it("drops a queued toggle when its model disappears during refresh", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query, failNextProviderModelMutation, setProviderModelQueryRevision, setProviderModelQueryRows } = createModal()
      modal.openAuthModal()
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "up" })
      failNextProviderModelMutation("stale provider-model preference mutation")
      setProviderModelQueryRevision(9)
      setProviderModelQueryRows([providerModelView.rows[0]])

      modals.input({ name: "space" })
      modals.input({ name: "space" })
      for (let attempt = 0; attempt < 5 && query.mock.calls.length < 2; attempt += 1) await Bun.sleep(0)
      await settle()

      expect(query).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(modal.authView()).toMatchObject({ kind: "provider-models", cursor: 0 })
      dispose()
    })
  })
})
