import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"
import { RenderableEvents, type PasteEvent } from "@opentui/core"
import { createSignal, untrack } from "solid-js"
import { isImageAttachment, normalizeChatInput, type ChatInput } from "../../infra/chat-input.js"
import { resizeImage } from "../../orchestration/agent-runtime/tools/image-resize.js"
import { unescapeShellPath } from "../../orchestration/agent-runtime/tools/tool-paths.js"
import { ATTACHMENT_LIMITS, attachmentKind, attachmentMarker, attachmentRefusalMessage, base64ByteLength, nextAttachmentOrdinal } from "../../protocol/client/attachments.js"
import type { Clipboard } from "../utils/clipboard.js"
import { readFileAttachment, type PendingAttachment, type ReadAttachment } from "../utils/file-attachments.js"
import type { ComposerDraftAttachment } from "./create-draft-cache.js"

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?)$/i

function attachmentFromPaste(event: PasteEvent): PendingAttachment | null {
  const mediaType = event.metadata?.mimeType
  if (!mediaType?.startsWith("image/")) return null
  return { mediaType, data: Buffer.from(event.bytes).toString("base64") }
}

function pathText(text: string, cwd: string): { paths: readonly string[]; text: string } | undefined {
  const rawCandidates = text.endsWith(" ") ? [text, text.slice(0, -1)] : [text]
  const paths = new Set<string>()
  for (const rawCandidate of rawCandidates) {
    for (const candidate of [rawCandidate, unescapeShellPath(rawCandidate)]) {
      if (isAbsolute(candidate)) paths.add(resolve(cwd, candidate))
    }
  }
  return paths.size > 0 ? { paths: [...paths], text } : undefined
}

/** Splits the paste into separators at even and candidates at odd indexes. A
 *  terminal drops several files as absolute paths separated by unescaped ASCII
 *  whitespace; macOS screenshot names hold U+202F, so other spaces stay inside a
 *  path. Any other paste, or one whose whole text names an existing entry, stays
 *  one candidate, so a single path keeps a real space in its name. */
function pasteParts(text: string, cwd: string): readonly string[] {
  const parts = text.split(/((?:\\[\s\S]|[^ \t\r\n])+)/)
  const candidates = parts.filter((_, index) => index % 2 === 1)
  const list = candidates.length > 1 && candidates.every((candidate) => isAbsolute(candidate))
  return list && !pathText(text, cwd)?.paths.some((path) => existsSync(path)) ? parts : ["", text]
}

async function findImagePath(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      if (!(await stat(path)).isFile()) continue
    } catch {
      continue
    }
    if (attachmentKind(Bun.file(path).type, basename(path)) === "image") return path
  }
  return undefined
}

interface PromptAttachmentOptions {
  readonly cwd?: string
  readonly findImagePath?: (paths: readonly string[]) => Promise<string | undefined>
  readonly onChange?: () => void
  readonly onReady?: () => void
  readonly readPathAttachment?: (path: string) => Promise<ReadAttachment>
  readonly report?: (message: string) => void
  readonly onBackgroundSettled?: (owner: string, marker: string, result: ComposerDraftAttachment | string) => void
  readonly backgroundBytes?: (owner: string) => number
  readonly displayedOwner?: () => string | undefined
}

interface PromptAttachmentTextarea {
  plainText: string
  readonly editBuffer: {
    getCursorPosition(): { readonly offset: number }
    setCursorByOffset(offset: number): void
  }
  readonly extmarks: {
    registerType(name: string): number
    create(mark: { readonly start: number; readonly end: number; readonly styleId?: number; readonly typeId?: number; readonly virtual?: boolean }): number
    delete(id: number): boolean
    getAllForTypeId(typeId: number): readonly { readonly id: number; readonly start: number; readonly end: number }[]
  }
  deleteRange(startLine: number, startColumn: number, endLine: number, endColumn: number): void
  insertText(text: string): void
  once(event: string, listener: () => void): void
}

interface PromptAttachmentSyntax {
  resolveStyleId(name: string): number | null | undefined
}

