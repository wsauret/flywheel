/** @jsxImportSource @opentui/solid */
import type { TextChunk } from "@opentui/core"
import { bold as stBold, fg as stFg } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { ComposerHistoryPopupHook } from "../hooks/create-composer-history-popup.js"
import { ComposerPopupList } from "./composer-popup-list.js"

interface ComposerHistoryPopupProps {
  history: ComposerHistoryPopupHook
  /** Content width available for rows (inside the frame's borders and padding). */
  width: () => number
  onActivate: (index: number) => void
}

/** One-line presentation of a possibly multiline history entry: internal
 *  whitespace runs collapse to single spaces, then the row is ellipsized to
 *  the available width. Presentation only; activation receives the original
 *  exact entry text from the hook. */
function flattenRow(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (width <= 0) return ""
  if (flat.length <= width) return flat
  return width === 1 ? "…" : `${flat.slice(0, width - 1)}…`
}

/** Prompt-history rows rendered inside the prompt frame's popup section,
 *  oldest-first so the newest entry sits on the bottom row next to the
 *  prompt bar. Window, scrollbar, wheel, and drag mechanics come from
 *  ComposerPopupList; the selected row is colored with the accent like the
 *  slash-suggestion rows. */
export function ComposerHistoryPopup(props: ComposerHistoryPopupProps) {
  const { theme } = useTheme()

  return (
    <ComposerPopupList
      count={() => props.history.rows().length}
      selectedIndex={props.history.selectedIndex}
      moveSelection={props.history.moveSelection}
      select={props.history.select}
      width={props.width}
      onActivate={props.onActivate}
      rowChunks={(index, isSelected, rowWidth): TextChunk[] => {
        const entry = props.history.rows()[index] ?? ""
        const chunk = stFg(isSelected ? theme.primary : theme.text)(flattenRow(entry, rowWidth))
        return [isSelected ? stBold(chunk) : chunk]
      }}
    />
  )
}
