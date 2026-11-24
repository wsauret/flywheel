import { basename } from "node:path"

import type { ImageResizeResult } from "../../orchestration/agent-runtime/tools/image-resize.js"
import { ATTACHMENT_LIMITS, attachmentKind, decodeUtf8Text, type AttachmentRefusal } from "../../protocol/client/attachments.js"

/** An attachment before the prompt gives it a marker: the bytes, their type,
 *  and the file's own name when it had one. A clipboard image has none. */
export interface PendingAttachment {
  readonly mediaType: string
  /** The bytes, base64. */
  readonly data: string
  readonly name?: string
}

export type ReadAttachment = { readonly attachment: PendingAttachment } | { readonly refusal: AttachmentRefusal }

/** Reads one file on this computer into an attachment within the shared
 *  limits, or says why not. An image outside the read tool's limits goes
 *  through the same resize the read tool uses, so an attached image costs
 *  the model what a read one does. */
export async function readFileAttachment(
  path: string,
  resize: (base64: string) => Promise<ImageResizeResult>,
): Promise<ReadAttachment> {
  const file = Bun.file(path)
  const name = basename(path)
  const mediaType = file.type.split(";", 1)[0]?.trim() ?? ""
  const kind = attachmentKind(mediaType, name)
  if (kind === undefined) return { refusal: { reason: "kind", mediaType } }
  if (kind === "text") {
    if (file.size > ATTACHMENT_LIMITS.textMaxBytes) return { refusal: { reason: "size", limitBytes: ATTACHMENT_LIMITS.textMaxBytes } }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (decodeUtf8Text(bytes) === undefined) return { refusal: { reason: "unreadable" } }
    return { attachment: { mediaType: mediaType || "text/plain", data: Buffer.from(bytes).toString("base64"), name } }
  }
  const bytes = Buffer.from(await file.arrayBuffer())
  const base64 = bytes.toString("base64")
  const resized = await resize(base64)
  if (resized.kind === "decoded") return { attachment: { mediaType: resized.mimeType, data: resized.data, name } }
  if (resized.kind === "unreadable") return { refusal: { reason: "unreadable" } }
  return { refusal: { reason: "kind", mediaType } }
}
