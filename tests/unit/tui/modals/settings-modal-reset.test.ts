import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { activate, clearMocks, createModal, flush, installBundledFont, moduleRuntime } from "./_settings-modal-fixtures.js"

describe("useSettingsModal reset", () => {
  it("defaults reset confirmation to Cancel and switches with left, right, and tab", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openSettingsModal()
      activate(modal, "reset-defaults")

      expect(modal.settingsView()).toMatchObject({ kind: "confirmation", choice: "cancel" })
      for (const key of ["left", "right", "tab"]) {
        modals.input({ name: key })
        expect(modal.settingsView()).toMatchObject({
          kind: "confirmation",
          choice: key === "right" ? "cancel" : "confirm",
        })
      }
      dispose()
    })
  })

  it("leaves reset confirmation without writes on Cancel or Escape", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, runtime, setUpdateAutoInstall, configDispatch } = createModal()
      modal.openSettingsModal()
      activate(modal, "reset-defaults")
      // Enter on the default Cancel choice returns to the list.
      modals.input({ name: "enter" })
      expect(modal.settingsView().kind).toBe("list")

      // Escape from the confirmation closes the whole modal without writes.
      activate(modal, "reset-defaults")
      modals.input({ name: "escape" })
      expect(modals.stack.length).toBe(0)
      expect(configDispatch).not.toHaveBeenCalled()
      expect(runtime.capabilities.setModules).not.toHaveBeenCalled()
      expect(runtime.capabilities.setPersistentProcesses).not.toHaveBeenCalled()
      expect(setUpdateAutoInstall).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("dispatches one common reset and retains the TUI runtime-policy reset scope", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, runtime, setUpdateAutoInstall, openAuthModal, openModelsModal, configDispatch, showToast } = createModal({
        initialProactiveCompactionThreshold: 500_000,
        initialCopilotMonthlyCreditCap: 12,
        siblingCopilotMonthlyCreditCap: 88,
        // The cap row exists only while its provider module is effective.
        runtime: moduleRuntime({ capabilities: ["provider-github-copilot"], persistentProcesses: { persisted: true, effective: true, forcedByCli: false } }),
        initialUpdateAutoInstall: false,
      })
      const descriptorIdentity = runtime.capabilities.view()?.descriptorIdentity
      modal.openSettingsModal()
      activate(modal, "reset-defaults")
      modals.input({ name: "left" })
      modals.input({ name: "enter" })
      await flush()

      expect(configDispatch).toHaveBeenCalledTimes(1)
      expect(configDispatch).toHaveBeenCalledWith({ type: "config.reset", profileId: "default" })
      expect(runtime.capabilities.setModules).toHaveBeenCalledTimes(1)
      expect(runtime.capabilities.setModules).toHaveBeenCalledWith("full", { moduleIds: ["provider-github-copilot"], requireWorkflowConfirmation: true, descriptorIdentity })
      expect(runtime.capabilities.setPersistentProcesses).toHaveBeenCalledWith(true, false)
      expect(setUpdateAutoInstall).toHaveBeenCalledWith(false, true)
      expect(showToast).toHaveBeenCalledWith({ message: "Settings reset to defaults", variant: "success" })
      expect(openAuthModal).not.toHaveBeenCalled()
      expect(openModelsModal).not.toHaveBeenCalled()
      expect(installBundledFont).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("does not publish or dispatch when the local reset commit fails", async () => {
    clearMocks()
    const runtimeFailure = { kind: "write-not-applied", message: "The configuration could not be saved." } as const
    await createRoot(async (dispose) => {
      const { modal, modals, settings, runtime, setUpdateAutoInstall, showToast, configDispatch } = createModal({ initialProactiveCompactionThreshold: 500_000 })
      configDispatch.mockResolvedValueOnce(runtimeFailure)
      modal.openSettingsModal()
      activate(modal, "reset-defaults")
      modals.input({ name: "left" })
      modals.input({ name: "enter" })
      await flush()

      expect(settings.values.proactiveCompactionThreshold).toBe(500_000)
      expect(runtime.capabilities.setModules).not.toHaveBeenCalled()
      expect(runtime.capabilities.setPersistentProcesses).not.toHaveBeenCalled()
      expect(setUpdateAutoInstall).not.toHaveBeenCalled()
      expect(showToast).toHaveBeenCalledWith({ message: "Reset failed: The configuration could not be saved.", variant: "error" })
      dispose()
    })
  })

  for (const failure of ["result", "rejection"] as const) {
    it(`refreshes and reports a runtime ${failure} failure`, async () => {
      clearMocks()
      await createRoot(async (dispose) => {
        const runtime = moduleRuntime({ capabilities: [] })
        if (failure === "result") runtime.capabilities.setModules.mockResolvedValueOnce({ ok: false, error: { message: "runtime refused" } })
        else runtime.capabilities.setModules.mockRejectedValueOnce(new Error("runtime rejected"))
        const { modal, modals, showToast } = createModal({
          runtime,
          initialUpdateAutoInstall: false,
        })
        modal.openSettingsModal()
        activate(modal, "reset-defaults")
        modals.input({ name: "left" })
        modals.input({ name: "enter" })
        await flush()

        expect(showToast).toHaveBeenCalledWith({
          message: `Reset partially completed: runtime ${failure === "result" ? "refused" : "rejected"}`,
          variant: "error",
        })
        dispose()
      })
    })
  }
})
