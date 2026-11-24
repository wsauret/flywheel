/** A series as one row of block characters: each column is the highest
 *  point that falls in its slice of the range, a column with no point is
 *  left blank, and a column a reset falls in is drawn as a mark, so the
 *  line's drops read as resets the way the web's dashed marks do. */

const LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const
const RESET_MARK = "╎"

export function sparkline(points: readonly { readonly atMs: number; readonly fraction: number }[], resets: readonly number[], startMs: number, endMs: number, width: number): string {
  if (width <= 0) return ""
  const span = Math.max(1, endMs - startMs)
  const column = (atMs: number) => Math.min(width - 1, Math.max(0, Math.floor(((atMs - startMs) / span) * width)))
  const levels: (number | undefined)[] = Array.from({ length: width }, () => undefined)
  for (const point of points) {
    const index = column(point.atMs)
    levels[index] = Math.max(levels[index] ?? 0, point.fraction)
  }
  const marked = new Set(resets.map(column))
  return levels.map((level, index) => {
    if (marked.has(index) && level === undefined) return RESET_MARK
    if (level === undefined) return " "
    return LEVELS[Math.min(LEVELS.length - 1, Math.round(level * (LEVELS.length - 1)))]
  }).join("")
}
