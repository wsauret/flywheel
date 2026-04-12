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

import { createSignal, createMemo, onCleanup } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { CollapsibleBox } from "@tui/shared/components/collapsible-box"
import { EmptyBorder } from "@tui/shared/ui/border"
import { createTextAttributes } from "@opentui/core"
import { formatElapsed } from "@infra/format.js"
import type { ThinkingBlock as ThinkingBlockType } from "@tui/types"

const COLLAPSED_LINES = 3

export interface ThinkingBlockProps {
  block: ThinkingBlockType
}

export function ThinkingBlock(props: ThinkingBlockProps) {
  const { theme, subtleSyntax } = useTheme()
  const [expanded, setExpanded] = createSignal(false)

  // Live elapsed that ticks every second while content is streaming,
  // then freezes once content stops growing for 2+ seconds.
  const [elapsed, setElapsed] = createSignal(0)
  let lastContentLen = props.block.content.length
  let staleTicks = 0
  const id = setInterval(() => {
    const currentLen = props.block.content.length
    if (currentLen !== lastContentLen) {
      lastContentLen = currentLen
      staleTicks = 0
    } else {
      staleTicks++
    }
    // Tick smoothly while content is actively streaming
    if (staleTicks < 2) {
      setElapsed(Date.now() - props.block.timestamp)
    }
  }, 1000)
  onCleanup(() => clearInterval(id))

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
      marginTop={1}
      paddingLeft={2}
      border={["left"]}
      borderColor={theme.backgroundElement}
      flexDirection="column"
      customBorderChars={{
        ...EmptyBorder,
        vertical: "┃",
      }}
      onMouseDown={isLong() ? () => setExpanded(prev => !prev) : undefined}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted} attributes={createTextAttributes({ italic: true })}>Thinking</text>
        {elapsed() >= 1000 && <text fg={theme.textMuted}>{formatElapsed(elapsed())}</text>}
        {isLong() && <text fg={theme.textMuted}>{expanded() ? "▾" : `▸ …${lineCount()} lines`}</text>}
      </box>

      {/* Expanded: full content */}
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

      {/* Collapsed: last N lines */}
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
