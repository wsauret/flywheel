import { createHash } from "node:crypto"

/** One-based inclusive line range. */
export interface LineRange {
  readonly start: number
  readonly end: number
}

type Coverage = "full" | readonly LineRange[]

interface FileReadRecord {
  /** Content hash of the bytes the model saw. Absent when the file was only seen through search matches. */
  readonly sha256: string | undefined
  /** Hash of the last version the model provably saw: a read tool read or a verified publication. A shell read is
   *  inferred from command syntax after the command ran, so it never sets this. */
  readonly verifiedSha256: string | undefined
  readonly coverage: Coverage
  /** Store position when the file was seen, so a later change can be attributed to facts after it. */
  readonly position: number
}

export type FileReadStaleness =
  | { readonly kind: "unread" }
  | { readonly kind: "changed"; readonly sincePosition: number }
  | { readonly kind: "uncovered"; readonly lines: LineRange }

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Maps byte spans in `bytes` to the one-based line range they touch. */
export function lineRangeOfByteSpans(bytes: Uint8Array, spans: readonly { readonly start: number; readonly end: number }[]): LineRange | undefined {
  if (spans.length === 0) return undefined
  const first = Math.min(...spans.map(span => span.start))
  const last = Math.max(...spans.map(span => Math.max(span.start, span.end - 1)))
  // The line of a byte offset is one more than the count of newlines before it.
  let line = 1
  let start: number | undefined
  let end: number | undefined
  for (let offset = 0; offset < bytes.length && offset <= last; offset += 1) {
    if (offset === first) start = line
    if (offset === last) end = line
    if (bytes[offset] === 0x0a) line += 1
  }
  return { start: start ?? line, end: end ?? line }
}

/** What this agent loop has seen of each file. In-memory only: it exists so an edit can tell the model when it
 *  is working from stale or partial evidence, and nothing reads it back after the loop ends. */
export class FileReadLedger {
  readonly #records = new Map<string, FileReadRecord>()

  /** Record a read tool read: visible coverage against the SHA-256 hex digest computed while acquiring the complete
   *  file. */
  recordRead(canonicalPath: string, sha256: string, coverage: Coverage, position: number): void {
    this.#record(canonicalPath, sha256, sha256, coverage, position)
  }

  /** Record a read inferred from a shell command. It informs edit warnings but proves no version to replace. */
  recordInferredRead(canonicalPath: string, sha256: string, coverage: Coverage, position: number): void {
    this.#record(canonicalPath, sha256, this.#records.get(canonicalPath)?.verifiedSha256, coverage, position)
  }

  #record(canonicalPath: string, sha256: string, verifiedSha256: string | undefined, coverage: Coverage, position: number): void {
    const previous = this.#records.get(canonicalPath)
    const merged = coverage === "full" || previous?.coverage === undefined || previous.sha256 !== sha256
      ? coverage
      : mergeCoverage(previous.coverage, coverage)
    this.#records.set(canonicalPath, { sha256, verifiedSha256, coverage: merged, position })
  }

  /** Search matches show lines without proving the whole file, so they extend coverage but carry no hash. */
  recordSeen(canonicalPath: string, lines: readonly LineRange[], position: number): void {
    const previous = this.#records.get(canonicalPath)
    this.#records.set(canonicalPath, {
      sha256: previous?.sha256,
      verifiedSha256: previous?.verifiedSha256,
      coverage: previous ? mergeCoverage(previous.coverage, lines) : lines,
      position: previous?.position ?? position,
    })
  }

  /** A publication this loop verified is as good as a full read of the new content. */
  recordPublished(canonicalPath: string, content: Uint8Array, position: number): void {
    const sha256 = sha256Hex(content)
    this.#records.set(canonicalPath, { sha256, verifiedSha256: sha256, coverage: "full", position })
  }

  forget(canonicalPath: string): void {
    this.#records.delete(canonicalPath)
  }

  staleness(canonicalPath: string, current: Uint8Array, changed?: LineRange): FileReadStaleness | undefined {
    const record = this.#records.get(canonicalPath)
    if (!record) return { kind: "unread" }
    if (record.sha256 !== undefined && record.sha256 !== sha256Hex(current)) return { kind: "changed", sincePosition: record.position }
    if (changed && record.coverage !== "full" && !covers(record.coverage, changed)) return { kind: "uncovered", lines: changed }
    return undefined
  }

  /** Whether this loop provably saw the exact bytes `current` holds, which a whole-file replacement needs. Search
   *  matches and shell reads prove no version, so a path seen only through them counts as unread. */
  versionStaleness(canonicalPath: string, current: Uint8Array): "unread" | "changed" | undefined {
    const sha256 = this.#records.get(canonicalPath)?.verifiedSha256
    if (sha256 === undefined) return "unread"
    return sha256 === sha256Hex(current) ? undefined : "changed"
  }
}

function mergeCoverage(existing: Coverage, added: Coverage): Coverage {
  if (existing === "full" || added === "full") return "full"
  return [...existing, ...added]
}

function covers(ranges: readonly LineRange[], target: LineRange): boolean {
  for (let line = target.start; line <= target.end; line += 1) {
    if (!ranges.some(range => range.start <= line && line <= range.end)) return false
  }
  return true
}
