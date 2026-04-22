import { classifyTool } from "@infra/tool-display-registry.js"
import type { ToolEntry } from "@infra/output-blocks"

export function toolsGroupLabel(active: boolean): string {
  return active ? "Exploring..." : "Explored"
}

/**
 * Produces a verb-explicit summary string for a tool group.
 *
 * Four bins by category + filePath presence:
 *   exploration + filePath  → "read N files"
 *   exploration + no path   → "N searches"
 *   mutation + filePath      → "edited N files"  (agent children only)
 *   execution                → "N commands"
 *
 * Examples:
 *   [read, read, glob]        → "read 1 file · 1 search"
 *   [bash, bash]              → "2 commands"
 *   [read, edit(/a.ts)]       → "read 1 file · edited 1 file"
 *   []                        → ""
 */
export function deriveGroupSummary(children: readonly ToolEntry[]): string {
  if (children.length === 0) return ""

  const readFiles = new Set<string>()
  const editedFiles = new Set<string>()
  let searchCount = 0
  let commandCount = 0

  for (const child of children) {
    if (child.name === "Thinking") continue
    const cat = classifyTool(child.name)
    if (cat === "exploration" && child.filePath) {
      readFiles.add(child.filePath)
    } else if (cat === "exploration") {
      searchCount++
    } else if (cat === "mutation" && child.filePath) {
      editedFiles.add(child.filePath)
    } else if (cat === "execution") {
      commandCount++
    }
  }

  const parts: string[] = []
  const rc = readFiles.size
  if (rc > 0) parts.push(`read ${rc} file${rc === 1 ? "" : "s"}`)
  if (searchCount > 0) parts.push(`${searchCount} search${searchCount === 1 ? "" : "es"}`)
  const ec = editedFiles.size
  if (ec > 0) parts.push(`edited ${ec} file${ec === 1 ? "" : "s"}`)
  if (commandCount > 0) parts.push(`${commandCount} command${commandCount === 1 ? "" : "s"}`)

  if (parts.length > 0) return parts.join(" · ")

  const n = children.filter(c => c.name !== "Thinking").length
  if (n === 0) return ""
  return `${n} operation${n === 1 ? "" : "s"}`
}
