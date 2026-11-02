/** @jsxImportSource @opentui/solid */
import type { TextChunk } from "@opentui/core"
import { bold as stBold, fg as stFg } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { createMemo } from "solid-js"
import type { TuiTheme } from "../context/theme/resolve.js"
import type { ModalSelectOption } from "./modal-select-types.js"
import type { SlashSuggestionsHook } from "../hooks/create-slash-suggestions.js"
import { ComposerPopupList } from "./composer-popup-list.js"

const TOKEN_COLUMN_GAP = 2
const MIN_TOKEN_COLUMN = 12

interface SlashSuggestionsProps {
  suggestions: SlashSuggestionsHook
  /** Content width available for rows (inside the frame's borders and padding). */
  width: () => number
  onActivate: (index: number) => void
}

function ellipsize(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  return width === 1 ? "…" : `${text.slice(0, width - 1)}…`
}

/** The tokens that run a row's command: its own token and its aliases, as
 *  the catalog states them, or the row's value when it has no aliases. */
const tokensOf = (option: ModalSelectOption): string => option.footer ?? option.value

function rowChunks(
  option: ModalSelectOption,
  isSelected: boolean,
  tokenColumn: number,
  contentWidth: number,
  theme: TuiTheme,
): TextChunk[] {
  const token = ellipsize(tokensOf(option), Math.min(tokenColumn, contentWidth)).padEnd(tokenColumn)
  const tokenChunk = stFg(isSelected ? theme.primary : theme.text)(token)
  const chunks: TextChunk[] = [isSelected ? stBold(tokenChunk) : tokenChunk]

  const detail = option.description ?? option.title
  const detailWidth = contentWidth - tokenColumn - TOKEN_COLUMN_GAP
  if (detail && detailWidth > 0) {
    chunks.push(stFg(isSelected ? theme.primary : theme.textMuted)(`${" ".repeat(TOKEN_COLUMN_GAP)}${ellipsize(detail, detailWidth)}`))
  }
  return chunks
}

/** Slash-command suggestion rows rendered inside the prompt frame's popup
 *  section. Two-column rows (padded command tokens with aliases, muted description);
 *  the selected row is colored with the accent instead of
 *  a background highlight. Window, scrollbar, wheel, and drag mechanics come
 *  from ComposerPopupList. */
export function SlashSuggestions(props: SlashSuggestionsProps) {
  const { theme } = useTheme()

  const tokenColumn = createMemo(() => {
    const widest = props.suggestions.matches().reduce((max, option) => Math.max(max, tokensOf(option).length), 0)
    return Math.max(MIN_TOKEN_COLUMN, Math.min(widest, Math.floor(props.width() * 0.45)))
  })

  return (
    <ComposerPopupList
      count={() => props.suggestions.matches().length}
      selectedIndex={props.suggestions.selectedIndex}
      moveSelection={props.suggestions.moveSelection}
      select={props.suggestions.select}
      width={props.width}
      onActivate={props.onActivate}
      rowChunks={(index, isSelected, rowWidth) => {
        const option = props.suggestions.matches()[index]
        // SAFETY: ComposerPopupList only requests indices below count(), which
        // is this same matches() array's length.
        return rowChunks(option!, isSelected, tokenColumn(), rowWidth, theme)
      }}
    />
  )
}
