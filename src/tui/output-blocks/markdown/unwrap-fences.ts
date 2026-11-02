// Strip ``` md ```/``` markdown ``` fences whose body contains a real table,
// so the lexer parses native table syntax instead of a monospace code block.
//
// Conservative: leaves non-markdown fences (`bash`, `rust`, etc.) intact,
// leaves `md` fences without table content intact, and degrades gracefully on
// unclosed fences. Supports blockquoted fences (`> ```markdown\n> | A |\n> ```\n`).

interface Fence {
  marker: string
  len: number
  isBlockquoted: boolean
}

type ActiveFence =
  | { kind: "passthrough"; fence: Fence }
  | { kind: "candidate"; fence: Fence; openingLine: string; contentLines: string[] }

interface FenceLineResult {
  active: ActiveFence | null
  output: string
}

// Strip a trailing newline and up to 3 leading spaces. Returns null when the
// line has 4+ leading spaces (indented code block per CommonMark).
function stripLineIndent(line: string): string | null {
  const body = line.endsWith("\n") ? line.slice(0, -1) : line
  let i = 0
  let column = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === " ") column += 1
    else if (ch === "\t") column += 4
    else break
    if (column >= 4) return null
    i++
  }
  return body.slice(i)
}

// Peel all leading `>` blockquote markers, including a following space.
function stripBlockquotePrefix(line: string): string {
  let rest = line.trimStart()
  while (rest.startsWith(">")) {
    rest = rest.slice(1)
    if (rest.startsWith(" ")) rest = rest.slice(1)
    rest = rest.trimStart()
  }
  return rest
}

// Recognise a fence opener: runs of 3+ backticks or tildes. Input should
// already have leading whitespace and blockquote markers stripped.
function parseFenceMarker(line: string): { marker: string; len: number } | null {
  const first = line[0]
  if (first !== "`" && first !== "~") return null
  let len = 0
  while (len < line.length && line[len] === first) len++
  if (len < 3) return null
  return { marker: first, len }
}

// `md` or `markdown` (case-insensitive) is the only info string we unwrap.
function isMarkdownFenceInfo(line: string, markerLen: number): boolean {
  const info = line.slice(markerLen).trim().split(/\s+/)[0] ?? ""
  return info.toLowerCase() === "md" || info.toLowerCase() === "markdown"
}

// Split a line on unescaped `|` characters. A `\|` is treated as literal.
function splitUnescapedPipe(content: string): string[] {
  const segments: string[] = []
  let start = 0
  let i = 0
  while (i < content.length) {
    if (content[i] === "\\") { i += 2; continue }
    if (content[i] === "|") {
      segments.push(content.slice(start, i))
      start = i + 1
      i += 1
    } else {
      i += 1
    }
  }
  segments.push(content.slice(start))
  return segments
}

// Returns trimmed pipe segments if the line is structurally a table row;
// null otherwise. Uses the same table-segment parsing rule.
function parseTableSegments(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const hasOuterPipe = trimmed.startsWith("|") || trimmed.endsWith("|")
  let content = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed
  content = content.endsWith("|") ? content.slice(0, -1) : content
  const raw = splitUnescapedPipe(content)
  if (!hasOuterPipe && raw.length <= 1) return null
  const segments = raw.map((s) => s.trim())
  return segments.length > 0 ? segments : null
}

function isTableHeaderLine(line: string): boolean {
  const segs = parseTableSegments(line)
  return segs !== null && segs.some((s) => s.length > 0)
}

// `---`, `:---`, `---:`, or `:---:`. Minimum 3 dashes.
function isTableDelimiterSegment(segment: string): boolean {
  const trimmed = segment.trim()
  if (!trimmed) return false
  let s = trimmed.startsWith(":") ? trimmed.slice(1) : trimmed
  s = s.endsWith(":") ? s.slice(0, -1) : s
  return s.length >= 3 && /^-+$/.test(s)
}

function isTableDelimiterLine(line: string): boolean {
  const segs = parseTableSegments(line)
  return segs !== null && segs.every(isTableDelimiterSegment)
}