interface AttachmentOwnership {
  readonly generation: number
  readonly owner: string | undefined
  readonly target: PromptAttachmentTextarea
}

/** What one append did: how many leading items attached, and what stopped the
 *  first one that did not. `prompt-gone` means the prompt the destination was
 *  captured for was cleared, replaced, or left before the items arrived. */
interface AttachmentAppendResult {
  readonly attached: number
  readonly stopped: "message-size" | "prompt-gone" | null
}

/** Puts attachments into the prompt it was captured for. */
export type AttachmentAppender = (pending: readonly PendingAttachment[]) => AttachmentAppendResult

const promptGone = (attachments: readonly PendingAttachment[]): AttachmentAppendResult =>
  ({ attached: 0, stopped: attachments.length === 0 ? null : "prompt-gone" })

/** The attachments riding in the prompt: a clipboard image pasted with ctrl+v
 *  or by the terminal, or the files `/attach` picked. Each has a marker in the
 *  text, `[Image #1]` or `[File #2 notes.md]`, styled as an extmark; deleting
 *  the marker drops the attachment at submit. */
export function createPromptAttachments(
  syntax: () => PromptAttachmentSyntax,
  foregroundId: () => string | undefined,
  clipboard: Clipboard,
  options: PromptAttachmentOptions = {},
) {
  const [items, setItems] = createSignal<readonly ComposerDraftAttachment[]>([])
  // Imperative attach point: the textarea renderable mounts after this hook
  // runs and owns the extmark state; these locals are the I/O bridge, not
  // reactive state.
  let textarea: PromptAttachmentTextarea | null = null
  let typeId: number | undefined
  let generation = 0
  const pending = new Set<{
    readonly token: { owner: string | undefined; marker: string; active: boolean }
    readonly done: Promise<boolean>
  }>()

  function activeItems(text = textarea?.plainText ?? ""): readonly ComposerDraftAttachment[] {
    return items().filter((item) => text.includes(item.marker)).sort((left, right) => text.indexOf(left.marker) - text.indexOf(right.marker))
  }

  function syncExtmarks(): void {
    const target = textarea
    if (!target || typeId === undefined) return
    for (const extmark of target.extmarks.getAllForTypeId(typeId)) target.extmarks.delete(extmark.id)
    const styleId = syntax().resolveStyleId("extmark.image") ?? undefined
    const text = target.plainText ?? ""
    const markers = [...activeItems(text).map((item) => item.marker), ...[...pending].filter((item) => item.token.owner === untrack(foregroundId)).map((item) => item.token.marker)]
    for (const marker of markers) {
      let start = text.indexOf(marker)
      while (start >= 0) {
        target.extmarks.create({ start, end: start + marker.length, typeId, virtual: true, ...(styleId !== undefined ? { styleId } : {}) })
        start = text.indexOf(marker, start + marker.length)
      }
    }
  }

  function detach(target: PromptAttachmentTextarea): void {
    if (textarea !== target) return
    generation += 1
    textarea = null
    typeId = undefined
  }

  function attach(nextTextarea: PromptAttachmentTextarea): void {
    generation += 1
    textarea = nextTextarea
    typeId = nextTextarea.extmarks.registerType("image")
    nextTextarea.once(RenderableEvents.DESTROYED, () => detach(nextTextarea))
    syncExtmarks()
  }

  function restore(next: readonly ComposerDraftAttachment[]): void {
    generation += 1
    setItems(next)
    syncExtmarks()
  }

  function append(item: PendingAttachment, place?: (marker: string) => boolean): boolean {
    const target = textarea
    if (!target) return false
    const text = target.plainText ?? ""
    const kind = isImageAttachment(item) ? "image" : "text"
    // Numbered past every marker this draft has held, so a marker the person
    // deleted is never reused for a different file.
    const marker = attachmentMarker(kind, nextAttachmentOrdinal([...items().map((entry) => entry.marker), ...[...pending].filter((entry) => entry.token.owner === untrack(foregroundId)).map((entry) => entry.token.marker)]), kind === "text" ? item.name : undefined)
    if (place) {
      if (!place(marker)) return false
    } else {
      const prefix = text.length > 0 && !/\s$/.test(text) ? " " : ""
      target.insertText(`${prefix}${marker}`)
    }
    setItems([...items(), { marker, mediaType: item.mediaType, data: item.data, ...(item.name === undefined ? {} : { name: item.name }) }])
    syncExtmarks()
    return true
  }

  /** Appends in order until the message's byte budget is reached or the
   *  prompt is gone; answers how many attached and what stopped the rest. */
  function appendAll(attachments: readonly PendingAttachment[]): AttachmentAppendResult {
    let bytes = activeItems().reduce((sum, item) => sum + base64ByteLength(item.data), 0)
    let attached = 0
    for (const item of attachments) {
      bytes += base64ByteLength(item.data)
      if (bytes > ATTACHMENT_LIMITS.messageMaxBytes) return { attached, stopped: "message-size" }
      if (!append(item)) return { attached, stopped: "prompt-gone" }
      attached += 1
    }
    return { attached, stopped: null }
  }

  function appendOne(item: PendingAttachment, place?: (marker: string) => boolean): boolean {
    const bytes = base64ByteLength(item.data)
    const limitBytes = isImageAttachment(item) ? ATTACHMENT_LIMITS.imageMaxBytes : ATTACHMENT_LIMITS.textMaxBytes
    if (bytes > limitBytes) {
      options.report?.(attachmentRefusalMessage(item.name ?? "The file", { reason: "size", limitBytes }))
      return false
    }
    const currentBytes = activeItems().reduce((sum, entry) => sum + base64ByteLength(entry.data), 0)
    if (currentBytes + bytes > ATTACHMENT_LIMITS.messageMaxBytes) {
      options.report?.(attachmentRefusalMessage(item.name ?? "The image", { reason: "message-size", limitBytes: ATTACHMENT_LIMITS.messageMaxBytes }))
      return false
    }
    return append(item, place)
  }

  function captureOwnership(): AttachmentOwnership | undefined {
    const target = textarea
    return target ? { generation, owner: untrack(foregroundId), target } : undefined
  }

  function stillOwns(ownership: AttachmentOwnership): boolean {
    return generation === ownership.generation && textarea === ownership.target && untrack(foregroundId) === ownership.owner
  }

  function coordinates(text: string, offset: number) {
    let line = 0
    let lineStart = 0
    for (let index = 0; index < offset; index += 1) {
      if (text.charCodeAt(index) === 10) {
        line += 1
        lineStart = index + 1
      }
    }
    return { line, column: offset - lineStart }
  }

  // Sinks captured while a submission runs; they bind when it ends.
  let submissionCaptures: Array<() => void> | undefined

  function captureAppender(): AttachmentAppender | undefined {
    const captures = submissionCaptures
    if (!captures) return captureDraftAppender()
    if (!textarea) return undefined
    let bound: AttachmentAppender | undefined
    captures.push(() => { bound = captureDraftAppender() })
    return (attachments) => bound?.(attachments) ?? promptGone(attachments)
  }

  /** Runs one submission: `send`, then `afterSend` with its result, which
   *  clears the submitted draft. A command the submission runs, such as
   *  `/attach`, captures its sink before that clear; the sink belongs to the
   *  draft that follows, so it binds once `afterSend` returns. */
  function submit<T>(send: () => T, afterSend: (result: T) => void): void {
    const captures: Array<() => void> = []
    submissionCaptures = captures
    try {
      afterSend(send())
    } finally {
      submissionCaptures = undefined
      for (const bind of captures) bind()
    }
  }

  function captureDraftAppender(): AttachmentAppender | undefined {
    const ownership = captureOwnership()
    if (!ownership) return undefined
    return (attachments) => untrack(() => {
      if (!stillOwns(ownership)) return promptGone(attachments)
      const result = appendAll(attachments)
      if (result.attached > 0) options.onChange?.()
      return result
    })
  }

  function replaceMarker(target: PromptAttachmentTextarea, marker: string, replacement: string): void {
    const at = target.plainText.indexOf(marker)
    if (at < 0) return
    const before = target.plainText
    const cursor = target.editBuffer.getCursorPosition().offset
    const start = coordinates(before, at)
    const end = coordinates(before, at + marker.length)
    target.deleteRange(start.line, start.column, end.line, end.column)
    target.editBuffer.setCursorByOffset(at)
    target.insertText(replacement)
    target.editBuffer.setCursorByOffset(cursor >= at + marker.length
      ? cursor + replacement.length - marker.length
      : cursor <= at ? cursor : at + replacement.length)
  }

  function settle(owner: string | undefined, marker: string, result: ComposerDraftAttachment | string): void {
    const displayedOwner = options.displayedOwner ? options.displayedOwner() : untrack(foregroundId)
    if (displayedOwner === owner && textarea?.plainText.includes(marker)) {
      if (typeof result === "string") replaceMarker(textarea, marker, result)
      else setItems([...items(), result])
      if (untrack(foregroundId) === owner) {
        if (typeof result === "string") options.onChange?.()
        else options.onReady?.()
      } else if (owner) options.onBackgroundSettled?.(owner, marker, result)
    } else if (owner) {
      options.onBackgroundSettled?.(owner, marker, result)
    }
  }

  async function attachPastedPath(paste: { paths: readonly string[]; text: string }, token: { owner: string | undefined; marker: string; active: boolean }): Promise<boolean> {
    let name = basename(paste.paths.find((path) => IMAGE_PATH.test(path)) ?? paste.text)
    try {
      const path = await (options.findImagePath ?? findImagePath)(paste.paths)
      if (!token.active) return false
      if (!path) {
        options.report?.(`Could not attach ${name}. This path is not a readable image file. The path remains in the draft.`)
        settle(token.owner, token.marker, paste.text)
        return false
      }
      name = basename(path)
      const read = await (options.readPathAttachment ?? ((targetPath) => readFileAttachment(targetPath, resizeImage)))(path)
      if (!token.active) return false
      if ("refusal" in read) {
        options.report?.(attachmentRefusalMessage(basename(path), read.refusal))
        settle(token.owner, token.marker, paste.text)
        return false
      }
      const item = read.attachment
      const bytes = base64ByteLength(item.data)
      const currentBytes = untrack(foregroundId) === token.owner
        ? activeItems().reduce((sum, entry) => sum + base64ByteLength(entry.data), 0)
        : token.owner ? options.backgroundBytes?.(token.owner) ?? 0 : 0
      if (!isImageAttachment(item)) {
        options.report?.(attachmentRefusalMessage(basename(path), { reason: "kind", mediaType: item.mediaType }))
        settle(token.owner, token.marker, paste.text)
        return false
      }
      if (bytes > ATTACHMENT_LIMITS.imageMaxBytes || currentBytes + bytes > ATTACHMENT_LIMITS.messageMaxBytes) {
        options.report?.(attachmentRefusalMessage(basename(path), bytes > ATTACHMENT_LIMITS.imageMaxBytes
          ? { reason: "size", limitBytes: ATTACHMENT_LIMITS.imageMaxBytes }
          : { reason: "message-size", limitBytes: ATTACHMENT_LIMITS.messageMaxBytes }))
        settle(token.owner, token.marker, paste.text)
        return false
      }
      settle(token.owner, token.marker, { marker: token.marker, mediaType: item.mediaType, data: item.data, ...(item.name === undefined ? {} : { name: item.name }) })
      return true
    } catch {
      if (!token.active) return false
      options.report?.(`Could not attach ${name}. The file is no longer readable. The path remains in the draft.`)
      settle(token.owner, token.marker, paste.text)
      return false
    }
  }

  function handlePaste(event: PasteEvent): boolean {
    const item = attachmentFromPaste(event)
    if (item) {
      event.preventDefault()
      appendOne(item)
      return true
    }
    return false
  }

  /** Reserves an image marker synchronously for each syntactic absolute image
   *  path in the paste; other paths and separators stay as text. */
  function claimPasteText(text: string): boolean {
    const ownership = captureOwnership()
    if (!ownership) return false
    const cwd = options.cwd ?? process.cwd()
    const parts = pasteParts(text, cwd).map((part, index) => {
      const paste = index % 2 === 1 ? pathText(part, cwd) : undefined
      return paste?.paths.some((path) => IMAGE_PATH.test(path)) ? paste : part
    })
    if (parts.every((part) => typeof part === "string")) return false
    let inserted = ""
    for (const part of parts) {
      if (typeof part === "string") {
        inserted += part
        continue
      }
      const marker = attachmentMarker("image", nextAttachmentOrdinal([...items().map((item) => item.marker), ...[...pending].filter((item) => item.token.owner === ownership.owner).map((item) => item.token.marker)]))
      const token = { owner: ownership.owner, marker, active: true }
      const entry = { token, done: attachPastedPath(part, token) }
      pending.add(entry)
      void entry.done.finally(() => untrack(() => { pending.delete(entry); syncExtmarks() }))
      inserted += marker
    }
    ownership.target.insertText(inserted)
    options.onChange?.()
    return true
  }

  function hasPending(text: string, owner: string | undefined): boolean {
    return [...pending].some((entry) => entry.token.owner === owner && text.includes(entry.token.marker))
  }

  /** Moves unresolved markers with their draft when a new chat receives a session ID. */
  function adoptPending(from: string | undefined, to: string, occupiedMarkers: readonly string[]): ReadonlyMap<string, string> {
    const occupied = new Set([...occupiedMarkers, ...[...pending]
      .filter((entry) => entry.token.owner === to && entry.token.owner !== from)
      .map((entry) => entry.token.marker)])
    const renames = new Map<string, string>()
    const moving = [...pending].filter((entry) => entry.token.owner === from)
    for (const entry of moving) {
      const old = entry.token.marker
      const marker = occupied.has(old)
        ? attachmentMarker("image", nextAttachmentOrdinal([...occupied, ...moving.map((item) => item.token.marker)]))
        : old
      entry.token.owner = to
      entry.token.marker = marker
      occupied.add(marker)
      if (marker !== old) renames.set(old, marker)
    }
    return renames
  }

  /** Waits for only the markers in this captured draft, without admitting an unresolved or failed image. */
  async function prepareSubmission(text: string, owner: string | undefined): Promise<ChatInput | undefined> {
    const captured = [...pending].filter((entry) => entry.token.owner === owner && text.includes(entry.token.marker))
    if ((await Promise.all(captured.map((entry) => entry.done))).some((ok) => !ok)) return undefined
    return toSubmission(text)
  }

  /** The captured owner, textarea, and draft generation identify the prompt
   *  that requested the clipboard read. */
  async function pasteFromClipboard(owner: string | undefined): Promise<boolean> {
    const ownership = captureOwnership()
    if (!ownership || ownership.owner !== owner) return false
    const image = await clipboard.readImage()
    if (!image || !stillOwns(ownership)) return false
    return appendOne(image)
  }

  function toSubmission(text: string): ChatInput {
    const current = activeItems(text)
    return normalizeChatInput(current.length > 0 ? { text, attachments: current } : text)
  }

  function clear(): void {
    invalidateClaims()
    generation += 1
    setItems([])
    syncExtmarks()
  }

  function invalidateClaims(): void {
    for (const entry of pending) {
      if (entry.token.owner !== untrack(foregroundId)) continue
      entry.token.active = false
      pending.delete(entry)
    }
    generation += 1
  }

  function reconcilePendingMarkers(): void {
    if (!textarea) return
    const owner = options.displayedOwner ? options.displayedOwner() : untrack(foregroundId)
    for (const entry of pending) {
      if (entry.token.owner === owner && !textarea.plainText.includes(entry.token.marker)) entry.token.active = false
    }
  }

  return {
    attach,
    adoptPending,
    appendAll,
    captureAppender,
    clear,
    claimPasteText,
    handlePaste,
    hasPending,
    invalidateClaims,
    pasteFromClipboard,
    prepareSubmission,
    reconcilePendingMarkers,
    restore,
    serialize: activeItems,
    submit,
    syncExtmarks,
    toSubmission,
  }
}
