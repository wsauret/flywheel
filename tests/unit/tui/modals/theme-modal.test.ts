import { describe, expect, it, mock } from "bun:test"
import { createEffect, createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { createSettingsTree } from "../../../../src/tui/hooks/settings-tree.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import { configValues } from "./_settings-modal-fixtures.js"

const { RENAMED_THEME_IDS, ThemeProvider, useTheme } = await import("../../../../src/tui/context/theme.js")
const configDispatch = mock(async () => ({ kind: "committed", revision: 2 } as const))
const { useThemeModal } = await import("../../../../src/tui/hooks/use-theme-modal.js")
type ThemeModal = ReturnType<typeof useThemeModal>

async function mountedThemeModal(run: (harness: {
  modals: ReturnType<typeof createModalStack>
  modal: ThemeModal
  showToast: ReturnType<typeof mock>
  themeName: () => string
  publishTheme: (theme: string) => void
}) => void | Promise<void>, authoredTheme: string | null = "flywheel"): Promise<void> {
  const modals = createModalStack()
  const showToast = mock(() => {})
  const [config, setConfig] = createSignal({ revision: 1, values: { ...configValues(), theme: authoredTheme ?? undefined }, status: { kind: "valid" } as const, warnings: [], diagnostics: [] })
  let modal!: ThemeModal
  let themeName!: () => string
  const result = await testRender(() => {
    const settingsTree = createSettingsTree(modals)
    settingsTree.bindRoot({ open: () => { modals.replace("settings") }, isOpen: () => modals.stack[0]?.element === "settings" })
    function Harness() {
      const themeCtx = useTheme()
      modal = useThemeModal({
        config: {
          view: config,
          settlePublication: (command, revision) => new Promise((resolve) => {
            createEffect(() => {
              const view = config()
              if (command.type !== "config.mutate" || command.setting.id !== "theme") return
              if (view.revision >= revision && view.values.theme === command.setting.desired) resolve(true)
            })
          }),
        },
        appService: { dispatch: runtimeDispatch({ "config.mutate": configDispatch }) },
        modal: settingsTree.childModal,
        renderModal: () => "mock-theme-modal",
        showToast,
      })
      themeName = () => themeCtx.themeName
      return null
    }
    return createComponent(ThemeProvider, { mode: "dark", themeName: "flywheel", config, get children() { return createComponent(Harness, {}) } })
  }, { width: 20, height: 3 })
  try {
    await run({
      modals, modal, showToast, themeName,
      publishTheme: (theme) => setConfig({ ...config(), revision: config().revision + 1, values: { ...config().values, theme } }),
    })
  } finally {
    result.renderer.destroy()
    await result.renderer.closed
  }
}

function themeRowIndex(modal: ThemeModal, themeName: string): number {
  const row = modal.themeModalResult().rows.find((candidate) => candidate.kind === "option" && candidate.option.value === themeName)
  if (row?.kind !== "option") throw new Error(`Theme row not found: ${themeName}`)
  return row.rowIndex
}

describe("useThemeModal", () => {
  it("persists a highlight move and never reverts it on close", async () => {
    configDispatch.mockClear()
    await mountedThemeModal(async ({ modals, modal, showToast, themeName, publishTheme }) => {
      modal.openThemeModal()
      modals.input({ name: "down" })
      const selected = modal.themeModalResult().rows[modal.themeModalCursor()]
      if (selected?.kind !== "option") throw new Error("Expected theme option")
      const name = selected.option.value
      await Promise.resolve()
      expect(configDispatch).toHaveBeenCalledWith({ type: "config.mutate", setting: { id: "theme", expected: { kind: "value", value: "flywheel" }, desired: name } })
      expect(themeName()).toBe("flywheel")
      expect(modals.stack).toHaveLength(2)
      modals.clear()
      publishTheme(name)
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
      expect(themeName()).toBe(name)
      expect(modals.stack.length).toBe(0)
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }))
      publishTheme("flywheel")
      expect(themeName()).toBe("flywheel")
    })
  })

  it("reads a theme id saved before the 2026-10-27 rename as its renamed theme", async () => {
    for (const [savedId, renamedId] of RENAMED_THEME_IDS) {
      await mountedThemeModal(async ({ modal, themeName }) => {
        expect(themeName()).toBe(renamedId)
        modal.openThemeModal()
        expect(modal.themeModalCursor()).toBe(themeRowIndex(modal, renamedId))
      }, savedId)
    }
  })

  it("creates an absent-value mutation for an unauthored theme", async () => {
    configDispatch.mockClear()
    await mountedThemeModal(async ({ modal, publishTheme }) => {
      modal.openThemeModal()
      modal.selectThemeRow(themeRowIndex(modal, "twilight"))
      await Promise.resolve()
      expect(configDispatch).toHaveBeenCalledWith({ type: "config.mutate", setting: { id: "theme", expected: { kind: "absent" }, desired: "twilight" } })
      publishTheme("twilight")
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
    }, null)
  })

  it("coalesces repeated moves to one latest write while publication settles", async () => {
    configDispatch.mockClear()
    await mountedThemeModal(async ({ modals, modal, publishTheme }) => {
      modal.openThemeModal()
      modals.input({ name: "down" })
      modals.input({ name: "down" })
      modals.input({ name: "down" })
      expect(configDispatch).toHaveBeenCalledTimes(1)
      const selected = modal.themeModalResult().rows[modal.themeModalCursor()]
      if (selected?.kind !== "option") throw new Error("Expected theme option")
      publishTheme("twilight")
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(configDispatch).toHaveBeenCalledTimes(2)
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "theme", expected: { kind: "value", value: "twilight" }, desired: selected.option.value } })
      modals.clear()
      publishTheme(selected.option.value)
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(modal.saving()).toBe(false)
    })
  })
  it("reports a write failure after closing and returns to the saved theme", async () => {
    configDispatch.mockRejectedValueOnce(new Error("disk unavailable"))
    await mountedThemeModal(async ({ modals, modal, showToast, themeName }) => {
      modal.openThemeModal()
      modals.input({ name: "down" })
      modals.clear()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(themeName()).toBe("flywheel")
      expect(modal.themeModalCursor()).toBe(themeRowIndex(modal, "flywheel"))
      expect(showToast).toHaveBeenCalledWith({ message: "Theme selection failed: disk unavailable", variant: "error" })
    })
  })
})