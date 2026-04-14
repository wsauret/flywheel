/** Adds OSC 8 file:// hyperlinks to TextChunks that look like file paths. */

import * as path from "node:path"
import type { TextChunk } from "@opentui/core"

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

export function toFileUri(filePath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  return `file://${resolved}`
}

export function linkifyFilePaths(chunks: TextChunk[]): TextChunk[] {
  return chunks.map((chunk) => {
    if (chunk.link) return chunk
    if (isFilePath(chunk.text)) {
      return { ...chunk, link: { url: toFileUri(chunk.text.trim()) } }
    }
    return chunk
  })
}
