import type { ComposerDraft, ComposerDraftAttachment, ComposerDraftPaste, DraftCache } from "./create-draft-cache.js"
import { attachmentMarker, nextAttachmentOrdinal } from "../../protocol/client/attachments.js"
import { normalizeChatInput, type ChatInputLike } from "../../infra/chat-input.js"

/** Every marker the prompt writes: `[Image #3]` or `[File #4 notes.md]`. */
const MARKER = /\[(Image|File) #(\d+)((?: [^\]]*)?)\]/g

/** The number inside a marker, or 0 when the marker is not numbered. */
function markerNumber(marker: string): number {
  const match = /^\[(?:Image|File) #(\d+)(?: [^\]]*)?\]$/.exec(marker)
  return match ? Number(match[1]) : 0
}

/** The same marker with another number: the kind and any name stay. */
function renumbered(marker: string, ordinal: number): string {
  return marker.replace(/#\d+/, `#${ordinal}`)
}

/** Moves ready and pending attachments together when a new chat adopts an existing session. */
export function adoptDraftAttachments(
  cache: DraftCache,
  from: string,
  to: string,
  adoptPending: (from: string, to: string, occupied: readonly string[]) => ReadonlyMap<string, string>,
): void {
  const destination = cache.get(to)
  const source = cache.get(from)
  const reserved = [...destination.attachments.map((item) => item.marker), ...[...destination.text.matchAll(MARKER)].map((match) => match[0])]
  const next = nextAttachmentOrdinal(reserved)
  const occupied = [...reserved, ...source.attachments.map((_, index) => attachmentMarker("image", next + index))]
  let renamed = source
  for (const [oldMarker, newMarker] of adoptPending(from, to, occupied)) renamed = replaceDraftMarker(renamed, oldMarker, newMarker)
  cache.set(from, renamed)
  cache.adopt(from, to)
}

/** Combine a recalled draft into the draft that already belongs to its session,
 *  so a recall that settles after the user moved on loses nothing.
 *
 *  The recalled text follows the current text after one blank line. Current
 *  ranges keep their offsets. Recalled markers are renumbered above the
 *  current draft's highest marker, in both the text and the attachment metadata. */
export function mergeComposerDrafts(current: ComposerDraft, recalled: ComposerDraft): ComposerDraft {
  const highest = Math.max(0, ...current.attachments.map((item) => markerNumber(item.marker)), ...[...current.text.matchAll(MARKER)].map((match) => markerNumber(match[0])))
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

/** Merges a chat input that left the prompt back into its owner's cached
 *  draft, after anything the person typed there since. */
export function mergeInputIntoDraft(cache: DraftCache, ownerId: string, input: ChatInputLike): void {
  const normalized = normalizeChatInput(input)
  cache.set(ownerId, mergeComposerDrafts(cache.get(ownerId), { text: normalized.text, pastes: [], attachments: normalized.attachments ?? [] }))
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
