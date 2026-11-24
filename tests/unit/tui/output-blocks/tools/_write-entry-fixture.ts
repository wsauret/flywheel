import type { ToolEntry } from "../../../../../src/infra/output-blocks.js"
import { resolveToolRowPresentation } from "../../../../../src/infra/tools/tool-display-registry.js"

export function writeEntry(content: string, options: { path?: string; filetype?: string } = {}): ToolEntry {
  const path = options.path ?? "example.ts"
  return {
    kind: "tool",
    id: "write-1",
    name: "write",
    presentation: resolveToolRowPresentation("write", { path }, "/workspace").presentation,
    status: "completed",
    content,
    filetype: options.filetype ?? "typescript",
    timestamp: Date.now(),
  }
}
