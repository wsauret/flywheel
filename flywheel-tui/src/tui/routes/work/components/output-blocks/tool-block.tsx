/** @jsxImportSource @opentui/solid */
/**
 * ToolBlock Component
 *
 * Renders a standalone tool invocation. Two modes:
 *
 * 1. Compact single-line (default):
 *    ✎ Edit  src/app.ts
 *
 * 2. Expanded with inline diff (when block.diff is present):
 *    ✎ Edit  src/app.ts
 *      1 -old code
 *      1 +new code
 *
 * Diff rendering uses Claude Code's color-diff algorithm: word-level
 * highlighting within changed lines, colored backgrounds, line numbers.
 *
 * Diffs default to expanded and can be collapsed by clicking the header.
 * Uses CollapsibleBox to keep the container stable in the layout tree.
 */

import { createSignal, createMemo, Show, For } from "solid-js"
import { createTextAttributes, StyledText, fg as stFg, bg as stBg, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { isHandoffPath } from "@tui/utils/text"
import type { ToolBlock as ToolBlockType } from "@infra/output-blocks"
import { renderHunk } from "@tui/adapters/color-diff"
import { parseUnifiedDiff } from "@tui/adapters/diff-parser"
import { toFileUri } from "@tui/adapters/linkify-paths"

const TOOL_DISPLAY_NAMES = new Map<string, string>([
  ["grep", "Text Search"], ["glob", "File Search"], ["websearch", "Web Search"],
  ["webfetch", "Web Fetch"], ["notebookedit", "Notebook Edit"], ["powershell", "PowerShell"],
  ["repl", "REPL"], ["todowrite", "Task Update"], ["agent", "Subagent"], ["task", "Subagent"],
  ["toolsearch", "Tool Search"], ["sendmessage", "Send Message"], ["askuserquestion", "Ask User"],
  ["enterplanmode", "Enter Plan Mode"], ["exitplanmode", "Exit Plan Mode"],
  ["enterworktree", "Enter Worktree"], ["exitworktree", "Exit Worktree"],
  ["bash", "Bash"], ["read", "Read"], ["write", "Write"], ["edit", "Edit"],
  ["lsp", "LSP"], ["skill", "Skill"], ["remotetrigger", "Remote Trigger"],
])

export function displayToolName(name: string): string {
  const lower = name.toLowerCase()
  const mapped = TOOL_DISPLAY_NAMES.get(lower)
  if (mapped) return mapped
  if (lower.startsWith("schedulecron") || lower.startsWith("cron")) return "Cron"
  if (name.startsWith("mcp__")) return `MCP ${name.slice(5).split("__")[0]}`
  return name
}

const BOLD = createTextAttributes({ bold: true })

export interface ToolBlockProps {
  block: ToolBlockType
}

export function ToolBlock(props: ToolBlockProps) {
  const { theme } = useTheme()
  const name = () => displayToolName(props.block.name)

  // Diff/content rendering state — defaults open, user can collapse
  const hasDiff = () => !!props.block.diff
  const hasContent = () => !!props.block.content
  const hasExpandable = () => hasDiff() || hasContent()

  // Handoff docs are workflow-internal; collapse by default so users aren't flooded with content
  const [expanded, setExpanded] = createSignal(!isHandoffPath(props.block.filePath))

  // Map TUI theme → diff theme colors (RGBA passthrough, no conversion)
  const diffColors = createMemo(() => ({
    text: theme.text,
    textMuted: theme.textMuted,
    addedBg: theme.diffAddedBg,
    removedBg: theme.diffRemovedBg,
    highlightAdded: theme.diffHighlightAdded,
    highlightRemoved: theme.diffHighlightRemoved,
    addedFg: theme.diffAddedFg,
    removedFg: theme.diffRemovedFg,
    lineNumber: theme.diffLineNumber,
  }))

  // Render diff hunks → DiffLines → StyledText (RGBA passed directly to fg/bg builders)
  const diffStyledLines = createMemo(() => {
    if (!props.block.diff) return []
    const hunks = parseUnifiedDiff(props.block.diff)
    const lines = hunks.flatMap((hunk) => renderHunk(hunk, diffColors()))
    return lines.map((line) => {
      const chunks: TextChunk[] = line.segments.map((seg) => {
        let c: string | TextChunk = seg.text
        if (seg.fg) c = stFg(seg.fg)(c)
        if (seg.bg) c = stBg(seg.bg)(c)
        return c as TextChunk
      })
      return { styled: new StyledText(chunks), lineBg: line.lineBg }
    })
  })

  // Split Write content into lines for plain-text rendering
  const contentLines = createMemo(() => {
    if (!props.block.content) return []
    return props.block.content.split("\n")
  })

  // Header line (shared between compact and expanded modes)
  const header = () => (
    <box flexDirection="row" gap={1} overflow="hidden" onMouseDown={hasExpandable() ? () => setExpanded(prev => !prev) : undefined}>
      <text fg={theme.text} flexShrink={0} attributes={BOLD}>{name()}</text>
      <Show when={props.block.filePath} fallback={
        <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">{props.block.detail}</text>
      }>
        <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none"><a href={toFileUri(props.block.filePath!)}>{props.block.detail}</a></text>
      </Show>
      <Show when={hasExpandable()}>
        <text fg={theme.textMuted} flexShrink={0}>{expanded() ? "▾" : "▸"}</text>
      </Show>
    </box>
  )

  return (
    <Show when={hasExpandable()} fallback={<box marginTop={1}>{header()}</box>}>
      <box flexDirection="column" marginTop={1}>
        {header()}
        <CollapsibleBox expanded={expanded()} paddingTop={1} paddingBottom={1} paddingLeft={4} paddingRight={4}>
          <Show when={hasDiff()}>
            <For each={diffStyledLines()}>
              {(line) => (
                <box width="100%" backgroundColor={line.lineBg} paddingLeft={4} paddingRight={4}>
                  <text ref={(el: TextRenderable) => { el.content = line.styled }} />
                </box>
              )}
            </For>
          </Show>
          <Show when={hasContent()}>
            <For each={contentLines()}>
              {(line) => (
                <box paddingLeft={4} paddingRight={4}>
                  <text fg={theme.text}>{line}</text>
                </box>
              )}
            </For>
          </Show>
        </CollapsibleBox>
      </box>
    </Show>
  )
}
