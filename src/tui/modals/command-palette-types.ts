import type { FilteredResult } from "../components/modal-select-types.js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"

export interface CommandPaletteState {
  presentation: TextEditorPresentation
  cursor: number
  result: FilteredResult
}