function parseOpenFence(line: string): { fence: Fence; isMarkdown: boolean } | null {
  const trimmed = stripLineIndent(line)
  if (trimmed === null) return null
  const isBlockquoted = trimmed.trimStart().startsWith(">")
  const scanText = stripBlockquotePrefix(trimmed)
  const marker = parseFenceMarker(scanText)
  if (!marker) return null
  return {
    fence: { marker: marker.marker, len: marker.len, isBlockquoted },
    isMarkdown: isMarkdownFenceInfo(scanText, marker.len),
  }
}

function isCloseFence(line: string, fence: Fence): boolean {
  const trimmed = stripLineIndent(line)
  if (trimmed === null) return false
  let scanText: string
  if (fence.isBlockquoted) {
    if (!trimmed.trimStart().startsWith(">")) return false
    scanText = stripBlockquotePrefix(trimmed)
  } else {
    scanText = trimmed
  }
  const m = parseFenceMarker(scanText)
  if (!m) return false
  return m.marker === fence.marker && m.len >= fence.len && scanText.slice(m.len).trim() === ""
}

// Buffer the entire fence body before deciding: only commit to unwrapping if
// the body contains a header row + delimiter row pair (in that order, with no
// intervening blank line). Mirrors markdown_fence_contains_table.
function fenceContainsTable(contentLines: string[], isBlockquotedFence: boolean): boolean {
  let prev: string | null = null
  for (const raw of contentLines) {
    const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw
    const text = isBlockquotedFence ? stripBlockquotePrefix(line) : line
    const trimmed = text.trim()
    if (!trimmed) { prev = null; continue }
    if (prev !== null
      && isTableHeaderLine(prev)
      && !isTableDelimiterLine(prev)
      && isTableDelimiterLine(trimmed)) return true
    prev = trimmed
  }
  return false
}

// Split source into lines KEEPING trailing newlines (equivalent to Rust's
// split_inclusive('\n')). The final line without a trailing \n is included.
function splitLinesInclusive(source: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      lines.push(source.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < source.length) lines.push(source.slice(start))
  return lines
}

export function unwrapMarkdownFences(source: string): string {
  // Fast path: most messages contain no fences at all.
  if (!source.includes("```") && !source.includes("~~~")) return source

  const lines = splitLinesInclusive(source)
  let out = ""
  let active: ActiveFence | null = null

  for (const line of lines) {
    if (active !== null) {
      const result = handleActiveFenceLine(active, line)
      out += result.output
      active = result.active
      continue
    }

    const result = handleInactiveFenceLine(line)
    out += result.output
    active = result.active
  }

  // Unclosed candidate at EOF: re-emit opener + buffered content so partial
  // streams degrade to code display rather than swallowing content.
  if (active !== null && active.kind === "candidate") {
    out += active.openingLine
    for (const cl of active.contentLines) out += cl
  }

  return out
}

function handleActiveFenceLine(active: ActiveFence, line: string): FenceLineResult {
  if (active.kind === "passthrough") {
    return {
      active: isCloseFence(line, active.fence) ? null : active,
      output: line,
    }
  }
  if (!isCloseFence(line, active.fence)) {
    active.contentLines.push(line)
    return { active, output: "" }
  }
  return {
    active: null,
    output: candidateFenceOutput(active, line),
  }
}

function handleInactiveFenceLine(line: string): FenceLineResult {
  const open = parseOpenFence(line)
  if (open === null) return { active: null, output: line }
  return open.isMarkdown
    ? { active: { kind: "candidate", fence: open.fence, openingLine: line, contentLines: [] }, output: "" }
    : { active: { kind: "passthrough", fence: open.fence }, output: line }
}

function candidateFenceOutput(active: Extract<ActiveFence, { kind: "candidate" }>, closingLine: string): string {
  if (fenceContainsTable(active.contentLines, active.fence.isBlockquoted)) return active.contentLines.join("")
  return active.openingLine + active.contentLines.join("") + closingLine
}
