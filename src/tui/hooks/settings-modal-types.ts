import type { Accessor } from "solid-js"
import type { FilteredResult } from "../components/modal-select-types.js"
import type { PersistedSettingDefinition } from "../../orchestration/config/setting-definitions.js"
import type { ModalDisclosure, ModalDisclosureItem } from "../components/modal-disclosure.js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"

/** One item of a multiselect row. The id is the durable identity the row's
 *  toggle callback writes against; the label is what the list shows. */
interface SettingsMultiselectOption {
  id: string
  label: string
  description?: string
  category?: string
}

/** The outcome of one edit submission. Validation and the durable write both
 *  happen inside the row's callback, so the modal never learns a setting's
 *  rules: it only keeps the editor open and shows the reported error. */
export type SettingsEditResult = { ok: true } | { ok: false; error: string }

/** The editing contract of an edit row. */
export interface SettingsEditSpec {
  /** Explanation shown above the input. */
  hint: string
  /** The value the input shows as placeholder while the draft is empty. */
  current: Accessor<string>
  /** The text the editor opens with. */
  initialDraft: () => string
  /** Display transform that preserves draft characters in order and may insert presentation characters. */
  formatDraft?: (draft: string) => string
  /** Rejects typed text when it returns "". */
  sanitizeInput?: (text: string) => string
  /** Drops the paste when it returns "". */
  sanitizePaste?: (text: string) => string
  /** Validation returns synchronously. A promise represents the durable write, whose failure restores the saved value. */
  submit: (draft: string) => SettingsEditResult | Promise<SettingsEditResult>
}

interface SettingsSingleSelectOptionBase {
  id: string
  label: string
  description?: string
  category?: string
}

interface SettingsSingleSelectHotkey {
  /** Plain key-event name (no modifiers), e.g. "r". Only meaningful on rows
   *  with `filterable: false`; on filterable rows letters type the filter. */
  key: string
  hint: string
  available?: (optionId: string) => boolean
  run: (optionId: string) => void
}

type SettingsSingleSelectOption =
  | (SettingsSingleSelectOptionBase & { kind: "choice" })
  | (SettingsSingleSelectOptionBase & { kind: "action"; edit: SettingsEditSpec })

interface InteractiveRow {
  id: string
  label: string
  /** One-line meaning of this setting, shown in the footer while the row is
   *  selected. */
  description?: string
  /** Why the authored value could not be applied as written. The row is
   *  marked [!], and the footer states this reason while the row is
   *  selected. */
  warning?: string
  /** The reason this row cannot act right now, if any. Availability is a state
   *  of every interactive row, not a row kind: an unavailable row still takes
   *  the cursor, shows N/A in the value column, reports this reason in the
   *  footer, and refuses activation. */
  unavailableReason?: Accessor<string | undefined>
  /** The reason the person cannot change this row now, while its value is
   *  known. A locked row shows its value without step arrows, states this
   *  reason in the footer, and refuses activation. */
  lockedReason?: Accessor<string | undefined>
}

/** Why this row refuses activation now, if it does. */
export function refusalReason(row: Pick<InteractiveRow, "unavailableReason" | "lockedReason">): string | undefined {
  return row.unavailableReason?.() ?? row.lockedReason?.()
}

export type SettingsRow =
  | (InteractiveRow & { kind: "cycle"; value: Accessor<string>; onActivate: () => void; onStep?: (direction: -1 | 1) => void })
  | (InteractiveRow & { kind: "edit"; value: Accessor<string>; edit: SettingsEditSpec })
  | (InteractiveRow & { kind: "picker"; value: Accessor<string>; onActivate: () => void })
  | (InteractiveRow & { kind: "action"; value: Accessor<string>; onActivate: () => void })
  | (InteractiveRow & { kind: "confirmation"; message: string; actionLabel: string; onConfirm: () => void })
  | (InteractiveRow & { kind: "group"; rows: Accessor<readonly SettingsRow[]> })
  | (InteractiveRow & { kind: "disclosure"; rows: Accessor<readonly SettingsRow[]> })
  | (InteractiveRow & { kind: "navigation"; onActivate: () => void })
  | (InteractiveRow & {
      kind: "multiselect"
      value: Accessor<string>
      options: Accessor<readonly SettingsMultiselectOption[]>
      selectedIds: Accessor<readonly string[]>
      /** Writes the item immediately; the subview stays open. */
      onToggle: (optionId: string) => void
    })
  | (InteractiveRow & {
      kind: "single-select"
      value: Accessor<string>
      options: Accessor<readonly SettingsSingleSelectOption[]>
      currentId: Accessor<string | undefined>
      hotkeys?: readonly SettingsSingleSelectHotkey[]
      /** Default true. False drops the type-to-filter line and frees plain
       *  letters for row hotkeys; use for short fixed lists. */
      filterable?: boolean
      onSelect: (optionId: string) => void
    })
  | { kind: "separator"; label?: string }

