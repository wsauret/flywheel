import { type Accessor, createMemo, createSignal, type JSX, untrack } from "solid-js"
import { createTerminalSettingEdit } from "./terminal-setting-edit.js"
import { createListModalKeys, type ListModalKeyEvent } from "../components/modal-list-keys.js"
import { createModalDisclosureState, flattenModalDisclosureTree, modalDisclosureAction } from "../components/modal-disclosure.js"
import { disclosureIds, findSettingsRow, rankedSettingsNodes, settingsRowDirectMatchScore, settingsVisibleRows } from "./settings-row-tree.js"
import { filterOptions, firstSelectableRow, flattenWithCategories } from "../components/modal-select-helpers.js"
import type { ModalSelectOption, FilteredResult, FlatRow } from "../components/modal-select-types.js"
import type { ModalContext, ModalHandle } from "../components/modal-stack.js"
import { refusalReason, type SettingsEditSpec, type SettingsInteractiveRow, type SettingsRow, type SettingsSelectionConfirmation, type SettingsView, type SettingsVisibleRow } from "./settings-modal-types.js"
import { createControlledTextEditor, normalizedPrintableText, SINGLE_LINE_TEXT_ENTRY_POLICY, type ControlledTextEditor, type TextEditorPresentation } from "../keymap/text-entry.js"

interface SettingsModalControllerDeps {
  /** The domain rows. The controller reads them; it never copies a value out
   *  of one, so every displayed value stays owned by its setting. */
  rows: Accessor<readonly SettingsRow[]>
  modal: ModalContext
  renderModal: () => JSX.Element
  /** True while a pending durable write owns the modal. Keys and activations
   *  are ignored until it settles. */
  blocked: Accessor<boolean>
  onError?: (message: string) => void
}

export interface SettingsModalController {
  view: Accessor<SettingsView>
  cursor: Accessor<number>
  open: () => void
  close: () => void
  finishEdit: () => void
  /** Activates the row at this list index, after moving the cursor to it. */
  activateRow: (index: number) => void
  /** Toggles the multiselect option at this subview row index. */
  toggleOption: (rowIndex: number) => void
  /** Selects the single-select option at this subview row index. */
  selectOption: (rowIndex: number) => void
  /** Opens the shared editor for a choice-specific action. */
  editChoice: (optionId: string, label: string, edit: SettingsEditSpec) => void
  /** Opens a confirmation for a choice-specific destructive action. */
  confirmAction: (label: string, message: string, actionLabel: string, onConfirm: () => void) => void
  confirmSelection: (details: () => SettingsSelectionConfirmation, select: (id: string) => void, submit: () => Promise<boolean>) => void
  /** The modal entry this modal is open as, for callers whose asynchronous
   *  settlement must report only into the instance that started it. */
  handle: () => ModalHandle | undefined
}

type ActiveView =
  | { kind: "list" }
  | { kind: "edit-row"; rowId: string }
  | { kind: "edit-action"; rowId: string; optionId: string }
  | { kind: "multiselect"; rowId: string }
  | { kind: "single-select"; rowId: string }
  | { kind: "confirmation"; rowId?: string; label?: string; message?: string; actionLabel?: string; onConfirm?: () => void; details?: () => SettingsSelectionConfirmation; select?: (id: string) => void }
  | { kind: "edit-choice"; rowId: string; label: string; edit: SettingsEditSpec }

const EMPTY_RESULT: FilteredResult<string> = { rows: [], totalMatches: 0, capped: false }

function formattedDraftOffset(raw: string, formatted: string, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= raw.length) return formatted.length
  let searchFrom = 0
  for (let rawIndex = 0; rawIndex <= offset; rawIndex += 1) {
    const formattedIndex = formatted.indexOf(raw[rawIndex] ?? "", searchFrom)
    if (formattedIndex < 0) return Math.min(offset, formatted.length)
    if (rawIndex === offset) return formattedIndex
    searchFrom = formattedIndex + 1
  }
  return formatted.length
}

/** The generic Settings modal mechanics: one cursor over the row list, one
 *  active subview, one draft, one option filter. Row semantics live entirely
 *  in the row callbacks, so a new setting is a new row and never a new view. */
