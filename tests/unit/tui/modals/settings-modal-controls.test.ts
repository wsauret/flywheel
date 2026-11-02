import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import {
  activate,
  clearMocks,
  COPILOT_CAP,
  COPILOT_CAP_ROW_ID,
  createModal,
  flush,
  moduleRuntime,
  rowOf,
  valueOf,
} from "./_settings-modal-fixtures.js"
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js"

describe("useSettingsModal controls", () => {
  it("uses Right and Enter to advance value controls", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      activate(modal, "appearance")
      modals.input({ name: "down" })
      modals.input({ name: "right" })
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "showThinking", expected: { kind: "value", value: true }, desired: false } })
      expect(settings.values.showThinking).toBe(false)

      modals.input({ name: "return" })
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "showThinking", expected: { kind: "value", value: false }, desired: true } })
      expect(settings.values.showThinking).toBe(true)

      dispose()
    })
  })

  it("activates persisted cycle rows after successful writes", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      activate(modal, "diff-colors")
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "diffColors", expected: { kind: "value", value: "theme" }, desired: "standard" } })
      expect(settings.values.diffColors).toBe("standard")

      activate(modal, "show-thinking")
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "showThinking", expected: { kind: "value", value: true }, desired: false } })
      expect(settings.values.showThinking).toBe(false)


      activate(modal, "compatible-rendering")
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "compatibleRendering", expected: { kind: "value", value: "auto" }, desired: "on" } })
      activate(modal, "compatible-rendering")
      activate(modal, "compatible-rendering")
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "compatibleRendering", expected: { kind: "value", value: "off" }, desired: "auto" } })

      dispose()
    })
  })

  it("shows every boolean setting as a YES or NO cycle", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal({ initialUpdateAutoInstall: true })
      modal.openSettingsModal()

      for (const id of ["diff-colors", "show-thinking", "skills", "subagents", "learning", "background-commands", "auto-install"]) {
        expect(rowOf(modal, id).kind).toBe("cycle")
        expect(["YES", "NO"]).toContain(valueOf(modal, id))
      }
      dispose()
    })
  })

  it("shows Theme as a picker carrying the theme in effect", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openSettingsModal()

      expect(rowOf(modal, "theme").kind).toBe("picker")
      expect(valueOf(modal, "theme")).toBe("flywheel")
      dispose()
    })
  })

  it("shows a compact font status label on the font action row", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openSettingsModal()

      expect(rowOf(modal, "font").kind).toBe("action")
      expect(valueOf(modal, "font")).toBe("Not installed")
      dispose()
    })
  })

  it("edits permanent chat deletion from Off to whole days and back", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, configDispatch } = createModal()
      modal.openSettingsModal()
      expect(valueOf(modal, "auto-delete-session-days")).toBe("Off")
      expect(rowOf(modal, "auto-delete-session-days").description).toContain("Permanently")
      activate(modal, "auto-delete-session-days")
      modals.paste("14")
      expect(configDispatch).not.toHaveBeenCalled()
      modals.input({ name: "escape" })
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "autoDeleteSessionDays", expected: { kind: "value", value: 0 }, desired: 14 } })
      expect(valueOf(modal, "auto-delete-session-days")).toBe("14 days")
      await flush()
      activate(modal, "auto-delete-session-days")
      modals.paste("1")
      modals.input({ name: "return" })
      await flush()
      expect(valueOf(modal, "auto-delete-session-days")).toBe("1 day")
      activate(modal, "auto-delete-session-days")
      modals.paste("0")
      modals.input({ name: "return" })
      await flush()
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "autoDeleteSessionDays", expected: { kind: "value", value: 1 }, desired: 0 } })
      expect(valueOf(modal, "auto-delete-session-days")).toBe("Off")
      const writes = configDispatch.mock.calls.length
      for (const draft of ["-1", "1.5"]) {
        activate(modal, "auto-delete-session-days")
        modals.paste(draft)
        modals.input({ name: "return" })
        modals.input({ name: "tab" })
      }
      expect(configDispatch.mock.calls.length).toBe(writes)
      expect(valueOf(modal, "auto-delete-session-days")).toBe("Off")
      dispose()
    })
  })
  it.each(["escape", "tab", "up", "down", "click", "close"])("restores the saved value and explains invalid input on %s", (finish) => {
    createRoot((dispose) => {
      const { modal, modals, configDispatch, showToast } = createModal()
      modal.openSettingsModal()
      activate(modal, "auto-delete-session-days")
      modals.paste("-1")
      if (finish === "click") modal.finishSettingsEdit()
      else if (finish === "close") modal.closeSettingsModal()
      else modals.input({ name: finish })
      expect(configDispatch).not.toHaveBeenCalled()
      expect(modal.settingsView().kind).toBe("list")
      expect(valueOf(modal, "auto-delete-session-days")).toBe("Off")
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error", message: expect.stringContaining("whole") }))
      dispose()
    })
  })
  it.each([
    ["auto-delete-session-days", "14"],
    ["proactive-compaction-threshold", "300000"],
    [COPILOT_CAP_ROW_ID, "4100"],
  ])("shows a pending %s write in the editor and after leaving", async (id, value) => {
    await createRoot(async (dispose) => {
      const { modal, modals, configDispatch, showToast } = createModal()
      const pending = Promise.withResolvers<never>()
      configDispatch.mockImplementationOnce(() => pending.promise)
      modal.openSettingsModal()
      activate(modal, id)
      modals.paste(value)
      modals.input({ name: "return" })
      expect(modal.settingsView()).toMatchObject({ kind: "edit", saving: true })
      modals.input({ name: "tab" })
      expect(modal.settingsView().kind).toBe("list")
      const view = modal.settingsView()
      const row = view.kind === "list" ? view.rows.find((candidate) => candidate.kind === "edit" && candidate.id === id) : undefined
      expect(row?.kind === "edit" ? row.value() : undefined).toBe("Saving...")
      pending.reject(new Error("disk unavailable"))
      await flush()
      expect(valueOf(modal, id)).not.toBe("Saving...")
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error", message: expect.stringContaining("disk unavailable") }))
      dispose()
    })
  })
  it.each(["auto-delete-session-days", "proactive-compaction-threshold", COPILOT_CAP_ROW_ID])("writes nothing for an unchanged %s", (id) => {
    createRoot((dispose) => {
      const { modal, modals, configDispatch, showToast } = createModal()
      modal.openSettingsModal()
      activate(modal, id)
      modals.input({ name: "escape" })
      expect(configDispatch).not.toHaveBeenCalled()
      expect(showToast).not.toHaveBeenCalled()
      expect(modal.settingsView().kind).toBe("list")
      dispose()
    })
  })
  it.each([
    ["auto-delete-session-days", "14"],
    ["proactive-compaction-threshold", "300000"],
    [COPILOT_CAP_ROW_ID, "4100"],
  ])("reports a numeric write rejection after close: %s", async (id, value) => {
    await createRoot(async (dispose) => {
      const { modal, modals, configDispatch, showToast } = createModal()
      modal.openSettingsModal()
      activate(modal, id)
      modals.paste(value)
      configDispatch.mockRejectedValueOnce(new Error("disk unavailable"))
      modal.closeSettingsModal()
      await flush()
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error", message: expect.stringContaining("disk unavailable") }))
      dispose()
    })
  })
  it("edits proactive compaction threshold", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      expect(rowOf(modal, "proactive-compaction-threshold").kind).toBe("edit")
      expect(valueOf(modal, "proactive-compaction-threshold")).toBe("270k")

      activate(modal, "proactive-compaction-threshold")
      const emptyEditView = modal.settingsView()
      expect(emptyEditView.kind).toBe("edit")
      if (emptyEditView.kind === "edit") expect(emptyEditView.current).toBe("270,000")

      modals.paste("1,000,000")
      const draftedEditView = modal.settingsView()
      if (draftedEditView.kind === "edit") expect(draftedEditView.presentation.value).toBe("1,000,000")
      modals.input({ name: "return" })

      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "proactiveCompactionThreshold", expected: { kind: "value", value: 270_000 }, desired: 1_000_000 } })
      await flush()
      expect(settings.values.proactiveCompactionThreshold).toBe(1_000_000)
      expect(modal.settingsView().kind).toBe("list")
      expect(valueOf(modal, "proactive-compaction-threshold")).toBe("1M")
      dispose()
    })
  })

  it("shows and edits a provider module's numeric setting from its declaration", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      expect(valueOf(modal, COPILOT_CAP_ROW_ID)).toBe("3,900")
      activate(modal, COPILOT_CAP_ROW_ID)
      for (let index = 0; index < 5; index++) modals.input({ name: "backspace" })
      modals.paste("4100")
      modals.input({ name: "return" })

      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", target: { kind: "profile", profileId: "default" }, setting: { id: "provider", providerId: "github_copilot", key: "monthly_credit_cap", expected: { kind: "value", value: 3900 }, desired: 4100 } })
      expect(settings.profileProviderSetting("default", COPILOT_CAP)).toBe(4100)
      dispose()
    })
  })

  it("reads the declared off value as None and refuses a value outside the declared bounds", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, configDispatch } = createModal({ initialCopilotMonthlyCreditCap: 0 })
      modal.openSettingsModal()
      expect(valueOf(modal, COPILOT_CAP_ROW_ID)).toBe("None")
      activate(modal, COPILOT_CAP_ROW_ID)
      modals.paste("2000000")
      modals.input({ name: "return" })
      expect(configDispatch).not.toHaveBeenCalled()
      expect(modal.settingsView().kind).toBe("edit")
      dispose()
    })
  })

  it("hides a provider setting while its module is off", () => {
    createRoot((dispose) => {
      const { modal } = createModal({ runtime: moduleRuntime({ capabilities: MODULE_IDS.filter((id) => id !== "provider-github-copilot") }) })
      modal.openSettingsModal()
      expect(() => rowOf(modal, COPILOT_CAP_ROW_ID)).toThrow("Missing settings row")
      dispose()
    })
  })

  it("reads the setting of the profile in force after a profile switch", () => {
    createRoot((dispose) => {
      const { modal, publishAuth } = createModal({ initialCopilotMonthlyCreditCap: 12, siblingCopilotMonthlyCreditCap: 88 })
      modal.openSettingsModal()
      expect(valueOf(modal, COPILOT_CAP_ROW_ID)).toBe("12")
      publishAuth({ providers: [], warnings: [], profile: { id: "work", displayName: "Work", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work" }] }, subscriptionSpendConsent: { kind: "available", profileId: "work", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] } })
      expect(valueOf(modal, COPILOT_CAP_ROW_ID)).toBe("88")
      dispose()
    })
  })

  it("groups typed proactive compaction threshold digits while keeping the draft numeric", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      activate(modal, "proactive-compaction-threshold")
      for (const digit of "1000000") modals.input({ name: digit, raw: digit })
      const draftedEditView = modal.settingsView()
      if (draftedEditView.kind === "edit") expect(draftedEditView.presentation.value).toBe("1,000,000")
      modals.input({ name: "return" })

      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "proactiveCompactionThreshold", expected: { kind: "value", value: 270_000 }, desired: 1_000_000 } })
      expect(settings.values.proactiveCompactionThreshold).toBe(1_000_000)
      dispose()
    })
  })

  it("rejects abbreviated proactive compaction threshold entries", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      activate(modal, "proactive-compaction-threshold")
      modals.paste("300k")
      modals.input({ name: "return" })

      expect(configDispatch).not.toHaveBeenCalled()
      expect(settings.values.proactiveCompactionThreshold).toBe(270_000)
      expect(modal.settingsView().kind).toBe("edit")
      dispose()
    })
  })

  it("rejects proactive compaction thresholds below the safe floor", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      activate(modal, "proactive-compaction-threshold")
      modals.paste("40000")
      modals.input({ name: "return" })

      expect(configDispatch).not.toHaveBeenCalled()
      expect(settings.values.proactiveCompactionThreshold).toBe(270_000)
      expect(modal.settingsView().kind).toBe("edit")
      dispose()
    })
  })

  it("accepts 0 to disable proactive compaction and renders the value as None", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      activate(modal, "proactive-compaction-threshold")
      modals.paste("0")
      modals.input({ name: "return" })

      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "proactiveCompactionThreshold", expected: { kind: "value", value: 270_000 }, desired: 0 } })
      expect(settings.values.proactiveCompactionThreshold).toBe(0)
      expect(valueOf(modal, "proactive-compaction-threshold")).toBe("None")
      dispose()
    })
  })

  it("keeps settings open under the picker and navigation rows", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, openThemeModal, openAuthModal, openModelsModal, openSessionsModal } = createModal()

      modal.openSettingsModal()
      activate(modal, "theme")
      // Tree children push above the settings entry; the row callback itself
      // leaves this stack untouched.
      expect(modals.stack.length).toBe(1)
      expect(openThemeModal).toHaveBeenCalledTimes(1)

      activate(modal, "authentication")
      expect(openAuthModal).toHaveBeenCalledTimes(1)

      activate(modal, "models")
      expect(openModelsModal).toHaveBeenCalledTimes(1)

      activate(modal, "sessions")
      expect(openSessionsModal).toHaveBeenCalledTimes(1)
      dispose()
    })
  })


  it("names the active environment profile on the Git AI attribution row", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal({ authView: {
        providers: [], warnings: [],
        profile: { id: "work", displayName: "Work", source: "environment", availableProfiles: [{ id: "work", displayName: "Work" }] },
        subscriptionSpendConsent: { kind: "available", profileId: "work", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
      } })
      const row = rowOf(modal, "git-ai-attribution")

      expect(row.kind).toBe("cycle")
      expect(row.kind === "cycle" ? row.value() : "").toBe("Off · Work (environment)")
      dispose()
    })
  })
})
