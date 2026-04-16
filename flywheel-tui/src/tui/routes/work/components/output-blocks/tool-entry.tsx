/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, Show, For } from "solid-js"
import { StyledText, fg as stFg, bg as stBg, type TextChunk } from "@opentui/core"
import { BOLD } from "@tui/shared/ui/text-attributes"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { isHandoffPath } from "@tui/utils/text"
import type { ToolEntry as ToolEntryType } from "@infra/output-blocks"
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


interface ToolEntryProps {
  block: ToolEntryType
}

export function ToolEntry(props: ToolEntryProps) {
  const { theme } = useTheme()
  const name = () => displayToolName(props.block.name)

  const isResolved = () => props.block.completed === true || !!props.block.errorMessage
  const hasError = () => !!props.block.errorMessage
  const hasDiff = () => !!props.block.diff && !hasError()
  const hasContent = () => !!props.block.content && !hasError()
  const hasExpandable = () => hasDiff() || hasContent()

  const [expanded, setExpanded] = createSignal(!isHandoffPath(props.block.filePath))

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

  const contentLines = createMemo(() => {
    if (!props.block.content) return []
    return props.block.content.split("\n")
  })

  const statusIcon = () => {
    if (hasError()) return { icon: "✗", color: theme.error }
    return { icon: "✓", color: theme.primary }
  }

  const header = () => (
    <box flexDirection="row" gap={1} overflow="hidden" onMouseDown={hasExpandable() ? () => setExpanded(prev => !prev) : undefined}>
      <text fg={statusIcon().color} flexShrink={0}>{statusIcon().icon}</text>
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
    <Show when={isResolved()}>
      <Show when={hasExpandable()} fallback={
        <box flexDirection="column">
          {header()}
          <Show when={hasError()}>
            <box paddingLeft={3} overflow="hidden">
              <text fg={theme.error} overflow="hidden" wrapMode="none">{props.block.errorMessage}</text>
            </box>
          </Show>
        </box>
      }>
        <box flexDirection="column">
          {header()}
          <CollapsibleBox expanded={expanded()} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1}>
            <Show when={hasDiff()}>
              <For each={diffStyledLines()}>
                {(line) => (
                  <box width="100%" backgroundColor={line.lineBg}>
                    <text ref={(el: TextRenderable) => { el.content = line.styled }} />
                  </box>
                )}
              </For>
            </Show>
            <Show when={hasContent()}>
              <For each={contentLines()}>
                {(line) => (
                  <box>
                    <text fg={theme.text}>{line}</text>
                  </box>
                )}
              </For>
            </Show>
          </CollapsibleBox>
        </box>
      </Show>
    </Show>
  )
}
