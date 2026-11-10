import { describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal, runWithOwner } from "solid-js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import { activate, clearMocks, createModal, flush, rowIds, rowOf, valueOf } from "./_settings-modal-fixtures.js"
import { createAuthProfileSelection } from "../../../../src/tui/hooks/auth-profile-selection.js"
import type { RuntimeAuthProfileRenameResult } from "../../../../src/protocol/auth-profile-selection-protocol-types.js"

describe("useSettingsModal auth profiles", () => {
  it("cycles the active profile training-route policy after Auth", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, configDispatch } = createModal()
      modal.openSettingsModal()

      const ids = rowIds(modal)
      expect(ids.indexOf("allow-training-routes")).toBe(ids.indexOf("auth-profiles") + 1)
      const row = rowOf(modal, "allow-training-routes")
      expect(row.label).toBe("Allow training routes")
      expect(row.description).toBe("Let providers train on requests sent through contributor routes.")
      expect(valueOf(modal, "allow-training-routes")).toBe("Off · Default")

      activate(modal, "allow-training-routes")
      await flush()

      expect(configDispatch).toHaveBeenCalledWith({ type: "config.mutate", target: { kind: "profile", profileId: "default" }, setting: { id: "allowTrainingRoutes", expected: { kind: "value", value: false }, desired: true } })
      expect(valueOf(modal, "allow-training-routes")).toBe("On · Default")
      dispose()
    })
  })

  it("shows the existing unavailable feedback when profile configuration is unavailable", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, configDispatch } = createModal({ configStatus: { kind: "disposed", message: "The configuration owner is disposed." } })
      modal.openSettingsModal()

      const row = rowOf(modal, "allow-training-routes")
      expect(valueOf(modal, "allow-training-routes")).toBe("N/A")
      expect(row.unavailableReason?.()).toBe("The configuration owner is disposed.")
      activate(modal, "allow-training-routes")
      await flush()
      expect(configDispatch).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("keeps create profile open with the runtime refusal inline", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal()
      dispatch.mockResolvedValueOnce({ ok: false, error: "runtime refused" })
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "down" })
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      for (const character of "next") modals.input({ name: character, raw: character })
      modals.input({ name: "return" })
      await flush()

      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.create", scope: { kind: "defaults" }, displayName: "next" })
      expect(modal.settingsView()).toMatchObject({ kind: "edit", error: "runtime refused" })
      dispose()
    })
  })

  it("renders the default profile as Default and renames the profile under the option cursor", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal()
      const pending = Promise.withResolvers<RuntimeAuthProfileRenameResult>()
      dispatch.mockImplementationOnce(() => pending.promise)
      modal.openSettingsModal()
      expect(valueOf(modal, "auth-profile")).toBe("Default")
      activate(modal, "auth-profile")
      const select = modal.settingsView()
      if (select.kind !== "single-select") throw new Error("Expected profile selector")
      expect(select.result.rows.flatMap((row) => row.kind === "option" ? [row.option.title] : [])).toEqual(["Default", "Work", "Create Profile"])

      modals.input({ name: "down" })
      modals.input({ name: "r", raw: "r" })
      expect(modal.settingsView()).toMatchObject({ kind: "edit", current: "Work", presentation: { value: "Work" } })
      for (const character of "Work Account") modals.input({ name: character === " " ? "space" : character.toLowerCase(), raw: character })
      modals.input({ name: "escape" })
      const saving = modal.settingsView()
      const profile = saving.kind === "list" ? saving.rows.find((row) => row.kind === "single-select" && row.id === "auth-profile") : undefined
      expect(profile?.kind === "single-select" ? profile.value() : undefined).toBe("Saving...")
      pending.resolve({ id: "work", displayName: "Work Account" })
      await flush()

      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.rename", scope: { kind: "defaults" }, id: "work", displayName: "Work Account" })
      expect(modal.settingsView().kind).toBe("list")
      dispose()
    })
  })

  it("opens delete confirmation with Cancel selected and dispatches after confirmation", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, showToast } = createModal()
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "down" })
      const choice = modal.settingsView()
      if (choice.kind !== "single-select") throw new Error("Expected profile selector")
      expect(choice.hotkeyHint).toContain("d delete")
      const cursorRow = choice.result.rows[choice.cursor]
      expect(cursorRow?.kind === "option" ? cursorRow.option.title : "").toBe("Work")
      modals.input({ name: "down" })
      const createChoice = modal.settingsView()
      if (createChoice.kind !== "single-select") throw new Error("Expected profile selector")
      expect(createChoice.hotkeyHint).not.toContain("d delete")
      modals.input({ name: "up" })
      modals.input({ name: "d", raw: "d" })
      await flush()
      expect(modal.settingsView()).toMatchObject({ kind: "confirmation", choice: "cancel", actionLabel: "Delete" })
      modals.input({ name: "left" })
      modals.input({ name: "enter" })
      await flush()

      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "default" })
      expect(showToast).toHaveBeenCalledWith({ message: "Profile Work deleted", variant: "success" })
      dispose()
    })
  })

  it("leaves nothing of a closed delete confirmation to run again on a later deletion", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query } = createModal()
      // Each preview counts the reads of its kind, so a confirmation that was
      // closed and still derives its view shows on its own preview.
      const reads: number[] = []
      query.mockImplementation(async () => {
        const index = reads.push(0) - 1
        return {
          get kind() { reads[index]! += 1; return "automatic" as const },
          source: { id: "work", displayName: "Work" },
          successor: { id: "default", displayName: "Default" },
        }
      })
      // The terminal keypress listener runs with no Solid owner.
      const press = (name: string) => runWithOwner(null, () => modals.input({ name, raw: name }))
      const openDeleteConfirmation = async () => {
        modal.openSettingsModal()
        activate(modal, "auth-profile")
        press("down")
        press("d")
        await flush()
        expect(modal.settingsView()).toMatchObject({ kind: "confirmation", phase: "ready" })
      }
      const closedConfirmations = 5
      for (let opened = 0; opened < closedConfirmations; opened += 1) {
        await openDeleteConfirmation()
        press("escape")
        press("escape")
        expect(modals.stack).toHaveLength(0)
      }

      const readsOfClosed = () => reads.slice(0, closedConfirmations).reduce((sum, count) => sum + count, 0)
      const before = readsOfClosed()
      await openDeleteConfirmation()
      press("left")
      press("enter")
      await flush()

      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "default" })
      expect(readsOfClosed()).toBe(before)
      dispose()
    })
  })

  it("restores the saved profile after a refused rename and explains the failure", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const authView = {
        providers: [],
        warnings: [],
        profile: { id: "default", displayName: "Default", source: "environment" as const, availableProfiles: [{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work" }] },
        subscriptionSpendConsent: { kind: "available" as const, profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
      }
      const { modal, modals, dispatch, showToast } = createModal({ authView })
      dispatch.mockRejectedValueOnce(new Error("cannot rename the environment-selected auth profile"))
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "r", raw: "r" })
      modals.paste("New name")
      modals.input({ name: "return" })
      await flush()

      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.rename", scope: { kind: "defaults" }, id: "default", displayName: "New name" })
      expect(modal.settingsView().kind).toBe("list")
      expect(valueOf(modal, "auth-profile")).toBe("Default (environment)")
      expect(showToast).toHaveBeenCalledWith({ message: "cannot rename the environment-selected auth profile", variant: "error" })
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "d", raw: "d" })
      expect(modal.settingsView().kind).toBe("single-select")
      expect(dispatch).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  it("deletes the last profile with a fresh Default and cancels a pending preview", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query } = createModal()
      const preview = { kind: "fresh-default", source: { id: "default", displayName: "Default" } } as const
      query.mockResolvedValue(preview)
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "d", raw: "d" })
      expect(modal.settingsView()).toMatchObject({ phase: "loading", choice: "cancel" })
      modals.input({ name: "escape" })
      await flush()
      expect(modal.settingsView().kind).toBe("list")
      expect(dispatch).not.toHaveBeenCalled()
      activate(modal, "auth-profile")
      modals.input({ name: "d", raw: "d" })
      await flush()
      expect(modal.settingsView()).toMatchObject({ phase: "ready", choice: "cancel", message: expect.stringContaining("fresh Default") })
      modals.input({ name: "tab" })
      modals.input({ name: "enter" })
      expect(modal.settingsView()).toMatchObject({ pending: true })
      modals.input({ name: "escape" })
      expect(modal.settingsView()).toMatchObject({ pending: true })
      await flush()
      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "default", successorId: null })
      dispose()
    })
  })

  it("requires a destination and preserves the source and destination through failure", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query } = createModal()
      query.mockResolvedValue({ kind: "choose", source: { id: "work", displayName: "Work" }, candidates: [{ id: "personal", displayName: "Personal" }, { id: "other", displayName: "Other" }] })
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "down" })
      modals.input({ name: "d", raw: "d" })
      await flush()
      modals.input({ name: "tab" })
      modals.input({ name: "enter" })
      expect(dispatch).not.toHaveBeenCalled()
      modals.input({ name: "down" })
      dispatch.mockRejectedValueOnce(new Error("cleanup failed"))
      modals.input({ name: "enter" })
      modals.input({ name: "enter" })
      await flush()
      expect(modal.settingsView()).toMatchObject({ phase: "ready", selectedId: "personal", error: "cleanup failed", choice: "confirm", pending: false })
      modals.input({ name: "enter" })
      await flush()
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenLastCalledWith({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "personal" })
      expect(modal.settingsView().kind).toBe("list")
      dispose()
    })
  })

  it("retries preview failure without mutating and restores Cancel as the default", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch, query } = createModal()
      query.mockRejectedValueOnce(new Error("preview unavailable"))
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "down" })
      modals.input({ name: "d", raw: "d" })
      await flush()
      expect(modal.settingsView()).toMatchObject({ phase: "preview-error", error: "preview unavailable", actionLabel: "Retry" })
      modals.input({ name: "tab" })
      modals.input({ name: "enter" })
      await flush()
      expect(modal.settingsView()).toMatchObject({ phase: "ready", choice: "cancel" })
      expect(query).toHaveBeenCalledTimes(2)
      expect(dispatch).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("keeps reserved profile names distinct from actions and the unbound sentinel", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const authView = {
        providers: [],
        profile: {
          id: "create-profile",
          displayName: "Create Profile",
          source: "sticky" as const,
          availableProfiles: [{ id: "create-profile", displayName: "Create Profile" }, { id: "__unbound", displayName: "Unbound Profile" }],
          projectBinding: "__unbound",
        },
        warnings: [],
        subscriptionSpendConsent: { kind: "available" as const, profileId: "create-profile", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
      }
      const { modal, modals, dispatch } = createModal({ authView })
      modal.openSettingsModal()

      activate(modal, "auth-profile")
      let select = modal.settingsView()
      if (select.kind !== "single-select") throw new Error("Expected profile selector")
      expect(select.result.rows.flatMap((row) => row.kind === "option" ? [row.option.id] : [])).toEqual(["profile:create-profile", "profile:__unbound", "action:create-profile"])

      modals.input({ name: "return" })
      await flush()
      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.select", scope: { kind: "defaults" }, id: "create-profile" })

      modal.openSettingsModal()
      activate(modal, "project-profile")
      select = modal.settingsView()
      if (select.kind !== "single-select") throw new Error("Expected project profile selector")
      expect(select.result.rows.flatMap((row) => row.kind === "option" ? [row.option.id] : [])).toEqual(["sentinel:unbound", "profile:create-profile", "profile:__unbound"])
      // The picker opens on the binding in force, not on its first row.
      const bound = select.result.rows[select.cursor]
      expect(bound?.kind === "option" ? bound.option.id : undefined).toBe("profile:__unbound")
      for (const character of "Unbound") modals.input({ name: character.toLowerCase(), raw: character })
      modals.input({ name: "return" })
      await flush()
      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.bind_current_project", scope: { kind: "defaults" }, id: "__unbound" })
      dispose()
    })
  })

  it("selects the foreground profile with session scope", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, dispatch } = createModal({ foregroundSessionId: "tab-1" })
      modal.openSettingsModal()
      activate(modal, "auth-profile")
      modals.input({ name: "down" })
      modals.input({ name: "return" })
      await flush()

      expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.select", scope: { kind: "session", sessionId: "tab-1" }, id: "work" })
      dispose()
    })
  })

  it("forces consent review after selecting the active profile", async () => {
    const dispatch = runtimeDispatch({ "auth.profile.select": async () => ({ id: "work" }) })
    const reviewActiveProfile = mock(async () => true)
    const [foregroundSessionId] = createSignal<string | undefined>("chat-1")
    const selection = createAuthProfileSelection({
      appService: { dispatch },
      foregroundSessionId,
      showToast: mock(() => {}),
      reviewActiveProfile,
    })

    await selection.select("work", "Work")

    expect(reviewActiveProfile).toHaveBeenCalledTimes(1)
  })
})
