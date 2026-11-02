import type { Accessor, JSX } from "solid-js"
import { createSignal } from "solid-js"
import type { CommandPaletteState } from "../modals/command-palette-types.js"
import { commandsToOptions } from "../commands/command-catalog.js"
import type { CommandSpec } from "../commands/command-types.js"
import { createControlledTextEditor, SINGLE_LINE_TEXT_ENTRY_POLICY } from "../keymap/text-entry.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import { filterOptions, firstSelectableRow, flattenWithCategories } from "../components/modal-select-helpers.js"
import type { ModalContext } from "../components/modal-stack.js"

interface CommandPaletteDeps {
  modal: ModalContext
  renderModal: () => JSX.Element
  /** Built-in catalog, republished when capability contributions change. */
  commands: Accessor<readonly CommandSpec[]>
  onActivate: (slashText: string) => void
}

export interface CommandPaletteHook {
  commandPaletteState: () => CommandPaletteState
  openCommandPalette: () => void
  handleRowClick: (rowIndex: number) => void
}

export function useCommandPalette(deps: CommandPaletteDeps): CommandPaletteHook {
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const editor = createControlledTextEditor({
    value: query,
    setValue: (value) => { setQuery(value); setCursor(firstSelectableRow(currentResult().rows)) },
    policy: SINGLE_LINE_TEXT_ENTRY_POLICY,
  })

  // Not a createMemo: SolidJS server-mode memos evaluate once and never re-run, breaking tests.
  function options() {
    return commandsToOptions(deps.commands())
  }

  // Not a createMemo: SolidJS server-mode memos evaluate once and never re-run, breaking tests.
  function currentResult() {
    return flattenWithCategories(filterOptions(options(), query()), false)
  }

  function commandPaletteState(): CommandPaletteState {
    return { presentation: editor.presentation(), cursor: cursor(), result: currentResult() }
  }

  function reset(): void {
    setQuery("")
    setCursor(0)
    editor.resetEphemeralState({ cursor: 0 })
  }

  function close(): void {
    reset()
    deps.modal.clear()
  }

  function openCommandPalette(): void {
    reset()
    setCursor(firstSelectableRow(currentResult().rows))
    deps.modal.replace(deps.renderModal, { onKey: handleKey, onPaste: handlePaste, onClose: reset })
  }

  function activateRow(rowIndex: number): void {
    const row = currentResult().rows[rowIndex]
    if (!row || row.kind !== "option") return
    if (row.option.disabled) return
    close()
    deps.onActivate(row.option.value)
  }

  const handleKey = createListModalKeys({
    rows: () => currentResult().rows,
    cursor,
    setCursor,
    onSelect: activateRow,
    onClose: close,
    textInput: (evt) => { editor.handleKey(evt) },
  })

  function handlePaste(text: string): void { editor.handlePaste(text) }

  return {
    commandPaletteState,
    openCommandPalette,
    handleRowClick: activateRow,
  }
}
