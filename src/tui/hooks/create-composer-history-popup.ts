import type { Accessor } from "solid-js"
import { createSignal } from "solid-js"

export interface ComposerHistoryPopupOptions {
  /** Prompt history entries oldest-first (the history hook's reactive snapshot). */
  entries: Accessor<readonly string[]>
}

/** Open/selection state for the composer-history popup. Rows are the history
 *  entries oldest-first (the last row is the most recent prompt, closest to
 *  the prompt bar) with their original exact text; presentation flattening
 *  belongs to the component. Browsing is non-destructive: this hook never
 *  touches the prompt input. There is no filtering, no query, and no saved
 *  draft. */
export interface ComposerHistoryPopupHook {
  visible: () => boolean
  /** History entries oldest-first, original exact text. */
  rows: Accessor<readonly string[]>
  selectedIndex: () => number
  /** Clamped, non-wrapping: -1 moves to an older entry, +1 to a newer one. */
  moveSelection: (delta: 1 | -1) => void
  select: (index: number) => void
  /** Opens on the newest (last) entry; a no-op when the history is empty. */
  open: () => void
  close: () => void
}

export function createComposerHistoryPopup(opts: ComposerHistoryPopupOptions): ComposerHistoryPopupHook {
  const [state, setState] = createSignal({ open: false, index: 0 })
  const rows = opts.entries
  // Clamped against the live row count so entries shrinking while open cannot
  // strand the selection past the end.
  const selectedIndex = (): number => Math.max(0, Math.min(state().index, rows().length - 1))
  return {
    visible: () => state().open && rows().length > 0,
    rows,
    selectedIndex,
    moveSelection(delta) {
      const len = rows().length
      if (len === 0) return
      setState({ open: true, index: Math.max(0, Math.min(len - 1, selectedIndex() + delta)) })
    },
    select(index) {
      if (index >= 0 && index < rows().length) setState({ open: true, index })
    },
    open() {
      if (rows().length > 0) setState({ open: true, index: rows().length - 1 })
    },
    close() {
      setState({ open: false, index: 0 })
    },
  }
}
