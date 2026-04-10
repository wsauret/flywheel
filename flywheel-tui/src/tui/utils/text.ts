/**
 * Shared text utilities for TUI rendering.
 */

/**
 * Truncate text to `maxLen` characters, appending an ellipsis (\u2026) when
 * the text exceeds the limit.
 *
 * For very small maxLen (< 4), hard-slices without an ellipsis to avoid
 * degenerate output.
 */
export function truncate(text: string, maxLen: number): string {
  if (maxLen < 4) return text.slice(0, maxLen)
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "\u2026"
}

/** True when the file path points to a flywheel handoff document. */
export function isHandoffPath(filePath: string | undefined): boolean {
  return !!filePath && /\.flywheel\/sessions\/[^/]+\/handoffs\//.test(filePath)
}
