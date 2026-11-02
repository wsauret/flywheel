import { runToCompletion } from "./task-scheduling.js"

// One evidence policy for every fact writer that records content: byte count
// and sha256 for audit/diff, plus a bounded preview for human inspection.
// Serialization (JSON, tool parts, block arrays) stays with each writer.
const MAX_PREVIEW = 240

/** The characters one unit of contentEvidenceWork hashes: at most 1.5 MiB of
 *  UTF-8, which takes well under a millisecond, so a unit stays far below the
 *  slice budget even for text of many megabytes. */
const HASH_WINDOW_CHARS = 1 << 19

export function previewText(value: string): string {
  return value.length > MAX_PREVIEW ? `${value.slice(0, MAX_PREVIEW)}...` : value
}

export interface ContentEvidence {
  bytes: number
  sha256: string
  preview: string
}

/** Bytes carry no preview, because only text has a human-readable form. */
export function contentEvidence(value: string | Uint8Array): ContentEvidence {
  if (typeof value === "string") return runToCompletion(contentEvidenceWork(value))
  return { bytes: value.byteLength, sha256: new Bun.CryptoHasher("sha256").update(value).digest("hex"), preview: "" }
}

/** The evidence of contentEvidence, measured in bounded units for
 *  runInTaskSlices: the work yields between windows of the text and hashes
 *  each window into one running digest of the whole UTF-8 encoding. */
export function* contentEvidenceWork(value: string): Generator<void, ContentEvidence> {
  const hasher = new Bun.CryptoHasher("sha256")
  let bytes = 0
  for (let start = 0; start < value.length;) {
    if (start > 0) yield
    let end = Math.min(start + HASH_WINDOW_CHARS, value.length)
    // Each half of a surrogate pair encodes alone as U+FFFD, so a window never
    // ends after the high half.
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1
    const window = value.slice(start, end)
    hasher.update(window)
    bytes += Buffer.byteLength(window, "utf8")
    start = end
  }
  return { bytes, sha256: hasher.digest("hex"), preview: previewText(value) }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
