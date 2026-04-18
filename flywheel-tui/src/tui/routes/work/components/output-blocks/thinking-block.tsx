/** @jsxImportSource @opentui/solid */
/**
 * ThinkingBlock Component
 *
 * Renders reasoning/thinking output with a left border accent.
 *
 * Collapsed (default): shows the latest 3 lines of thinking, updated live
 * as content streams in. Click to expand.
 *
 * Expanded: shows the full thinking history. Click to collapse back.
 *
 * Uses CollapsibleBox for the full-content section to keep the container
 * stable in the layout tree (no flicker on toggle).
 */

import { createSignal, createMemo, createEffect, onCleanup } from "solid-js"
import { StyledText, fg as stFg, bold as stBold, italic as stItalic, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useElapsed } from "@tui/shared/hooks/use-elapsed"
import { useSpinnerFrame } from "@tui/shared/hooks/use-spinner-frame.js"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { VerticalBarBorder } from "@tui/shared/ui/border"
import { formatElapsed } from "@infra/format.js"
import type { ThinkingBlock as ThinkingBlockType } from "@infra/output-blocks"

const COLLAPSED_LINES = 3

interface ThinkingBlockProps {
  block: ThinkingBlockType
  showContent?: boolean
}

export function ThinkingBlock(props: ThinkingBlockProps) {
  const { theme, subtleSyntax } = useTheme()

  const [streaming, setStreaming] = createSignal(true)
  let lastContentLen = props.block.content.length
  let staleTicks = 0
  const staleId = setInterval(() => {
    const currentLen = props.block.content.length
    if (currentLen !== lastContentLen) {
      lastContentLen = currentLen
      staleTicks = 0
      setStreaming(true)
    } else if (++staleTicks >= 2) {
      setStreaming(false)
    }
  }, 1000)
  onCleanup(() => clearInterval(staleId))

  const elapsed = useElapsed(() => streaming() ? props.block.timestamp : undefined)
  const spinnerFrame = useSpinnerFrame(() => streaming())

  const statusIcon = createMemo(() => {
    if (!streaming()) return { icon: "\u25c6", color: theme.accent }
    return { icon: spinnerFrame(), color: theme.accent }
  })

  if (props.showContent === false) {
    const collapsedContent = createMemo(() => {
      const chunks: TextChunk[] = [
        stFg(statusIcon().color)(statusIcon().icon),
        stFg(theme.text)(" "),
        stBold(stFg(theme.text)("Thinking...")),
      ]
      return new StyledText(chunks)
    })
    return (
      <text
        ref={(el: TextRenderable) => {
          createEffect(() => { el.content = collapsedContent() })
        }}
      />
    )
  }

  const [expanded, setExpanded] = createSignal(false)

  const trimmed = () => props.block.content.trim()

  const tailLines = createMemo(() => {
    const lines = trimmed().split("\n")
    if (lines.length <= COLLAPSED_LINES) return trimmed()
    return lines.slice(-COLLAPSED_LINES).join("\n")
  })

  const lineCount = createMemo(() => trimmed().split("\n").length)
  const isLong = () => lineCount() > COLLAPSED_LINES

  return (
    <box
      paddingLeft={2}
      border={["left"]}
      borderColor={theme.borderSubtle}
      flexDirection="column"
      customBorderChars={VerticalBarBorder}
      onMouseDown={isLong() ? () => setExpanded(prev => !prev) : undefined}
    >
      <text
        ref={(el: TextRenderable) => {
          createEffect(() => {
            const chunks: TextChunk[] = [
              stItalic(stFg(theme.textMuted)("Thinking")),
            ]
            if (elapsed() >= 1000) {
              chunks.push(stFg(theme.textMuted)(` ${formatElapsed(elapsed())}`))
            }
            if (isLong()) {
              chunks.push(stFg(theme.textMuted)(` ${expanded() ? "\u25be" : `\u25b8 \u2026${lineCount()} lines`}`))
            }
            el.content = new StyledText(chunks)
          })
        }}
      />

      <CollapsibleBox expanded={expanded()}>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={subtleSyntax}
          content={trimmed()}
          conceal={true}
          fg={theme.textMuted}
        />
      </CollapsibleBox>

      <CollapsibleBox expanded={!expanded()}>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={subtleSyntax}
          content={tailLines()}
          conceal={true}
          fg={theme.textMuted}
        />
      </CollapsibleBox>
    </box>
  )
}
