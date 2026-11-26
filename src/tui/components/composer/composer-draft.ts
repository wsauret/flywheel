import type { ChatAttachment } from "../../../infra/substrate/events/chat-input.js"

export interface ComposerDraftPaste {
  readonly start: number
  readonly end: number
  readonly text: string
}

export type ComposerDraftAttachment = ChatAttachment

export interface ComposerDraft {
  readonly text: string
  readonly pastes: readonly ComposerDraftPaste[]
  readonly attachments: readonly ComposerDraftAttachment[]
  /** Where the caret stood when the draft was written; absent means the end. */
  readonly caret?: number
}

/** Every marker the prompt writes: `[Image #3]` or `[File #4 notes.md]`. */
const MARKER = /\[(Image|File) #(\d+)((?: [^\]]*)?)\]/g

/** Every marker a draft holds: its attachments' markers, then the markers in its text. */
export function draftMarkers(draft: ComposerDraft): string[] {
  return [...draft.attachments.map((item) => item.marker), ...[...draft.text.matchAll(MARKER)].map((match) => match[0])]
}

/** The number inside a marker, or 0 when the marker is not numbered. */
function markerNumber(marker: string): number {
  const match = /^\[(?:Image|File) #(\d+)(?: [^\]]*)?\]$/.exec(marker)
  return match ? Number(match[1]) : 0
}

/** The same marker with another number: the kind and any name stay. */
function renumbered(marker: string, ordinal: number): string {
  return marker.replace(/#\d+/, `#${ordinal}`)
}

/** Combine a recalled draft into the draft that already belongs to its session,
 *  so a recall that settles after the user moved on loses nothing.
 *
 *  The recalled text follows the current text after one blank line. Current
 *  ranges keep their offsets. Recalled markers are renumbered above the
 *  current draft's highest marker, in both the text and the attachment metadata. */
export function mergeComposerDrafts(current: ComposerDraft, recalled: ComposerDraft): ComposerDraft {
  const highest = Math.max(0, ...draftMarkers(current).map(markerNumber))
  const renamed = new Map(recalled.attachments.map((item, index) => [item.marker, renumbered(item.marker, highest + index + 1)]))

  // Renumbering can change a marker's width, so every recalled offset moves by
  // the accumulated width change of the markers that end before it.
  const widthChanges: Array<{ readonly endsAt: number; readonly delta: number }> = []
  let delta = 0
  const recalledText = recalled.text.replace(MARKER, (marker: string, _kind: string, _digits: string, _name: string, at: number) => {
    const replacement = renamed.get(marker)
    if (replacement === undefined) return marker
    delta += replacement.length - marker.length
    widthChanges.push({ endsAt: at + marker.length, delta })
    return replacement
  })

  const separator = current.text && recalledText ? "\n\n" : ""
  const base = current.text.length + separator.length
  const moved = (offset: number): number => {
    let shift = 0
    for (const change of widthChanges) {
      if (change.endsAt > offset) break
      shift = change.delta
    }
    return base + offset + shift
  }

  const pastes: ComposerDraftPaste[] = [
    ...current.pastes,
    ...recalled.pastes.map((paste) => ({ ...paste, start: moved(paste.start), end: moved(paste.end) })),
  ]
  const attachments: ComposerDraftAttachment[] = [
    ...current.attachments,
    ...recalled.attachments.map((item) => ({ ...item, marker: renamed.get(item.marker) ?? item.marker })),
  ]
  return { text: current.text + separator + recalledText, pastes, attachments }
}

/** Replaces one attachment marker while keeping collapsed-paste offsets aligned. */
export function replaceDraftMarker(draft: ComposerDraft, marker: string, replacement: string): ComposerDraft {
  const at = draft.text.indexOf(marker)
  if (at < 0) return draft
  const end = at + marker.length
  const delta = replacement.length - marker.length
  return {
    ...draft,
    text: draft.text.slice(0, at) + replacement + draft.text.slice(end),
    pastes: draft.pastes.map((paste) => ({
      ...paste,
      start: paste.start >= end ? paste.start + delta : paste.start,
      end: paste.end >= end ? paste.end + delta : paste.end,
    })),
  }
}
