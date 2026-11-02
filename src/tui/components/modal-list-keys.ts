import { moveCursor } from "./modal-select-helpers.js"

/** The key-event shape the modal stack delivers to the top entry. */
export interface ListModalKeyEvent {
  name: string
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  shift?: boolean
  sequence?: string
  raw?: string
  preventDefault?: () => void
}

interface ListModalKeyOptions<R> {
  rows: () => readonly R[]
  cursor: () => number
  setCursor: (index: number) => void
  /** Return activates the row under the cursor. */
  onSelect: (index: number) => void
  /** Escape. Usually the modal clear; modals with nested navigation pass
   *  their own step-back. */
  onClose: () => void
  /** Which rows the cursor may rest on. Omit only for modal-select FlatRow
   *  lists, where the default targets `kind === "option"` rows. */
  selectable?: (row: R) => boolean
  /** Modal-specific keys tried before the shared dispatch (action shortcuts,
   *  mode switches); return true when consumed. */
  extra?: (evt: ListModalKeyEvent) => boolean
  /** The modal's text field, such as a search filter. It receives every key
   *  the shared dispatch did not consume. A focused text field must receive
   *  every printable key, so a modal with one moves the cursor with arrows
   *  only and j/k type into the field. A modal without one also moves with
   *  j/k. */
  textInput?: (evt: ListModalKeyEvent) => void
}

/** The one escape/up/down/return controller behind every list modal. Escape
 *  closes, arrows wrap the cursor over selectable rows, return activates.
 *  Everything a specific modal adds on top is a parameter, not a fork. */
export function createListModalKeys<R>(opts: ListModalKeyOptions<R>): (evt: ListModalKeyEvent) => void {
  const vimKeys = opts.textInput === undefined

  function move(delta: 1 | -1): void {
    opts.setCursor(moveCursor(opts.rows(), opts.cursor(), delta, opts.selectable))
  }

  return (evt) => {
    if (opts.extra?.(evt)) return
    const name = evt.name.toLowerCase()
    if (name === "escape") {
      evt.preventDefault?.()
      opts.onClose()
      return
    }
    if (name === "up" || (vimKeys && name === "k")) {
      evt.preventDefault?.()
      move(-1)
      return
    }
    if (name === "down" || (vimKeys && name === "j")) {
      evt.preventDefault?.()
      move(1)
      return
    }
    if (name === "return" || name === "enter") {
      evt.preventDefault?.()
      opts.onSelect(opts.cursor())
      return
    }
    opts.textInput?.(evt)
  }
}
