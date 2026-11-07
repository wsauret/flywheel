/** What a client may attach to a message, and how it names one. The terminal
 *  and the web client share this so every client refuses the same files for
 *  the same reasons and writes the same markers into a message. */

export const ATTACHMENT_LIMITS = {
  /** Longest edge an image keeps and the most bytes it keeps before a client
   *  downscales it: the read tool's own limits, so an attached image costs
   *  the model what a read one does. */
  imageMaxEdge: 2000,
  imageMaxBytes: 4.5 * 1024 * 1024,
  textMaxBytes: 1024 * 1024,
  /** Every attachment of one message together, as encoded. The relay closes
   *  a frame past 16 MiB, and a message is one frame. */
  messageMaxBytes: 8 * 1024 * 1024,
} as const

export type AttachmentKind = "image" | "text"

/** The image types every provider conversion sends as they are. A client
 *  re-encodes another image type into one of these, or refuses it. */
export const ACCEPTED_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"]

const TEXT_MEDIA_TYPES = new Set([
  "application/json", "application/ld+json", "application/xml", "application/yaml", "application/x-yaml",
  "application/toml", "application/javascript", "application/typescript", "application/x-sh", "application/sql",
  "application/x-httpd-php", "application/x-python", "application/graphql",
])
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "log",
  "xml", "html", "htm", "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "gql", "proto", "diff",
  "patch", "lock", "gitignore", "editorconfig", "svg",
])

/** The kind a file attaches as, from its declared type and its name, or
 *  nothing when neither says image or text. A browser reports an empty type
 *  for an extension it does not know, so the name decides then; bytes that
 *  then fail to decode as UTF-8 are refused by `decodeUtf8Text`. */
export function attachmentKind(mediaType: string, name: string): AttachmentKind | undefined {
  const type = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("text/") || TEXT_MEDIA_TYPES.has(type)) return "text"
  const dot = name.lastIndexOf(".")
  const extension = dot === -1 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase()
  return TEXT_EXTENSIONS.has(extension) ? "text" : undefined
}

/** The bytes as text, or nothing when they are not UTF-8. */
export function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** The text a message shows where an attachment sits: `[Image #2]`, or
 *  `[File #3 rows.csv]` so a reader of the transcript learns the name. */
export function attachmentMarker(kind: AttachmentKind, ordinal: number, name?: string): string {
  if (kind === "image") return `[Image #${ordinal}]`
  return name === undefined ? `[File #${ordinal}]` : `[File #${ordinal} ${name}]`
}

/** One past the highest numbered marker, so a new attachment never reuses a
 *  number the message already shows. */
export function nextAttachmentOrdinal(markers: readonly string[]): number {
  let highest = 0
  for (const marker of markers) {
    const match = /#(\d+)/.exec(marker)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

export type AttachmentRefusal =
  | { readonly reason: "kind"; readonly mediaType: string }
  | { readonly reason: "unreadable" }
  | { readonly reason: "size"; readonly limitBytes: number }
  | { readonly reason: "message-size"; readonly limitBytes: number }

/** Why a file did not attach, in the words the client shows. Every message
 *  names the file and says what is accepted, so the person knows what to do
 *  instead of only that something went wrong. */
export function attachmentRefusalMessage(name: string, refusal: AttachmentRefusal): string {
  switch (refusal.reason) {
    case "kind": return `Flywheel can attach images and text files. ${name} is ${refusal.mediaType || "of an unknown type"}.`
    case "unreadable": return `Flywheel can attach images and text files. Flywheel could not decode ${name} for attachment.`
    case "size": return `${name} is too large to attach. The limit is ${formatBytes(refusal.limitBytes)}.`
    case "message-size": return `${name} would take this message past ${formatBytes(refusal.limitBytes)} of attachments. Send what is attached first.`
  }
}

/** Human-readable size for a chip: "840 KB", "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

/** Base64 without a Buffer, so the same encoder runs in a browser. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  return btoa(binary)
}

/** How many bytes a base64 string encodes: the size a message carries. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}
