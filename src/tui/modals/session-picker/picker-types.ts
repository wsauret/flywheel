import type { SessionCatalogRow } from "../../../protocol/runtime/app-service-types.js"
import type { FoundChat } from "../../../protocol/transcript/transcript-protocol-types.js"
import type { StoppedChat } from "../../../protocol/session/unread-protocol-types.js"

export type PickerRow = PickerHeaderRow | PickerSessionRow | PickerCorruptRow | PickerFoundRow

/** Every non-header row: the rows the picker renders interactively and the
 *  cursor can land on. */
export type SelectablePickerRow = PickerSessionRow | PickerCorruptRow | PickerFoundRow

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
  /** The stop of a chat that stopped for the person unread, which the row
   *  shows under its title (PI-INTERACTION-186). */
  readonly stopped?: StoppedChat
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

/** A chat that the search found by words in its messages rather than by its
 *  title. It shows under the title matches with the matching words and where
 *  the chat stands, and opening it lands the transcript on the best match. */
export interface PickerFoundRow {
  readonly kind: "found"
  readonly id: string
  readonly session: SessionCatalogRow
  readonly found: FoundChat
}

/** The rows the session picker shows for the current filter. */
export interface SessionPickerResult {
  readonly rows: readonly PickerRow[]
  readonly totalMatches: number
  readonly capped: boolean
  readonly effectiveHighlightQuery: string
  readonly timeAgoWidth: number
  /** True while the filter's search of the chats' messages has not answered yet. */
  readonly searchingMessages: boolean
}
