/**
 * Utility functions for template support.
 *
 * Context file parsing for execution loops.
 */

// ---------------------------------------------------------------------------
// Context file parsing
// ---------------------------------------------------------------------------

/**
 * Extract file references from a `.context.md` file.
 * Expects lines like `- path/to/file.ts` or `- `path/to/file.ts``
 */
export function parseContextFile(content: string): string[] {
  const refs: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      let ref = trimmed.slice(2).trim();
      // Strip backtick wrapping if present
      if (ref.startsWith("`") && ref.endsWith("`")) {
        ref = ref.slice(1, -1);
      }
      if (ref.length > 0) {
        refs.push(ref);
      }
    }
  }
  return refs;
}