export type SettingsInteractiveRow = Exclude<SettingsRow, { kind: "separator" }>
type SettingsDisclosureRow = Extract<SettingsRow, { kind: "disclosure" }>
export type SettingsVisibleRow =
  | ModalDisclosureItem<Exclude<SettingsRow, SettingsDisclosureRow>>
  | (ModalDisclosureItem<SettingsDisclosureRow> & { readonly disclosure: ModalDisclosure })

export interface CycleRowActions {
  onActivate: () => void
  onStep: (direction: -1 | 1) => void
}

export function cycleRowActions(step: (direction: -1 | 1) => void): CycleRowActions {
  return { onActivate: () => step(1), onStep: step }
}

export type SettingsSelectionConfirmation = {
  kind: "confirmation"; label: string; message: string; actionLabel: string; choice: "confirm" | "cancel"
} & (
  | { phase: "loading"; candidates?: never; selectedId?: never; error?: never; pending?: never }
  | { phase: "preview-error"; error: string; candidates?: never; selectedId?: never; pending?: never }
  | { phase: "ready"; pending: boolean; candidates?: readonly { id: string; displayName: string }[]; selectedId?: string; error?: string }
)

export type SettingsView =
  | { kind: "list"; label?: string; presentation: TextEditorPresentation; rows: readonly SettingsVisibleRow[] }
  | { kind: "edit"; label: string; hint: string; presentation: TextEditorPresentation; current: string; action?: boolean; saving?: boolean; error?: string }
  | { kind: "multiselect"; label: string; presentation: TextEditorPresentation; result: FilteredResult<string>; cursor: number; selectedIds: readonly string[] }
  | { kind: "single-select"; label: string; presentation: TextEditorPresentation; filterable: boolean; result: FilteredResult<string>; cursor: number; currentId?: string; hotkeyHint?: string }
  | { kind: "confirmation"; label: string; message: string; actionLabel: string; choice: "confirm" | "cancel" }
  | SettingsSelectionConfirmation

type SimpleDefinition = PersistedSettingDefinition & {
  readonly presentation: Extract<PersistedSettingDefinition["presentation"], { kind: "simple-boolean" | "simple-enum" }>
}

interface SimpleSettingRowAdapter {
  read: (definition: SimpleDefinition) => boolean | string
  write: (definition: SimpleDefinition, value: boolean | string) => { ok: true } | { ok: false; error: { message: string } }
  showFeedback: (feedback: { message: string; variant: "success" | "error" }) => void
}

/** A plain cycle row for a simple setting: the catalog row's id, name, and
 *  description, stepping through the definition's values. Its feedback names
 *  the row as the catalog does. */
export function simpleSettingRow(definition: SimpleDefinition, row: { readonly id: string; readonly label: string; readonly description: string }, adapter: SimpleSettingRowAdapter): SettingsRow {
  const presentation = definition.presentation
  const formatEnumValue = (current: string): string => presentation.kind === "simple-enum"
    ? presentation.valueLabels?.[current] ?? current.replace(/^./, (character) => character.toUpperCase())
    : ""
  const value = (): string => {
    const current = adapter.read(definition)
    if (presentation.kind === "simple-boolean") return current === true ? "YES" : "NO"
    if (presentation.valueFormat === "yes-no") return current === presentation.values[1] ? "YES" : "NO"
    return typeof current === "string" ? formatEnumValue(current) : ""
  }
  const step = (direction: -1 | 1): void => {
    const current = adapter.read(definition)
    const next = presentation.kind === "simple-boolean"
      ? current !== true
      : presentation.values[((presentation.values.indexOf(typeof current === "string" ? current : "") + direction) % presentation.values.length + presentation.values.length) % presentation.values.length]
    if (next === undefined) return
    const result = adapter.write(definition, next)
    if (!result.ok) {
      adapter.showFeedback({ message: `${row.label} update failed: ${result.error.message}`, variant: "error" })
      return
    }
    const message = presentation.kind === "simple-boolean"
      ? `${row.label} ${next ? "enabled" : "disabled"}`
      : `${row.label} set to ${formatEnumValue(typeof next === "string" ? next : "")}`
    adapter.showFeedback({ message, variant: "success" })
  }
  return { kind: "cycle", id: row.id, label: row.label, description: row.description, value, ...cycleRowActions(step) }
}
