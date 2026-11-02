import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { IN_PLACE_SETTING_ROWS, SETTING_ROWS, shownOn } from "../../../../src/protocol/setting-catalog.js"
import type { SettingsRow } from "../../../../src/tui/hooks/settings-modal-types.js"
import { activate, clearMocks, configValues, createModal, indexOf, rowIds, rowOf } from "./_settings-modal-fixtures.js"

describe("useSettingsModal", () => {
  it("navigates with arrow keys and skips separators", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals } = createModal()
      modal.openSettingsModal()

      for (let movement = 0; movement < 40 && modal.settingsModalCursor() !== indexOf(modal, "workflow-mode"); movement++) modals.input({ name: "down" })
      expect(modal.settingsModalCursor()).toBe(indexOf(modal, "workflow-mode"))

      modals.input({ name: "up" })
      expect(modal.settingsModalCursor()).toBe(indexOf(modal, "capability-preset"))
      dispose()
    })
  })

  it("groups a compact root by user task and describes every setting", () => {
    clearMocks()
    createRoot((dispose) => {
      const remote = { kind: "surface", id: "remote" } as const
      const { modal, activateModuleRow } = createModal({ moduleRows: [{ id: "remote", label: "Remote access", value: "off", hint: "Pair devices and manage access to this machine", action: remote }] })
      modal.openSettingsModal()

      const sections = new Map<string, string[]>()
      let current = ""
      for (const row of modal.settingsItems()) {
        if (row.kind === "separator") {
          current = row.label ?? ""
          continue
        }
        sections.set(current, [...(sections.get(current) ?? []), row.id])
        expect(row.description).toBeTruthy()
      }
      expect([...sections.keys()]).toEqual(["Session", "Models and auth", "Application", "Autonomy", "Manage"])
      expect(sections.get("Session")).toEqual(["auth-profile", "project-profile", "show-build", "git-ai-attribution"])
      expect(sections.get("Models and auth")).toEqual(["models", "authentication", "auth-profiles", "allow-training-routes", "provider-setting:github_copilot:monthly_credit_cap"])
      expect(sections.get("Autonomy")).toEqual(["capability-preset", "workflow-mode", "capability-group:Agent capabilities", "capability-group:Tools", "capability-group:Web retrieval", "capability-group:Model providers", "capability-group:Model & spend", "capability-group:Interface", "capability-group:Remote"])
      // A module's own row sits at the catalog's client-modules slot and runs the module's action.
      expect(sections.get("Application")).toEqual(["status", "module:remote", "appearance", "maintenance"])
      expect(rowOf(modal, "module:remote")).toMatchObject({ kind: "navigation", label: "Remote access" })
      activate(modal, "module:remote")
      expect(activateModuleRow).toHaveBeenCalledWith(remote)
      expect(sections.get("Manage")).toEqual(["sessions", "reset-defaults"])

      expect(rowOf(modal, "appearance")).toMatchObject({ kind: "disclosure", label: "Appearance" })
      expect(rowOf(modal, "maintenance")).toMatchObject({ kind: "disclosure", label: "Maintenance" })
      expect(rowOf(modal, "font")).toMatchObject({ kind: "action" })
      expect(rowOf(modal, "auto-install")).toMatchObject({ kind: "cycle" })
      expect(rowOf(modal, "allow-persistent-processes")).toMatchObject({ kind: "cycle" })
      dispose()
    })
  })

  it("shows every catalog row the terminal shows, by its catalog name and in catalog order", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openSettingsModal()
      const labels = (rows: readonly SettingsRow[]): readonly string[] => rows.flatMap((row) =>
        row.kind === "disclosure" || row.kind === "group" ? [row.label, ...labels(row.rows())] : row.kind === "separator" ? [] : [row.label])
      const shown = labels(modal.settingsItems())
      const catalog: readonly string[] = SETTING_ROWS.filter((row) => shownOn(row, "terminal")).map((row) => row.label)

      expect(shown.filter((label) => catalog.includes(label))).toEqual([...catalog])
      for (const browserOnly of SETTING_ROWS.filter((row) => !shownOn(row, "terminal"))) expect(shown).not.toContain(browserOnly.label)
      // A row the catalog changes in place edits its value in the list; it opens no other surface.
      for (const row of IN_PLACE_SETTING_ROWS.filter((entry) => shownOn(entry, "terminal"))) expect(["cycle", "single-select", "edit"].includes(rowOf(modal, row.id).kind)).toBe(true)
      dispose()
    })
  })

  it("expands Application settings inline without leaving the root list", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal()
      modal.openSettingsModal()

      activate(modal, "appearance")
      const appearanceView = modal.settingsView()
      expect(appearanceView).toMatchObject({ kind: "list", presentation: { value: "" } })
      if (appearanceView.kind !== "list") throw new Error("Expected settings list")
      expect(appearanceView.label).toBeUndefined()
      const appearanceIds = appearanceView.rows?.flatMap((row) => row.kind === "separator" ? [] : [row.id]) ?? []
      expect(appearanceIds.indexOf("appearance")).toBeLessThan(appearanceIds.indexOf("theme"))
      expect(appearanceIds.indexOf("theme")).toBeLessThan(appearanceIds.indexOf("maintenance"))

      activate(modal, "appearance")
      const collapsedView = modal.settingsView()
      if (collapsedView.kind !== "list") throw new Error("Expected settings list")
      expect(collapsedView.rows?.some((row) => row.kind !== "separator" && row.id === "theme")).toBe(false)

      activate(modal, "maintenance")
      const maintenanceView = modal.settingsView()
      if (maintenanceView.kind !== "list") throw new Error("Expected settings list")
      expect(maintenanceView.label).toBeUndefined()
      expect(maintenanceView.rows?.some((row) => row.kind !== "separator" && row.id === "auto-install")).toBe(true)
      expect(maintenanceView.rows?.some((row) => row.kind !== "separator" && row.id === "theme")).toBe(false)
      dispose()
    })
  })
  it("annotates a known invalid setting on its existing row", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, publishConfig } = createModal()
      modal.openSettingsModal()
      publishConfig({
        revision: 2,
        values: configValues(),
        status: { kind: "malformed", fallback: "last-valid", message: "The configuration is malformed. The last valid values remain active." },
        warnings: [],
        diagnostics: [{ kind: "setting", settingId: "showThinking", reason: "invalid-value" }],
      })

      expect(rowOf(modal, "show-thinking")).toMatchObject({ label: "Show thinking", warning: "This value is invalid, so Flywheel kept the last valid file.", description: "Show the model's thinking as text in the transcript." })
      expect(rowIds(modal).filter((id) => id === "show-thinking")).toHaveLength(1)
      expect(modal.settingsItems()[0]).toEqual({ kind: "separator", label: "Session" })
      expect(rowOf(modal, "appearance")).toMatchObject({ label: "Appearance", warning: "A setting in this group has a configuration problem." })
      dispose()
    })
  })

  it("does not turn unrepresented config problems into Settings rows", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal({ configDiagnostics: [] })
      modal.openSettingsModal()

      expect(modal.settingsItems()[0]).toEqual({ kind: "separator", label: "Session" })
      expect(modal.settingsItems().some((row) => row.kind !== "separator" && row.warning !== undefined)).toBe(false)
      dispose()
    })
  })
})


