import { createSignal } from "solid-js"

import type { ProtocolChatAttachment } from "../../../src/protocol/app-service-types.js"
import {
  ACCEPTED_IMAGE_TYPES, ATTACHMENT_LIMITS, attachmentKind, attachmentMarker, attachmentRefusalMessage, base64ByteLength, bytesToBase64, decodeUtf8Text,
  nextAttachmentOrdinal, type AttachmentKind, type AttachmentRefusal,
} from "../../../src/protocol/client/attachments.js"

/** An attachment waiting in the composer, with what its chip shows. */
export interface ComposerAttachment extends ProtocolChatAttachment {
  readonly kind: AttachmentKind
  /** Encoded size, the cost the message carries. */
  readonly bytes: number
  /** A data URL for an image chip's thumbnail. */
  readonly preview?: string
}

type Prepared = { readonly attachment: ComposerAttachment } | { readonly refusal: AttachmentRefusal }

/** A message as it leaves the composer: its words with one marker per
 *  attachment, and the attachments without their chip-only fields. */
export interface AttachedMessage {
  readonly text: string
  readonly attachments: readonly ProtocolChatAttachment[]
}

/** Re-encode steps when an image is over its limits, from the read tool's own
 *  cascade: fit the longest edge first, then trade quality, then size. */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4] as const
const SCALE_STEPS = [1, 0.75, 0.5, 0.35, 0.25] as const

/** The files a person attaches to the next message, from the chooser, a
 *  paste, or a drop. Each is read and bounded here, in the browser, so the
 *  message that leaves is already within what the runtime and the relay
 *  carry; a file that cannot be attached is reported in words and skipped. */
export function createComposerAttachments(report: (message: string) => void) {
  const [items, setItems] = createSignal<readonly ComposerAttachment[]>([])
  const pending = new Set<Promise<void>>()

  async function prepare(files: Iterable<File>): Promise<void> {
    for (const file of files) {
      const current = items()
      const ordinal = nextAttachmentOrdinal(current.map((item) => item.marker))
      const budget = ATTACHMENT_LIMITS.messageMaxBytes - current.reduce((sum, item) => sum + item.bytes, 0)
      const prepared = await prepareAttachment(file, ordinal, budget)
      if ("refusal" in prepared) {
        report(attachmentRefusalMessage(file.name || "The file", prepared.refusal))
        continue
      }
      setItems([...items(), prepared.attachment])
    }
  }

  return {
    items,
    add(files: Iterable<File>): Promise<void> {
      const work = prepare(files)
      pending.add(work)
      void work.then(() => { pending.delete(work) }, () => { pending.delete(work) })
      return work
    },
    async settled(): Promise<void> {
      while (pending.size > 0) await Promise.all(pending)
    },
    /** Hydration preserves prepared bytes and marker identity, unlike recall. */
    adopt(attachments: readonly ProtocolChatAttachment[]): void {
      setItems(attachments.map((attachment) => {
        const kind = attachmentKind(attachment.mediaType, attachment.name ?? "")
        if (kind === undefined) throw new Error("Cannot restore an unsupported prepared attachment")
        return { ...attachment, kind, bytes: base64ByteLength(attachment.data), ...(kind === "image" ? { preview: `data:${attachment.mediaType};base64,${attachment.data}` } : {}) }
      }))
    },
    remove(marker: string): void {
      setItems(items().filter((item) => item.marker !== marker))
    },
    /** Adds a recalled message's files back as chips after any already here,
     *  numbered after them, and answers its words without the marker line
     *  `toInput` added. */
    restore(message: AttachedMessage): string {
      const restored = [...items()]
      for (const attachment of message.attachments) {
        const kind = attachmentKind(attachment.mediaType, attachment.name ?? "")
        if (kind === undefined) continue
        const marker = attachmentMarker(kind, nextAttachmentOrdinal(restored.map((item) => item.marker)), attachment.name)
        const preview = kind === "image" ? { preview: `data:${attachment.mediaType};base64,${attachment.data}` } : {}
        restored.push({ ...attachment, marker, kind, bytes: base64ByteLength(attachment.data), ...preview })
      }
      setItems(restored)
      const markers = message.attachments.map((attachment) => attachment.marker).join(" ")
      if (markers.length === 0) return message.text
      if (message.text === markers) return ""
      return message.text.endsWith(`\n${markers}`) ? message.text.slice(0, -markers.length - 1) : message.text
    },
    /** The text, then one marker per attachment on its own line. */
    toInput(text: string): AttachedMessage {
      const current = items()
      const markers = current.map((item) => item.marker).join(" ")
      return {
        text: current.length === 0 ? text : text.length === 0 ? markers : `${text}\n${markers}`,
        attachments: current.map(({ marker, mediaType, data, name }) => ({ marker, mediaType, data, ...(name === undefined ? {} : { name }) })),
      }
    },
  }
}

