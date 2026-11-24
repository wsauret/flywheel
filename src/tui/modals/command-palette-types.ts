import type { FilteredResult } from "../components/modal/select/modal-select-types.js"
import type { TextEditorPresentation } from "../terminal/keymap/text-entry.js"

export interface CommandPaletteState {
  presentation: TextEditorPresentation
  cursor: number
  result: FilteredResult
}
