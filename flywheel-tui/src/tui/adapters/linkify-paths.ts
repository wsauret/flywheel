/**
 * File Path Linkifier
 *
 * Post-processes TextChunks from the markdown renderer to add OSC 8
 * hyperlinks for text that looks like a file path. This makes paths
 * Cmd+clickable in terminals that support hyperlinks.
 *
 * Detects patterns like:
 * - src/foo.ts, ./src/foo.ts, ../lib/bar.py
 * - paths with known extensions (.ts, .tsx, .js, .py, .md, etc.)
 *
 * Does NOT modify visual appearance — only adds invisible link metadata.
 */

import * as path from "node:path"
import type { TextChunk } from "@opentui/core"

/**
 * Known file extensions that indicate a chunk is a file path.
 * Kept intentionally broad — false positives are harmless (just adds a non-functional link).
 */
const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyi",
  "rs", "go", "rb", "lua", "c", "cpp", "h", "hpp",
  "java", "kt", "swift", "cs",
  "json", "yaml", "yml", "toml", "xml", "graphql",
  "md", "mdx", "txt", "csv",
  "html", "css", "scss", "less", "sass",
  "sql", "sh", "bash", "zsh", "fish",
  "vue", "svelte",
  "dockerfile", "makefile",
  "env", "gitignore", "editorconfig",
  "lock", "log", "ndjson", "jsonl",
])

/**
 * Match a string that looks like a relative or absolute file path with a known extension.
 * Must contain at least one `/` or start with `./` or `../`.
 */
function isFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false

  // Must look path-like: contain a slash or start with ./ or ../
  if (!trimmed.includes("/") && !trimmed.startsWith("./") && !trimmed.startsWith("../")) return false

  // Extract extension
  const lastDot = trimmed.lastIndexOf(".")
  if (lastDot === -1 || lastDot === trimmed.length - 1) return false
  const ext = trimmed.slice(lastDot + 1).toLowerCase()

  return FILE_EXTENSIONS.has(ext)
}

/**
 * Convert a potentially relative file path to a file:// URI.
 */
function toFileUri(filePath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  return `file://${resolved}`
}

/**
 * Post-process TextChunks to add file:// links on chunks that look like file paths.
 * Chunks that already have a link are left untouched.
 */
export function linkifyFilePaths(chunks: TextChunk[]): TextChunk[] {
  return chunks.map((chunk) => {
    if (chunk.link) return chunk
    if (isFilePath(chunk.text)) {
      return { ...chunk, link: { url: toFileUri(chunk.text.trim()) } }
    }
    return chunk
  })
}
