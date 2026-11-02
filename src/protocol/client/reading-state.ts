import { Schema } from "effect"

/** The reader's place across a reload of the page.
 *
 *  A page can go away under the reader: a runtime refuses a client that is
 *  not its own build, and the refused client loads itself again through its
 *  host (ARCH-PROTOCOL-028, ARCH-PROTOCOL-029); a person or a browser reloads the page; a phone discards a
 *  page it hid. So the client saves where the reader was, in the page's
 *  session storage, before its own reload, whenever the page is hidden, and
 *  as the page unloads, and the next client restores it. A reload then shows
 *  as nothing but the page drawing again in the same place (PI-REMOTE-008),
 *  and the restored session is known before the catalog answers, so the
 *  first lane reads its transcript beside the catalog read. The place is
 *  the open session, whether the reader was following the live tail, the top
 *  visible row by the absolute index of its first block with how far its top
 *  sat from the transcript's top edge, and the rows and files the reader had
 *  opened or closed. A block's identity does not name a place: a block the page saw
 *  streaming carries its live id, and the reloaded page reads the durable one,
 *  while the absolute index is the one coordinate both share (ARCH-PROTOCOL-054, ARCH-PROTOCOL-055).
 *
 *  The restore runs in one order: select the saved session before any other
 *  is opened, reopen the saved rows before they render, wait for the fonts,
 *  read older pages back until the saved index is resident, then scroll the
 *  row that holds it back to its offset instantly. A smooth scroll or
 *  a scroll before the fonts land measures a layout that is still moving,
 *  and the transcript's own tail pin would fight it (POC 4).
 *
 *  The stored value carries a version. A value of another version, or one
 *  that does not read, is dropped and the client starts plain. */

export const ReadingStateSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  /** The reader was following the live tail; the reloaded client follows it too. */
  following: Schema.Boolean,
  /** The absolute index of the top visible row's first block, and how far
   *  the row's top sat below (positive) or above (negative) the transcript's
   *  top edge. */
  top: Schema.optional(Schema.Struct({
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    offset: Schema.Number.check(Schema.isFinite()),
  })),
  /** The disclosure keys the reader had opened in the session. */
  open: Schema.Array(Schema.String),
  /** The disclosure keys the reader had closed, which hold against a row that
   *  would arrive open. A place with no close leaves it out. */
  closed: Schema.optional(Schema.Array(Schema.String)),
})
export type ReadingState = typeof ReadingStateSchema.Type

type ReadingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

const KEY = "flywheel.client.reading-state"
const VERSION = 1

function decode(value: unknown): ReadingState | undefined {
  if (typeof value !== "object" || value === null || !("v" in value) || value.v !== VERSION) return undefined
  try {
    const { closed, ...place } = Schema.decodeUnknownSync(ReadingStateSchema)(value)
    return closed === undefined || closed.length === 0 ? place : { ...place, closed }
  } catch { return undefined }
}

/** Saves the place for the reload about to happen. A storage that refuses
 *  loses it, and the reloaded client starts plain. */
export function saveReadingState(storage: ReadingStorage | undefined, state: ReadingState): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ v: VERSION, ...state }))
  } catch {
    // Blocked or full storage: the reload still happens, without the place.
  }
}

/** Removes the saved place, for a page that came back and so was not reloaded. */
export function forgetReadingState(storage: ReadingStorage | undefined): void {
  try {
    storage?.removeItem(KEY)
  } catch {
    // Blocked storage holds nothing to forget.
  }
}

/** Reads the saved place and removes it, so it restores exactly one reload. */
export function takeReadingState(storage: ReadingStorage | undefined): ReadingState | undefined {
  try {
    const text = storage?.getItem(KEY) ?? null
    if (text === null) return undefined
    storage?.removeItem(KEY)
    return decode(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** The scroll position that puts the saved row's top back at its saved
 *  offset from the transcript's top edge, from where the row is now. */
export function restoredScrollTop(input: { readonly scrollTop: number; readonly rowTop: number; readonly viewportTop: number; readonly offset: number }): number {
  return input.scrollTop + (input.rowTop - input.viewportTop) - input.offset
}
