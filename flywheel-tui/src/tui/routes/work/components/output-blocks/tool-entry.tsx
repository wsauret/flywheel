/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, Show, For } from "solid-js"
import { StyledText, fg as stFg, bg as stBg, bold as stBold, link as stLink, type TextChunk } from "@opentui/core"
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
import { shouldRenderToolContentAsMarkdown } from "./tool-entry-helpers.js"

interface ToolEntryProps {
  block: ToolEntryType
}

export function ToolEntry(props: ToolEntryProps) {
  const { theme, syntax } = useTheme()
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
  const rendersMarkdownContent = () => shouldRenderToolContentAsMarkdown(props.block)
  const contentHighlighted = createMemo(() => {
    if (!props.block.content || rendersMarkdownContent()) return []
    return hl(props.block.content, props.block.filetype)
  })

  const statusIcon = createMemo(() => {
    if (hasError()) return { icon: "✗", color: theme.error }
    if (isCompleted()) return { icon: "✓", color: theme.primary }
    return { icon: spinnerFrame(), color: theme.secondary }
  })

  const headerContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stFg(statusIcon().color)(statusIcon().icon),
      stFg(theme.text)(" "),
      stBold(stFg(theme.text)(name())),
    ]

    const detail = props.block.detail
    if (detail) {
      chunks.push(stFg(theme.text)(" "))
      if (props.block.filePath) {
        chunks.push(stLink(toFileUri(props.block.filePath))(stFg(theme.textSubtle)(detail)))
      } else {
        chunks.push(stFg(theme.textSubtle)(detail))
      }
    }

    if (hasError() && props.block.errorMessage) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.error)(props.block.errorMessage))
    }

    if (hasExpandable()) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.textMuted)(expanded() ? "▾" : "▸"))
    }

    return new StyledText(chunks)
  })

  const header = () => (
    <box onMouseDown={hasExpandable() ? () => setExpanded(prev => !prev) : undefined}>
      <text
        ref={(el: TextRenderable) => {
          createEffect(() => { el.content = headerContent() })
        }}
        overflow="hidden"
        wrapMode="none"
      />
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
            <Show when={rendersMarkdownContent()}>
              <markdown
                syntaxStyle={syntax}
                content={props.block.content ?? ""}
                streaming={false}
                conceal={true}
              />
            </Show>
            <Show when={!rendersMarkdownContent()}>
              {(() => {
                const lines = contentHighlighted()
                const maxDigits = String(lines.length).length
                return <For each={lines}>
                  {(segments, i) => {
                    const lineChunks: TextChunk[] = [
                      stFg(theme.text)(` ${String(i() + 1).padStart(maxDigits)}  `),
                      ...segments.map((seg) => stFg(seg.color ?? theme.text)(seg.text)),
                    ]
                    return <text ref={(el: TextRenderable) => { el.content = new StyledText(lineChunks) }} />
                  }}
                </For>
              })()}
            </Show>
          </Show>
        </CollapsibleBox>
      </Show>
    </box>
  )
}