export function createSettingsModalController(deps: SettingsModalControllerDeps): SettingsModalController {
  const [cursor, setCursor] = createSignal(0)
  const [active, setActive] = createSignal<ActiveView>({ kind: "list" })
  const [listGroupId, setListGroupId] = createSignal<string | undefined>()
  const [listQuery, setListQuery] = createSignal("")
  const [expandedDisclosureIds, setExpandedDisclosureIds] = createSignal<readonly string[]>([])
  const disclosures = createModalDisclosureState({
    expandedIds: () => expandedDisclosureIds(),
    setExpandedIds: (ids) => setExpandedDisclosureIds(ids),
  })
  const [draft, setDraft] = createSignal("")
  const [draftError, setDraftError] = createSignal<string | undefined>()
  const [query, setQuery] = createSignal("")
  const [optionCursor, setOptionCursor] = createSignal(0)
  const [confirmationChoice, setConfirmationChoice] = createSignal<"confirm" | "cancel">("cancel")
  let entry: ModalHandle | undefined

  function rootRowById(id: string): SettingsInteractiveRow | undefined {
    return deps.rows().find((row): row is SettingsInteractiveRow => row.kind !== "separator" && row.id === id)
  }

  function visibleRowsFor(rows: readonly SettingsRow[]): readonly SettingsVisibleRow[] {
    const nodes = rankedSettingsNodes(rows, listQuery())
    const forced = listQuery().trim() === "" ? new Set<string>() : disclosureIds(nodes)
    return settingsVisibleRows(flattenModalDisclosureTree(nodes, new Set(disclosures.expandedIds()), forced))
  }

  function visibleRows(): readonly SettingsVisibleRow[] {
    const groupId = listGroupId()
    const group = groupId === undefined ? undefined : rootRowById(groupId)
    return visibleRowsFor(group?.kind === "group" ? group.rows() : deps.rows())
  }

  function rowById(id: string): SettingsInteractiveRow | undefined {
    return findSettingsRow(deps.rows(), id)
  }

  const editTarget = createMemo(() => {
    const current = active()
    if (current.kind === "edit-row") {
      const row = rowById(current.rowId)
      return row?.kind === "edit" ? { id: row.id, label: row.label, unavailableReason: row.unavailableReason, edit: row.edit } : undefined
    }
    if (current.kind === "edit-choice") return { id: current.rowId, label: current.label, edit: current.edit }
    if (current.kind !== "edit-action") return undefined
    const row = rowById(current.rowId)
    if (row?.kind !== "single-select") return undefined
    const option = row.options().find((candidate) => candidate.id === current.optionId)
    return option?.kind === "action" ? { id: row.id, label: option.label, unavailableReason: row.unavailableReason, edit: option.edit, action: true } : undefined
  })

  const multiselectRow = createMemo(() => {
    const current = active()
    if (current.kind !== "multiselect") return undefined
    const row = rowById(current.rowId)
    return row?.kind === "multiselect" ? row : undefined
  })

  const singleSelectRow = createMemo(() => {
    const current = active()
    if (current.kind !== "single-select") return undefined
    const row = rowById(current.rowId)
    return row?.kind === "single-select" ? row : undefined
  })

  const multiselectResult = createMemo<FilteredResult<string>>(() => {
    const row = multiselectRow()
    if (!row) return EMPTY_RESULT
    const options: ModalSelectOption<string>[] = row.options().map((option) => ({
      id: option.id,
      title: option.label,
      value: option.id,
      ...(option.description === undefined ? {} : { description: option.description }),
      ...(option.category === undefined ? {} : { category: option.category }),
    }))
    return flattenWithCategories(filterOptions(options, query()), true)
  })

  const singleSelectResult = createMemo<FilteredResult<string>>(() => {
    const row = singleSelectRow()
    if (!row) return EMPTY_RESULT
    const currentId = row.currentId()
    const options: ModalSelectOption<string>[] = row.options().map((option) => ({
      id: option.id,
      title: option.label,
      value: option.id,
      ...(option.description === undefined ? {} : { description: option.description }),
      ...(option.category === undefined ? {} : { category: option.category }),
      ...(option.kind === "action" ? { statusIcon: "+" } : option.id === currentId ? { rightDetail: "Active" } : {}),
    }))
    return flattenWithCategories(filterOptions(options, query()), true)
  })

  function interactionBlocked(): boolean {
    return deps.blocked()
  }
  function returnToList(): void {
    setActive({ kind: "list" })
  }

  function beginEdit(row: Extract<SettingsInteractiveRow, { kind: "edit" }>): void {
    beginEditTarget(row.edit)
    setActive({ kind: "edit-row", rowId: row.id })
  }

  function beginEditTarget(edit: Extract<SettingsInteractiveRow, { kind: "edit" }>["edit"]): void {
    setDraft(edit.initialDraft())
    completion.begin()
    draftEditor.resetEphemeralState()
    draftEditor.setSelection(0, draft().length)
  }

  function beginMultiselect(row: Extract<SettingsInteractiveRow, { kind: "multiselect" }>): void {
    resetOptionQuery()
    setActive({ kind: "multiselect", rowId: row.id })
    setOptionCursor(firstSelectableRow(multiselectResult().rows))
  }

  /** A picker opens on the option in force, as every list picker does, so a
   *  person sees their current choice before they move. */
  function beginSingleSelect(row: Extract<SettingsInteractiveRow, { kind: "single-select" }>): void {
    resetOptionQuery()
    setActive({ kind: "single-select", rowId: row.id })
    const rows = singleSelectResult().rows
    const current = row.currentId()
    const index = current === undefined ? -1 : rows.findIndex((candidate) => candidate.kind === "option" && candidate.option.value === current)
    setOptionCursor(index >= 0 ? index : firstSelectableRow(rows))
  }
  function beginConfirmation(row: Extract<SettingsInteractiveRow, { kind: "confirmation" }>): void {
    setConfirmationChoice("cancel")
    setActive({ kind: "confirmation", rowId: row.id })
  }
  function confirmAction(label: string, message: string, actionLabel: string, onConfirm: () => void): void {
    if (interactionBlocked()) return
    setConfirmationChoice("cancel")
    setActive({ kind: "confirmation", label, message, actionLabel, onConfirm: () => { returnToList(); onConfirm() } })
  }
  function confirmSelection(details: () => SettingsSelectionConfirmation, select: (id: string) => void, submit: () => Promise<boolean>): void {
    if (interactionBlocked()) return
    setConfirmationChoice("cancel")
    const confirmation: ActiveView = { kind: "confirmation", details, select, onConfirm: () => {
      const phase = details().phase
      void submit().then((done) => {
        if (untrack(active) !== confirmation) return
        if (done) returnToList()
        else if (phase === "preview-error") setConfirmationChoice("cancel")
      })
    } }
    setActive(confirmation)
  }


  function activateRow(index: number): void {
    if (interactionBlocked()) return
    if (editTarget()) {
      if (active().kind === "edit-action") returnToList()
      else submitEdit(true)
      if (interactionBlocked()) return
    }
    const row = visibleRows()[index]
    if (!row || row.kind === "separator") return
    setCursor(index)
    if (refusalReason(row)) return
    switch (row.kind) {
      case "cycle":
      case "action": row.onActivate(); return
      case "disclosure": {
        if (row.disclosure !== undefined && modalDisclosureAction(row.disclosure, "enter") === "toggle") disclosures.toggle(row.disclosure.id)
        return
      }
      case "group": {
        const groupQuery = listQuery().trim().toLowerCase()
        if (groupQuery !== "" && settingsRowDirectMatchScore(row, groupQuery) !== undefined) setListQuery("")
        setListGroupId(row.id)
        setActive({ kind: "list" })
        setCursor(firstSelectableRow(visibleRows(), (candidate) => candidate.kind !== "separator"))
        return
      }
      // A settings-tree child pushes itself above this entry; Sessions
      // replaces the whole stack. Either way this entry needs no close here.
      case "picker":
      case "navigation": row.onActivate(); return
      case "edit": beginEdit(row); return
      case "confirmation": beginConfirmation(row); return
      case "multiselect": beginMultiselect(row); return
      case "single-select": beginSingleSelect(row); return
    }
  }

  function toggleOption(rowIndex: number): void {
    if (interactionBlocked()) return
    const owner = multiselectRow()
    if (owner && refusalReason(owner)) { returnToList(); return }
    const row = multiselectResult().rows[rowIndex]
    if (row?.kind !== "option") return
    setOptionCursor(rowIndex)
    owner?.onToggle(row.option.value)
  }

  function selectOption(rowIndex: number): void {
    if (interactionBlocked()) return
    const owner = singleSelectRow()
    if (owner && refusalReason(owner)) { returnToList(); return }
    const resultRow = singleSelectResult().rows[rowIndex]
    if (!owner || resultRow?.kind !== "option") return
    setOptionCursor(rowIndex)
    const option = owner.options().find((candidate) => candidate.id === resultRow.option.value)
    if (!option) return
    if (option.kind === "choice") {
      returnToList()
      owner.onSelect(option.id)
      return
    }
    beginEditTarget(option.edit)
    setActive({ kind: "edit-action", rowId: owner.id, optionId: option.id })
  }

  function editChoice(optionId: string, label: string, edit: SettingsEditSpec): void {
    if (interactionBlocked()) return
    const owner = singleSelectRow()
    const resultRow = singleSelectResult().rows[optionCursor()]
    const option = owner?.options().find((candidate) => candidate.id === optionId)
    if (!owner || resultRow?.kind !== "option" || resultRow.option.value !== optionId || option?.kind !== "choice") return
    beginEditTarget(edit)
    setActive({ kind: "edit-choice", rowId: owner.id, label, edit })
  }

  const completion = createTerminalSettingEdit({
    target: editTarget, draft, leave: returnToList, setError: setDraftError,
    onError: (error) => deps.onError?.(error),
  })
  function submitEdit(leaving = false): void {
    if (interactionBlocked()) return
    if (editTarget()?.unavailableReason?.()) { returnToList(); return }
    completion.finish(leaving)
  }

  /** Backspace on an empty group filter returns to the root list with the cursor
   *  on the group that opened it. */
  function stepBackFromList(): void {
    const groupId = listGroupId()
    if (groupId === undefined) return
    const rootRows = visibleRowsFor(deps.rows())
    const rootIndex = rootRows.findIndex((row) => row.kind !== "separator" && row.id === groupId)
    setListGroupId(undefined)
    setCursor(Math.max(0, rootIndex))
  }

  const listKeys = createListModalKeys<SettingsRow>({
    rows: visibleRows,
    cursor,
    setCursor,
    onSelect: activateRow,
    onClose: close,
    selectable: (row) => row.kind !== "separator",
    extra: (event) => {
      const name = event.name.toLowerCase()
      const row = visibleRows()[cursor()]
      if ((name === "left" || name === "right") && row?.kind === "cycle" && row.onStep !== undefined) {
        if (refusalReason(row)) return false
        event.preventDefault?.()
        row.onStep(name === "left" ? -1 : 1)
        return true
      }
      return false
    },
    textInput: (event) => {
      if (event.name === "backspace" && listQuery() === "" && listGroupId() !== undefined) {
        event.preventDefault?.()
        stepBackFromList()
        return
      }
      runFilterEditor(listEditor, event)
    },
  })


  function setFilterValue(setValue: (value: string) => void, value: string): void {
    setValue(value)
    const current = active()
    if (current.kind === "list") {
      setCursor(firstSelectableRow(visibleRows(), (row) => row.kind !== "separator"))
      return
    }
    if (current.kind === "single-select") setOptionCursor(firstSelectableRow(singleSelectResult().rows))
    else setOptionCursor(firstSelectableRow(multiselectResult().rows))
  }

  const listEditor = createControlledTextEditor({ value: listQuery, setValue: (value) => setFilterValue(setListQuery, value), policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  const optionEditor = createControlledTextEditor({ value: query, setValue: (value) => setFilterValue(setQuery, value), policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  const draftEditor = createControlledTextEditor({
    value: draft,
    setValue: (value) => { completion.noteInput(); setDraft(value); setDraftError(undefined) },
    policy: SINGLE_LINE_TEXT_ENTRY_POLICY,
  })

  function resetOptionQuery(): void {
    setQuery("")
    optionEditor.resetEphemeralState({ cursor: 0 })
  }

  function runFilterEditor(editor: ControlledTextEditor, event: ListModalKeyEvent): void {
    editor.handleKey(event)
  }

  function runDraftEditor(event: ListModalKeyEvent): void {
    const text = normalizedPrintableText(event)
    if (text !== null) completion.noteInput()
    const sanitized = text === null ? null : editTarget()?.edit.sanitizeInput?.(text) ?? text
    if (text !== null && !sanitized) return
    if (editTarget()?.unavailableReason?.()) { returnToList(); return }
    if (completion.handleKey(sanitized === null || sanitized === text ? event : { ...event, name: sanitized, raw: sanitized }, draftEditor) === "leave" && ["up", "down"].includes(event.name)) listKeys(event)
  }

  const multiselectKeys = createListModalKeys<FlatRow<string>>({
    rows: () => multiselectResult().rows,
    cursor: optionCursor,
    setCursor: setOptionCursor,
    onSelect: toggleOption,
    onClose: close,
    extra: (event) => {
      if (event.name.toLowerCase() === "left") {
        event.preventDefault?.()
        returnToList()
        return true
      }
      if (event.name.toLowerCase() !== "space") return false
      event.preventDefault?.()
      toggleOption(optionCursor())
      return true
    },
    textInput: (event) => runFilterEditor(optionEditor, event),
  })

  const singleSelectKeys = createListModalKeys<FlatRow<string>>({
    rows: () => singleSelectResult().rows,
    cursor: optionCursor,
    setCursor: setOptionCursor,
    onSelect: selectOption,
    onClose: close,
    extra: (event) => {
      if (event.name.toLowerCase() === "left") {
        event.preventDefault?.()
        returnToList()
        return true
      }
      const owner = singleSelectRow()
      if (event.ctrl || event.meta) return false
      const resultRow = singleSelectResult().rows[optionCursor()]
      const hotkey = owner?.hotkeys?.find((candidate) => candidate.key.toLowerCase() === event.name.toLowerCase() && (candidate.available?.(resultRow?.kind === "option" ? resultRow.option.value : "") ?? true))
      if (!hotkey || resultRow?.kind !== "option") return false
      const option = owner?.options().find((candidate) => candidate.id === resultRow.option.value)
      if (option?.kind !== "choice") return false
      event.preventDefault?.()
      hotkey.run(option.id)
      return true
    },
    textInput: (event) => {
      if (singleSelectRow()?.filterable !== false) runFilterEditor(optionEditor, event)
    },
  })
  function handleConfirmationKey(event: ListModalKeyEvent): void {
    const name = event.name.toLowerCase()
    const selection = active()
    if (selection.kind === "confirmation" && (name === "up" || name === "down")) {
      const details = selection.details?.()
      const candidates = details?.candidates
      if (candidates?.length) {
        const index = candidates.findIndex((candidate) => candidate.id === details?.selectedId)
        const next = candidates[(index + (name === "down" ? 1 : candidates.length - 1)) % candidates.length]
        if (next) selection.select?.(next.id)
      }
      return
    }
    if (name === "escape") {
      event.preventDefault?.()
      if (selection.kind === "confirmation" && selection.details) returnToList()
      else close()
      return
    }
    if (selection.kind === "confirmation" && selection.details?.().phase === "loading") {
      if (name === "enter" || name === "return") { event.preventDefault?.(); returnToList() }
      return
    }
    if (name === "left" || name === "right" || name === "tab") {
      event.preventDefault?.()
      setConfirmationChoice((choice) => choice === "confirm" ? "cancel" : "confirm")
      return
    }
    if (name !== "enter" && name !== "return") return
    event.preventDefault?.()
    if (confirmationChoice() === "cancel") { returnToList(); return }
    const current = active()
    if (current.kind !== "confirmation") return
    if (current.onConfirm !== undefined) { current.onConfirm(); return }
    const row = current.rowId === undefined ? undefined : rowById(current.rowId)
    if (row?.kind === "confirmation") row.onConfirm()
  }


  function handleKey(event: ListModalKeyEvent): void {
    if (interactionBlocked()) return
    const current = active()
    if (current.kind === "list") listKeys(event)
    else if (current.kind === "edit-row" || current.kind === "edit-action" || current.kind === "edit-choice") runDraftEditor(event)
    else if (current.kind === "multiselect") multiselectKeys(event)
    else if (current.kind === "single-select") singleSelectKeys(event)
    else handleConfirmationKey(event)
  }

  function handlePaste(text: string): void {
    if (interactionBlocked()) return
    const current = active()
    const editor = current.kind === "list" ? listEditor
      : current.kind === "multiselect" || (current.kind === "single-select" && singleSelectRow()?.filterable !== false) ? optionEditor
        : current.kind === "edit-row" || current.kind === "edit-action" || current.kind === "edit-choice" ? draftEditor : undefined
    if (!editor) return
    const target = editTarget()
    if (editor === draftEditor && target && completion.saving(target.id)) return
    if (editor === draftEditor) completion.noteInput()
    const sanitized = editor === draftEditor ? editTarget()?.edit.sanitizePaste?.(text) ?? text : text
    if (!sanitized) return
    editor.handlePaste(sanitized)
  }

  function open(): void {
    entry?.close()
    setActive({ kind: "list" })
    setListGroupId(undefined)
    disclosures.reset()
    setListQuery("")
    listEditor.resetEphemeralState({ cursor: 0 })
    setDraft("")
    draftEditor.resetEphemeralState({ cursor: 0 })
    setDraftError(undefined)
    completion.begin()
    resetOptionQuery()
    setCursor(firstSelectableRow(visibleRows(), (row) => row.kind !== "separator"))
    entry = deps.modal.replace(deps.renderModal, {
      onKey: handleKey,
      onPaste: handlePaste,
      onClose: () => { if (active().kind !== "edit-action") submitEdit(true) },
    })
  }

  function close(): void {
    const current = active()
    if (current.kind === "confirmation" && current.details?.().pending) return
    entry?.close()
  }

  function listView(): Extract<SettingsView, { kind: "list" }> {
    const groupId = listGroupId()
    const group = groupId === undefined ? undefined : rootRowById(groupId)
    return {
      kind: "list",
      presentation: listEditor.presentation(),
      rows: visibleRows().map((row) => "value" in row && completion.saving(row.id) ? { ...row, value: () => "Saving..." } : row),
      ...(group?.kind === "group" ? { label: group.label } : {}),
    }
  }

  const view = createMemo<SettingsView>(() => {
    const current = active()
    if (current.kind === "edit-row" || current.kind === "edit-action" || current.kind === "edit-choice") {
      const target = editTarget()
      if (!target) return listView()
      const format = target.edit.formatDraft ?? ((text: string) => text)
      const error = draftError()
      const raw = draftEditor.presentation()
      const value = format(raw.value)
      const mapOffset = (offset: number) => formattedDraftOffset(raw.value, value, offset)
      const presentation: TextEditorPresentation = {
        ...raw,
        value,
        cursor: mapOffset(raw.cursor),
        selection: raw.selection === null ? null : { start: mapOffset(raw.selection.start), end: mapOffset(raw.selection.end) },
      }
      return { kind: "edit", label: target.label, hint: target.edit.hint, presentation, current: target.edit.current(), action: current.kind === "edit-action", saving: completion.saving(target.id), ...(error === undefined ? {} : { error }) }
    }
    if (current.kind === "multiselect") {
      const row = multiselectRow()
      if (!row) return listView()
      return { kind: "multiselect", label: row.label, presentation: optionEditor.presentation(), result: multiselectResult(), cursor: optionCursor(), selectedIds: row.selectedIds() }
    }
    if (current.kind === "single-select") {
      const row = singleSelectRow()
      if (!row) return listView()
      const currentId = row.currentId()
      const result = singleSelectResult()
      const selectedRow = result.rows[optionCursor()]
      const selectedOptionId = selectedRow?.kind === "option" ? selectedRow.option.value : ""
      return { kind: "single-select", label: row.label, presentation: optionEditor.presentation(), filterable: row.filterable !== false, result, cursor: optionCursor(), ...(currentId === undefined ? {} : { currentId }), ...(row.hotkeys === undefined ? {} : { hotkeyHint: row.hotkeys.filter((hotkey) => hotkey.available?.(selectedOptionId) ?? true).map((hotkey) => hotkey.hint).join(" · ") }) }
    }
    if (current.kind === "confirmation") {
      if (current.details) return { ...current.details(), choice: confirmationChoice() }
      if (current.message !== undefined && current.label !== undefined && current.actionLabel !== undefined) return { kind: "confirmation", label: current.label, message: current.message, actionLabel: current.actionLabel, choice: confirmationChoice() }
      const row = current.rowId === undefined ? undefined : rowById(current.rowId)
      if (row?.kind !== "confirmation") return listView()
      return { kind: "confirmation", label: row.label, message: row.message, actionLabel: row.actionLabel, choice: confirmationChoice() }
    }
    return listView()
  })

  return {
    view, cursor, open, close, handle: () => entry,
    finishEdit: () => { if (active().kind !== "edit-action") submitEdit(true) },
    activateRow, toggleOption, selectOption,
    editChoice, confirmAction, confirmSelection,
  }
}
