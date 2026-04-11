export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export function parseUnifiedDiff(diffStr: string): Hunk[] {
  const lines = diffStr.split("\n")
  const hunks: Hunk[] = []
  let current: Hunk | null = null

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      if (current) hunks.push(current)
      current = {
        oldStart: parseInt(hunkMatch[1]!, 10),
        oldLines: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: parseInt(hunkMatch[3]!, 10),
        newLines: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      }
      continue
    }
    if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line)
    }
  }
  if (current) hunks.push(current)
  return hunks
}
