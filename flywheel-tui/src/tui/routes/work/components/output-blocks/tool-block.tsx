/** @jsxImportSource @opentui/solid */
/**
 * ToolBlock Component
 *
 * Renders a standalone tool invocation as a compact single-line entry:
 *   → Read  package.json
 *   $ Bash  npm test
 *   ← Write  output.json
 *   ✎ Edit  src/app.ts
 *   ✱ Grep  "auth middleware"
 *   ◈ WebSearch  query
 */

import { useTheme } from "@tui/shared/context/theme"
import { truncate } from "@tui/utils/text"
import type { ToolBlock as ToolBlockType } from "@tui/types"

/** Map tool names to semantic icons. */
export function getToolIcon(name: string): string {
  const lower = name.toLowerCase()
  // File operations
  if (lower === "read") return "→"
  if (lower === "write") return "←"
  if (lower === "edit") return "✎"
  if (lower === "notebookedit") return "✎"
  // Execution
  if (lower === "bash" || lower === "powershell" || lower === "repl") return "$"
  // Search
  if (lower === "glob" || lower === "grep" || lower === "lsp" || lower === "toolsearch") return "✱"
  // Web
  if (lower === "webfetch" || lower === "websearch") return "◈"
  // Agent/task management
  if (lower === "agent" || lower === "task" || lower === "sendmessage") return "⊕"
  if (lower.startsWith("task")) return "☐" // TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop, TaskOutput
  if (lower === "skill") return "⚙"
  // Mode transitions
  if (lower === "enterplanmode" || lower === "exitplanmode") return "◇"
  if (lower === "enterworktree" || lower === "exitworktree") return "⌥"
  // Scheduling
  if (lower === "remotetrigger" || lower.startsWith("schedulecron") || lower.startsWith("cron")) return "⏱"
  // MCP tools
  if (lower.startsWith("mcp_") || lower.startsWith("mcp__")) return "⊙"
  // User interaction
  if (lower === "askuserquestion") return "?"
  return "▸"
}

/** Normalize tool name for display. */
export function displayToolName(name: string): string {
  const lower = name.toLowerCase()
  if (lower === "grep") return "Text Search"
  if (lower === "glob") return "File Search"
  if (lower === "websearch") return "Web Search"
  if (lower === "webfetch") return "Web Fetch"
  if (lower === "notebookedit") return "Notebook Edit"
  if (lower === "powershell") return "PowerShell"
  if (lower === "repl") return "REPL"
  if (lower === "toolsearch") return "Tool Search"
  if (lower === "sendmessage") return "Send Message"
  if (lower === "askuserquestion") return "Ask User"
  if (lower === "enterplanmode") return "Enter Plan Mode"
  if (lower === "exitplanmode") return "Exit Plan Mode"
  if (lower === "enterworktree") return "Enter Worktree"
  if (lower === "exitworktree") return "Exit Worktree"
  if (lower === "remotetrigger") return "Remote Trigger"
  if (lower.startsWith("schedulecron") || lower.startsWith("cron")) return "Cron"
  // MCP tools: strip prefix, show server + tool name
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__")
    return parts.length >= 2 ? `MCP ${parts[0]}` : `MCP ${parts[0]}`
  }
  return name
}

export interface ToolBlockProps {
  block: ToolBlockType
}

export function ToolBlock(props: ToolBlockProps) {
  const { theme } = useTheme()
  const icon = () => getToolIcon(props.block.name)
  const name = () => displayToolName(props.block.name)

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.textMuted}>{icon()}</text>
      <text fg={theme.text} style={{ bold: true }}>{name()}</text>
      <text fg={theme.textMuted}>{truncate(props.block.detail, 80)}</text>
    </box>
  )
}
