import type { ToolEntry } from "@infra/output-blocks"

type ToolContentRenderTarget = Pick<ToolEntry, "name" | "filePath" | "filetype">

export function shouldRenderToolContentAsMarkdown(target: ToolContentRenderTarget): boolean {
  if (target.name.toLowerCase() !== "write") return false
  const filePath = target.filePath?.trim().toLowerCase()
  if (filePath) return filePath.endsWith(".md")
  return target.filetype?.toLowerCase() === "markdown"
}
