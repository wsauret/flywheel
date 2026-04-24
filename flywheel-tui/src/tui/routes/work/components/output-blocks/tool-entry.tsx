/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, Show, For } from "solid-js"
import { StyledText, fg as stFg, bg as stBg, bold as stBold, link as stLink, type TextChunk } from "@opentui/core"
import type { TextRenderable, RGBA } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { useSpinnerFrame } from "@tui/shared/hooks/use-spinner-frame.js"
import { isHandoffPath } from "@infra/paths.js"
import type { ToolEntry as ToolEntryType } from "@infra/output-blocks"
import { renderHunk } from "@tui/adapters/color-diff"
import { parseUnifiedDiff } from "@tui/adapters/diff-parser"
import { toFileUri } from "@tui/adapters/linkify-paths"
import { createHighlighter } from "@tui/adapters/syntax-highlight.js"
import { getToolDisplayName } from "@infra/tool-display-registry.js"
import { truncateArrayHead } from "@infra/output/truncate-output.js"
import {
  getToolContentPreview,
  TOOL_PREVIEW_LINE_LIMIT,
  nextToolEntryToggleState,
  shouldRenderToolContentAsMarkdown,
} from "./tool-entry-helpers.js"

interface ToolEntryProps {
  block: ToolEntryType
  interrupted?: boolean
}

export function ToolEntry(props: ToolEntryProps) {
  const { theme, syntax } = useTheme()
  const name = () => getToolDisplayName(props.block.name, props.block)

  const isCompleted = () => props.block.completed === true
  const hasError = () => !!props.block.errorMessage
  const isInterrupted = () => props.interrupted === true && !isCompleted() && !hasError()
  const hasDiff = () => !!props.block.diff && !hasError()
  const hasContent = () => !!props.block.content && !hasError()
  const hasExpandable = () => hasDiff() || hasContent()

  const [bodyExpanded, setBodyExpanded] = createSignal(!isHandoffPath(props.block.filePath))
  const [contentExpanded, setContentExpanded] = createSignal(false)

  const spinnerFrame = useSpinnerFrame(() => !isCompleted() && !hasError() && !isInterrupted())

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

  type StyledDiffLine = { styled: StyledText; lineBg: RGBA | undefined }
  const styleDiffLine = (line: { segments: Array<{ text: string; fg?: RGBA; bg?: RGBA }>; lineBg?: RGBA }): StyledDiffLine => {
    const chunks: TextChunk[] = line.segments.map((seg) => {
      let c: string | TextChunk = seg.text
      if (seg.fg) c = stFg(seg.fg)(c)
      if (seg.bg) c = stBg(seg.bg)(c)
      return c as TextChunk
    })
    return { styled: new StyledText(chunks), lineBg: line.lineBg }
  }

  const allDiffStyledLines = createMemo((): StyledDiffLine[] => {
    if (!props.block.diff) return []
    const hunks = parseUnifiedDiff(props.block.diff)
    return hunks.flatMap((hunk) => renderHunk(hunk, diffColors())).map(styleDiffLine)
  })

  const diffTruncation = createMemo(() =>
    truncateArrayHead(allDiffStyledLines(), TOOL_PREVIEW_LINE_LIMIT)
  )

  const diffStyledLines = createMemo((): StyledDiffLine[] =>
    contentExpanded() ? allDiffStyledLines() : diffTruncation().lines
  )

  const hl = createHighlighter(theme)
  const rendersMarkdownContent = () => shouldRenderToolContentAsMarkdown(props.block)
  const contentPreview = createMemo(() =>
    getToolContentPreview(props.block.content, TOOL_PREVIEW_LINE_LIMIT)
  )

  const contentHighlighted = createMemo(() => {
    if (!props.block.content) return []
    const content = contentExpanded() ? props.block.content : contentPreview().content
    return hl(content, props.block.filetype)
  })

  const keepsPreviewVisible = () => hasDiff() || hasContent()
  const previewExpandable = () => diffTruncation().truncated || contentPreview().truncated
  const showsBody = () => keepsPreviewVisible() || bodyExpanded()

  const headerChevron = createMemo(() => {
    if (keepsPreviewVisible() && previewExpandable()) return contentExpanded() ? "▾" : "▸"
    if (!keepsPreviewVisible() && hasExpandable()) return bodyExpanded() ? "▾" : "▸"
    return null
  })

  const toggleHeader = () => {
    const next = nextToolEntryToggleState(
      { bodyExpanded: bodyExpanded(), previewExpanded: contentExpanded() },
      { keepsPreviewVisible: keepsPreviewVisible(), previewExpandable: previewExpandable() },
    )
    setBodyExpanded(next.bodyExpanded)
    setContentExpanded(next.previewExpanded)
  }

  const canToggleHeader = () => headerChevron() !== null

  const statusIcon = createMemo(() => {
    if (hasError()) return { icon: "✗", color: theme.error }
    if (isInterrupted()) return { icon: "✗", color: theme.warning }
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

    if (headerChevron()) {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.textMuted)(headerChevron()!))
    }

    return new StyledText(chunks)
  })

  const diffTruncationNote = createMemo(() =>
    new StyledText([stFg(theme.textMuted)(`  ... +${diffTruncation().omitted} lines (click to expand)`)])
  )

  const contentTruncationNote = createMemo(() =>
    new StyledText([stFg(theme.textMuted)(`  ... ${contentPreview().omitted} more lines (click to expand)`)])
  )

  const header = () => (
    <box selectable={false} onMouseDown={canToggleHeader() ? toggleHeader : undefined}>
      <text
        selectable={false}
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
        <CollapsibleBox expanded={showsBody()} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1}>
          <Show when={hasDiff()}>
            <For each={diffStyledLines()}>
              {(line) => (
                <box width="100%" backgroundColor={line.lineBg}>
                  <text ref={(el: TextRenderable) => { el.content = line.styled }} />
                </box>
              )}
            </For>
            <Show when={diffTruncation().truncated && !contentExpanded()}>
              <box selectable={false} onMouseDown={() => setContentExpanded(true)}>
                <text
                  selectable={false}
                  ref={(el: TextRenderable) => {
                    createEffect(() => { el.content = diffTruncationNote() })
                  }}
                />
              </box>
            </Show>
          </Show>
          <Show when={hasContent()}>
            <Show when={contentExpanded() && rendersMarkdownContent()}>
              <markdown
                syntaxStyle={syntax}
                content={props.block.content ?? ""}
                streaming={false}
                conceal={true}
              />
            </Show>
            <Show when={!contentExpanded() || !rendersMarkdownContent()}>
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
              <Show when={contentPreview().truncated && !contentExpanded()}>
                <box selectable={false} onMouseDown={() => setContentExpanded(true)}>
                  <text
                    selectable={false}
                    ref={(el: TextRenderable) => {
                      createEffect(() => { el.content = contentTruncationNote() })
                    }}
                  />
                </box>
              </Show>
            </Show>
          </Show>
        </CollapsibleBox>
      </Show>
    </box>
  )
}