/** Reads one file into an attachment within the limits, or says why not. */
async function prepareAttachment(file: File, ordinal: number, budgetBytes: number): Promise<Prepared> {
  const kind = attachmentKind(file.type, file.name)
  if (kind === undefined) return { refusal: { reason: "kind", mediaType: file.type } }
  const prepared = kind === "image" ? await prepareImage(file, ordinal) : await prepareText(file, ordinal)
  if ("refusal" in prepared) return prepared
  if (prepared.attachment.bytes > budgetBytes) return { refusal: { reason: "message-size", limitBytes: ATTACHMENT_LIMITS.messageMaxBytes } }
  return prepared
}

async function prepareText(file: File, ordinal: number): Promise<Prepared> {
  if (file.size > ATTACHMENT_LIMITS.textMaxBytes) return { refusal: { reason: "size", limitBytes: ATTACHMENT_LIMITS.textMaxBytes } }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (decodeUtf8Text(bytes) === undefined) return { refusal: { reason: "unreadable" } }
  const data = bytesToBase64(bytes)
  const name = file.name || undefined
  return {
    attachment: {
      kind: "text",
      marker: attachmentMarker("text", ordinal, name),
      mediaType: file.type.split(";", 1)[0] || "text/plain",
      data,
      bytes: base64ByteLength(data),
      ...(name === undefined ? {} : { name }),
    },
  }
}

async function prepareImage(file: File, ordinal: number): Promise<Prepared> {
  const encoded = await boundedImage(file)
  if (encoded === undefined) return { refusal: { reason: "kind", mediaType: file.type } }
  const data = bytesToBase64(new Uint8Array(await encoded.arrayBuffer()))
  const name = file.name || undefined
  return {
    attachment: {
      kind: "image",
      marker: attachmentMarker("image", ordinal),
      mediaType: encoded.type,
      data,
      bytes: base64ByteLength(data),
      preview: `data:${encoded.type};base64,${data}`,
      ...(name === undefined ? {} : { name }),
    },
  }
}

/** The image as the providers take it: an accepted type, within the edge and
 *  byte limits. A file already inside them is sent as it is, so a screenshot
 *  keeps its exact pixels; one outside them is redrawn through a canvas. A
 *  type the browser cannot decode yields nothing. */
async function boundedImage(file: File): Promise<Blob | undefined> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return undefined
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const accepted = ACCEPTED_IMAGE_TYPES.includes(file.type)
    if (accepted && longest <= ATTACHMENT_LIMITS.imageMaxEdge && file.size <= ATTACHMENT_LIMITS.imageMaxBytes) return file
    // GIF animation does not survive a canvas; anything redrawn becomes PNG
    // when it was lossless and JPEG otherwise, so text in a screenshot stays
    // sharp and a photo stays small.
    const lossless = file.type === "image/png" || file.type === "image/gif"
    const fit = Math.min(1, ATTACHMENT_LIMITS.imageMaxEdge / longest)
    for (const scale of SCALE_STEPS) {
      const width = Math.max(1, Math.round(bitmap.width * fit * scale))
      const height = Math.max(1, Math.round(bitmap.height * fit * scale))
      if (lossless) {
        const png = await draw(bitmap, width, height, "image/png")
        if (png !== undefined && png.size <= ATTACHMENT_LIMITS.imageMaxBytes) return png
      }
      for (const quality of QUALITY_STEPS) {
        const jpeg = await draw(bitmap, width, height, "image/jpeg", quality)
        if (jpeg !== undefined && jpeg.size <= ATTACHMENT_LIMITS.imageMaxBytes) return jpeg
      }
    }
    return undefined
  } finally {
    bitmap.close()
  }
}

function draw(bitmap: ImageBitmap, width: number, height: number, type: string, quality?: number): Promise<Blob | undefined> {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) return Promise.resolve(undefined)
  context.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob ?? undefined), type, quality) })
}

/** The files a paste or a drop carries, or none. */
export function transferredFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  if (transfer.files.length > 0) return Array.from(transfer.files)
  const files: File[] = []
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}
