/**
 * Shared text utilities for TUI rendering.
 */

/** Maximum width (in characters) for a single output block line. */
export const MAX_BLOCK_LINE_LENGTH = 80

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
