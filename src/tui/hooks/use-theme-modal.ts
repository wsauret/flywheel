import { THEME_NAMES, useTheme } from "@tui/context/theme"
import { createMemo, createSignal, type Accessor, type JSX } from "solid-js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import { filterOptions, flattenWithCategories } from "../components/modal-select-helpers.js"
import type { ModalSelectOption, FilteredResult } from "../components/modal-select-types.js"
import type { ModalContext, ModalHandle } from "../components/modal-stack.js"
import { mutateRuntimeConfig, type RuntimeConfigCache, type ShellServices } from "./shell-state.js"
import { errorMessage } from "../../infra/error-message.js"

interface ThemeModalDeps {
  config: RuntimeConfigCache
  appService: Pick<RuntimeClient, "dispatch">
  modal: ModalContext
  renderModal: () => JSX.Element
  showToast: ShellServices["showToast"]
}

export interface ThemeModalHook {
  themeModalResult: Accessor<FilteredResult<string>>
  themeModalCursor: Accessor<number>
  saving: Accessor<boolean>
  /** The theme in effect now. Settings shows it as the Theme row's value. */
  currentThemeName: Accessor<string>
  openThemeModal: () => void
  selectThemeRow: (rowIndex: number) => void
}

export function useThemeModal(deps: ThemeModalDeps): ThemeModalHook {
  const themeCtx = useTheme()
  const [cursor, setCursor] = createSignal(0)
  const [saving, setSaving] = createSignal(false)

  const options = createMemo<ModalSelectOption<string>[]>(() =>
    THEME_NAMES.map((name) => ({ id: name, title: name, value: name })),
  )

  const currentResult = createMemo<FilteredResult<string>>(() => {
    return flattenWithCategories(filterOptions(options(), ""), false)
  })

  let entry: ModalHandle | undefined
  let pendingName: string | undefined

  function close(): void {
    entry?.close()
  }

  function openThemeModal(): void {
    const current = themeCtx.themeName
    setCursor(currentResult().rows.find((row) => row.kind === "option" && row.option.value === current)?.rowIndex ?? 0)
    entry = deps.modal.replace(deps.renderModal, {
      onKey: handleKey,
      route: { kind: "theme" },
    })
  }

  function changeTheme(rowIndex: number): void {
    const row = currentResult().rows[rowIndex]
    if (row?.kind !== "option") return
    setCursor(rowIndex)
    pendingName = row.option.value
    if (!saving()) void persistThemeSelection()
  }

  function selectThemeRow(rowIndex: number): void {
    const row = currentResult().rows[rowIndex]
    if (row?.kind !== "option") return
    changeTheme(rowIndex)
    deps.modal.clear()
  }

  async function persistThemeSelection(): Promise<void> {
    setSaving(true)
    while (pendingName !== undefined) {
      const selectedName = pendingName
      pendingName = undefined
      try {
        const config = deps.config.view()
        if (config === undefined) throw new Error("Configuration is still loading")
        const expected = config.values.theme
        if (selectedName === expected) continue
        const result = await mutateRuntimeConfig(deps.config, deps.appService, {
          type: "config.mutate",
          setting: { id: "theme", expected: expected === undefined ? { kind: "absent" } : { kind: "value", value: expected }, desired: selectedName },
        })
        if (result.kind !== "committed" && result.kind !== "committed-with-durability-warning" && result.kind !== "committed-with-degraded-application") throw new Error(result.message)
        if (result.kind === "committed-with-durability-warning") deps.showToast({ message: result.warning, variant: "warning" })
        else if (result.kind === "committed-with-degraded-application") deps.showToast({ message: result.durabilityWarning === undefined ? "Theme saved, but it was not applied by every runtime component." : `Theme was not applied by every runtime component. ${result.durabilityWarning}`, variant: "warning" })
      } catch (error) {
        deps.showToast({ message: `Theme selection failed: ${errorMessage(error)}`, variant: "error" })
        if (pendingName === undefined) setCursor(currentResult().rows.find((row) => row.kind === "option" && row.option.value === themeCtx.themeName)?.rowIndex ?? 0)
      }
    }
    setSaving(false)
  }

  const handleKey = createListModalKeys({
    rows: () => currentResult().rows,
    cursor,
    setCursor: changeTheme,
    onSelect: selectThemeRow,
    onClose: () => deps.modal.clear(),
    extra: (evt) => {
      if (evt.name.toLowerCase() !== "left") return false
      evt.preventDefault?.()
      close()
      return true
    },
  })

  return {
    themeModalResult: currentResult,
    themeModalCursor: cursor,
    saving,
    currentThemeName: () => themeCtx.themeName,
    openThemeModal,
    selectThemeRow,
  }
}
