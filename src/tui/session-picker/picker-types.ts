import type { SessionCatalogRow } from "../../protocol/app-service-types.js"

export type PickerRow = PickerHeaderRow | PickerSessionRow | PickerCorruptRow

/** Every non-header row: the rows the picker renders interactively and the
 *  cursor can land on. */
export type SelectablePickerRow = PickerSessionRow | PickerCorruptRow

interface PickerHeaderRow {
  readonly kind: "header"
  readonly id: string
  readonly label: string
}

export interface PickerSessionRow {
  readonly kind: "session"
  readonly id: string
  readonly session: SessionCatalogRow
  readonly category: string
}

/** A session whose metadata facts cannot be projected. Synthesized by the
 *  picker from the catalog's error channel, never from catalog rows, so it
 *  stays out of every other session surface (tabs, strips, snapshots). */
export interface PickerCorruptRow {
  readonly kind: "corrupt"
  readonly id: string
  readonly sessionId: string
  readonly reason: string
}
