// Walks the line. Outside backticks -> copy through. Inside backticks
// (delimited by N consecutive backticks; close on N consecutive) -> rewrite
// `|` to `\|` unless already escaped.
export function escapePipesInCodespans(line: string): string {
  if (!line.includes("`") || !line.includes("|")) return line
  let out = ""
  let i = 0
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++]
      continue
    }
    const openCount = backtickRunLength(line, i)
    const fence = line.slice(i, i + openCount)
    const closeStart = matchingCodespanEnd(line, i + openCount, openCount)
    if (closeStart === -1) {
      out += fence
      i += openCount
      continue
    }
    out += fence
    out += escapeCodespanPipes(line, i + openCount, closeStart)
    out += fence
    i = closeStart + openCount
  }
  return out
}

function matchingCodespanEnd(line: string, start: number, openCount: number): number {
  let scan = start
  while (scan < line.length) {
    if (line[scan] !== "`") {
      scan++
      continue
    }
    const runLen = backtickRunLength(line, scan)
    if (runLen === openCount) return scan
    scan += runLen
  }
  return -1
}

function backtickRunLength(line: string, start: number): number {
  let length = 0
  while (line[start + length] === "`") length++
  return length
}

function escapeCodespanPipes(line: string, start: number, end: number): string {
  let out = ""
  for (let i = start; i < end; i++) {
    const ch = line[i]
    if (ch !== "|") {
      out += ch
      continue
    }
    out += isEscapedAt(line, i) ? "|" : "\\|"
  }
  return out
}

function isEscapedAt(line: string, index: number): boolean {
  let backslashCount = 0
  while (line[index - 1 - backslashCount] === "\\") backslashCount++
  return backslashCount % 2 === 1
}
