/**
 * Path security utility — validates that a file path resolves within a boundary directory.
 *
 * Prevents path traversal attacks (e.g. `../../etc/passwd`) by resolving
 * both the file path and the boundary to their real (canonical) paths
 * before performing the boundary check.
 */

import { resolve, sep, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether `filePath` resolves to a location within (or equal to) `boundary`.
 *
 * - Resolves both paths with `path.resolve()` (handles relative paths and `..`)
 * - Attempts `realpathSync()` to follow symlinks; falls back to `resolve()` if
 *   the path does not exist on disk yet
 * - Uses a directory separator–aware prefix check to avoid false positives
 *   (e.g. `/tmp/abc` should NOT match `/tmp/abcdef`)
 *
 * @param filePath  - The path to check (absolute or relative)
 * @param boundary  - The boundary directory that must contain the path
 * @returns `true` if the resolved filePath is within or equal to the resolved boundary
 */
export function isPathWithinBoundary(
  filePath: string,
  boundary: string,
): boolean {
  const resolvedBoundary = realOrResolved(boundary);
  const resolvedPath = realOrResolved(filePath);

  // Exact match
  if (resolvedPath === resolvedBoundary) return true;

  // Ensure boundary ends with separator for prefix check
  const boundaryPrefix = resolvedBoundary.endsWith(sep)
    ? resolvedBoundary
    : resolvedBoundary + sep;

  return resolvedPath.startsWith(boundaryPrefix);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Resolve a path to its canonical form, following symlinks where possible.
 *
 * If the full path doesn't exist, walks up to find the nearest existing
 * ancestor, resolves that via realpathSync, then re-appends the remaining
 * segments. This ensures consistent resolution even when the file doesn't
 * exist yet (e.g. on macOS where /var → /private/var).
 */
function realOrResolved(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    // Walk up to find the nearest existing ancestor
    const segments: string[] = [];
    let current = resolved;
    while (current !== dirname(current)) {
      try {
        const realParent = realpathSync(current);
        // Re-append the collected segments
        let result = realParent;
        for (let i = segments.length - 1; i >= 0; i--) {
          result = result + sep + segments[i];
        }
        return result;
      } catch {
        segments.push(basename(current));
        current = dirname(current);
      }
    }
    // Fallback: no ancestor could be resolved (shouldn't happen on real systems)
    return resolved;
  }
}
