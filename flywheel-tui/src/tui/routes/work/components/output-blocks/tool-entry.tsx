/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, Show, For } from "solid-js"
import { StyledText, fg as stFg, bg as stBg, type TextChunk } from "@opentui/core"
import { BOLD } from "@tui/shared/ui/text-attributes"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { useSpinnerFrame } from "@tui/shared/hooks/use-spinner-frame.js"
import { isHandoffPath } from "@tui/utils/text"
import type { ToolEntry as ToolEntryType } from "@infra/output-blocks"
import { renderHunk } from "@tui/adapters/color-diff"
import { parseUnifiedDiff } from "@tui/adapters/diff-parser"
import { toFileUri } from "@tui/adapters/linkify-paths"
import { createHighlighter } from "@tui/adapters/syntax-highlight.js"
import { getToolDisplayName } from "@infra/tool-display-registry.js"


interface ToolEntryProps {
  block: ToolEntryType
}

export function ToolEntry(props: ToolEntryProps) {
  const { theme } = useTheme()
  const name = () => getToolDisplayName(props.block.name)

  const isCompleted = () => props.block.completed === true
  const hasError = () => !!props.block.errorMessage
  const hasDiff = () => !!props.block.diff && !hasError()
  const hasContent = () => !!props.block.content && !hasError()
  const hasExpandable = () => hasDiff() || hasContent()

  const [expanded, setExpanded] = createSignal(!isHandoffPath(props.block.filePath))

  const spinnerFrame = useSpinnerFrame(() => !isCompleted() && !hasError())

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

  const hl = createHighlighter(theme)
  const contentHighlighted = createMemo(() => {
    if (!props.block.content) return []
    return hl(props.block.content, props.block.filetype)
  })

  const statusIcon = createMemo(() => {
    if (hasError()) return { icon: "✗", color: theme.error }
    if (isCompleted()) return { icon: "✓", color: theme.primary }
    return { icon: spinnerFrame(), color: theme.secondary }
  })

  const header = () => (
    <box flexDirection="row" gap={1} overflow="hidden" onMouseDown={hasExpandable() ? () => setExpanded(prev => !prev) : undefined}>
      <text fg={statusIcon().color} flexShrink={0}>{statusIcon().icon}</text>
      <text fg={theme.text} flexShrink={0} attributes={BOLD}>{name()}</text>
      <Show when={props.block.filePath} fallback={
        <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">{props.block.detail}</text>
      }>
        <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none"><a href={toFileUri(props.block.filePath!)}>{props.block.detail}</a></text>
      </Show>
      <Show when={hasError()}>
        <text fg={theme.error} flexShrink={0} overflow="hidden" wrapMode="none">{props.block.errorMessage}</text>
      </Show>
      <Show when={hasExpandable()}>
        <text fg={theme.textMuted} flexShrink={0}>{expanded() ? "▾" : "▸"}</text>
      </Show>
    </box>
  )

  return (
    <box flexDirection="column">
      {header()}
      <Show when={hasExpandable()}>
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
            {(() => {
              const lines = contentHighlighted()
              const maxDigits = String(lines.length).length
              return <For each={lines}>
                {(segments, i) => (
                  <box flexDirection="row">
                    <text fg={theme.text}>{` ${String(i() + 1).padStart(maxDigits)}  `}</text>
                    <For each={segments}>
                      {(seg) => <text fg={seg.color ?? theme.text}>{seg.text}</text>}
                    </For>
                  </box>
                )}
              </For>
            })()}
          </Show>
        </CollapsibleBox>
      </Show>
    </box>
  )
}
