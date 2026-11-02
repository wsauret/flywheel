export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type ParsedHunks = {
  readonly hunks: Hunk[]
  /** Hunk content lines in the whole patch, materialized or not, so a bounded
   *  parse still states the exact size of what it did not build. */
  readonly renderedLines: number
}

export type TypedDiffRow = {
  readonly id: string
  readonly kind: "add" | "remove" | "context"
  readonly text: string
  readonly partial: boolean
  readonly oldLine?: number
  readonly newLine?: number
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const AT_SIGN = 64
const PLUS = 43
const MINUS = 45
const SPACE = 32

/** The hunks of one unified patch, materialized up to `limit` content lines.
 *  Lines past the limit are counted and never built, so a collapsed preview pays
 *  for the lines it draws instead of the whole patch. Pass
 *  `Number.POSITIVE_INFINITY` for the whole patch.
 *
 *  Structural lines (file headers, `@@` headers) are not content: the renderer
 *  draws neither, so neither is counted. */
export function parseUnifiedDiff(diffStr: string, limit: number): ParsedHunks {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  let inHunk = false
  let renderedLines = 0
  for (let start = 0; start <= diffStr.length; ) {
    const newline = diffStr.indexOf("\n", start)
    const end = newline === -1 ? diffStr.length : newline
    const marker = diffStr.charCodeAt(start)
    const header = marker === AT_SIGN ? HUNK_HEADER_RE.exec(diffStr.slice(start, end)) : null
    // Groups 1 and 3 (`(\d+)`) are non-optional, so a match always defines
    // oldStart/newStart; guarding narrows them to string without a non-null assertion.
    const [, oldStart, oldLines, newStart, newLines] = header ?? []
    if (oldStart !== undefined && newStart !== undefined) {
      inHunk = true
      if (current) hunks.push(current)
      current = renderedLines < limit
        ? {
          oldStart: Number.parseInt(oldStart, 10),
          oldLines: Number.parseInt(oldLines ?? "1", 10),
          newStart: Number.parseInt(newStart, 10),
          newLines: Number.parseInt(newLines ?? "1", 10),
          lines: [],
        }
        : undefined
    } else if (inHunk && (marker === PLUS || marker === MINUS || marker === SPACE)) {
      renderedLines += 1
      if (current && renderedLines <= limit) current.lines.push(diffStr.slice(start, end))
    }
    if (newline === -1) break
    start = newline + 1
  }
  if (current) hunks.push(current)
  return { hunks, renderedLines }
}
