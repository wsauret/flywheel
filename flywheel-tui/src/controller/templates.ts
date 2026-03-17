/**
 * Utility functions for template support.
 *
 * File caching and context file parsing for execution loops.
 * Plan/context files are cached in memory; re-read on mtime change via fs.stat.
 * NOTE: mtime cache is a known TOCTOU limitation (acceptable for sequential execution).
 */

import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// File cache (mtime-based)
// ---------------------------------------------------------------------------

interface CachedFile {
  content: string;
  mtimeMs: number;
}

const fileCache = new Map<string, CachedFile>();

/**
 * Read a file with mtime-based caching.
 * Returns null if the file does not exist.
 */
export function readCachedFile(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const cached = fileCache.get(filePath);

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    fileCache.set(filePath, { content, mtimeMs: stat.mtimeMs });
    return content;
  } catch {
    return null;
  }
}

/**
 * Clear the file cache (for testing).
 */
export function clearFileCache(): void {
  fileCache.clear();
}

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


