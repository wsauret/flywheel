import fuzzysort from "fuzzysort"
import type { ModalSelectOption, FilteredResult, FlatRow } from "./modal-select-types.js"

export const MAX_RENDERED_ROWS = 200

function isOptionRow(row: unknown): boolean {
  return typeof row === "object" && row !== null && "kind" in row && row.kind === "option"
}

export function filterOptions<T>(
  options: readonly ModalSelectOption<T>[],
  query: string,
): readonly ModalSelectOption<T>[] {
  const enabled = options.filter((o) => !o.disabled)
  if (!query) return enabled
  const needle = query.toLowerCase()
  return fuzzysort
    .go(needle, enabled, {
      keys: ["title", "footer", "category"],
      scoreFn: (r) => {
        const [title, footer, category] = r
        // SAFETY: fuzzysort yields one Result per key, so the 3 keys above guarantee r[0..2] are present.
        return Math.max(title!.score * 2, footer!.score * 2) + category!.score
      },
    })
    .map((r) => r.obj)
}

export function flattenWithCategories<T>(
  filtered: readonly ModalSelectOption<T>[],
  showCategories: boolean,
): FilteredResult<T> {
  const totalMatches = filtered.length
  const capped = totalMatches > MAX_RENDERED_ROWS
  const bounded = capped ? filtered.slice(0, MAX_RENDERED_ROWS) : filtered

  const rows: FlatRow<T>[] = []
  let seenCategory: string | undefined

  for (const option of bounded) {
    if (showCategories && option.category && option.category !== seenCategory) {
      seenCategory = option.category
      rows.push({
        kind: "category",
        id: `cat:${option.category}`,
        rowIndex: rows.length,
        categoryLabel: option.category,
      })
    }
    rows.push({
      kind: "option",
      id: option.id,
      rowIndex: rows.length,
      option,
    })
  }

  return { rows, totalMatches, capped }
}

/** Wrap-around cursor movement over a row list where only some rows are
 *  selectable. Returns the array index of the next selectable row, skipping
 *  headers/categories; the default predicate targets modal-select's
 *  `option` rows, so lists with any other row shape pass their own. */
export function moveCursor<R>(
  rows: readonly R[],
  currentCursor: number,
  delta: 1 | -1,
  selectable: (row: R) => boolean = isOptionRow,
): number {
  const selectableRows = rows.filter(selectable)
  if (selectableRows.length === 0) return 0

  const currentRow = rows[currentCursor]
  const selectableIndex = currentRow !== undefined && selectable(currentRow)
    ? selectableRows.indexOf(currentRow)
    : -1

  const base = selectableIndex >= 0 ? selectableIndex : (delta === 1 ? -1 : selectableRows.length)
  const next = (base + delta + selectableRows.length) % selectableRows.length
  const target = selectableRows[next]
  return target ? rows.indexOf(target) : 0
}

export function firstSelectableRow<R>(
  rows: readonly R[],
  selectable: (row: R) => boolean = isOptionRow,
): number {
  const idx = rows.findIndex(selectable)
  return idx >= 0 ? idx : 0
}

export function matchAction<A extends { key: string }>(key: string, actions: readonly A[]): A | undefined {
  return actions.find((action) => action.key === key)
}
