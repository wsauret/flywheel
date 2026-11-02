import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { activate, clearMocks, createModal, flush, moduleRuntime, rowOf, valueOf } from "../../modals/_settings-modal-fixtures.js"

describe("Usage module settings", () => {
  it("edits and validates subscription usage alert thresholds", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, modals, settings, configDispatch } = createModal()
      modal.openSettingsModal()

      expect(rowOf(modal, "subscription-usage:subscription_usage:alert_thresholds")).toMatchObject({ kind: "edit", label: "Usage alert thresholds" })
      expect(valueOf(modal, "subscription-usage:subscription_usage:alert_thresholds")).toBe("Off")
      activate(modal, "subscription-usage:subscription_usage:alert_thresholds")
      expect(modal.settingsView()).toMatchObject({ kind: "edit", hint: "Increasing whole numbers from 1 to 100, comma separated. Empty turns this off." })
      modals.paste("70, 90, 100")
      expect(configDispatch).not.toHaveBeenCalled()
      modals.input({ name: "escape" })
      await flush()
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "module", section: "subscription_usage", key: "alert_thresholds", expected: { kind: "value", value: [] }, desired: [70, 90, 100] } })
      const publication = settings.publication()
      expect(publication.kind === "ready" ? publication.view.values.moduleSections.subscription_usage?.alert_thresholds : undefined).toEqual([70, 90, 100])
      expect(valueOf(modal, "subscription-usage:subscription_usage:alert_thresholds")).toBe("70%, 90%, 100%")

      for (const [input, error] of [
        ["70, 70", "Use increasing whole numbers from 1 to 100."],
        ["90, 70", "Use increasing whole numbers from 1 to 100."],
        ["0, 90", "Use increasing whole numbers from 1 to 100."],
        ["70.5, 90", "Use increasing whole numbers from 1 to 100."],
        ["101", "Use increasing whole numbers from 1 to 100."],
        ["70%, 90", "Use increasing whole numbers from 1 to 100."],
      ] as const) {
        activate(modal, "subscription-usage:subscription_usage:alert_thresholds")
        modals.paste(input)
        modals.input({ name: "return" })
        await flush()
        expect(modal.settingsView()).toMatchObject({ kind: "edit", error })
        modals.input({ name: "tab" })
      }

      activate(modal, "subscription-usage:subscription_usage:alert_thresholds")
      modals.input({ name: "backspace" })
      modals.input({ name: "return" })
      await flush()
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "module", section: "subscription_usage", key: "alert_thresholds", expected: { kind: "value", value: [70, 90, 100] }, desired: [] } })
      expect(valueOf(modal, "subscription-usage:subscription_usage:alert_thresholds")).toBe("Off")
      dispose()
    })
  })

  it("removes the threshold editor when Usage is off", () => {
    createRoot((dispose) => {
      const { modal } = createModal({ runtime: moduleRuntime({ capabilities: [] }) })
      modal.openSettingsModal()
      const group = rowOf(modal, "capability-group:Model & spend")
      expect(group.kind).toBe("disclosure")
      if (group.kind === "disclosure") expect(group.rows().some((row) => row.kind !== "separator" && row.id === "subscription-usage:subscription_usage:alert_thresholds")).toBe(false)
      dispose()
    })
  })
})
