/** @jsxImportSource @opentui/solid */

import { formatElapsed } from "../../protocol/client/format.js"
import type { ThinkingBlock as ThinkingBlockType } from "@infra/output-blocks"
import { StyledText, bold as stBold, fg as stFg, italic as stItalic, type TextChunk, type TextRenderable } from "@opentui/core"
import { CollapsibleBox } from "@tui/components/collapsible-box"
import { useTheme } from "@tui/context/theme"
import { useBlockDisclosure } from "@tui/context/block-disclosure.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { useBodyToggle, useHeaderToggle } from "@tui/hooks/use-body-toggle.js"
import { useElapsed } from "@tui/hooks/use-elapsed"
import { VerticalBarBorder } from "@tui/utils/border"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { createEffect, createMemo, Show } from "solid-js"
import { BlockFrame } from "./block-frame.js"
import { MarkdownBody } from "./markdown/markdown-body.js"

const COLLAPSED_LINES = 3

function lastLines(text: string, maxLines: number): string {
  let idx = text.length
  for (let n = 0; n < maxLines; n++) {
    const next = text.lastIndexOf("\n", idx - 1)
    if (next === -1) return text
    idx = next
  }
  return text.slice(idx + 1)
}

interface ThinkingBlockProps {
  block: ThinkingBlockType
  showContent?: boolean
}

export function ThinkingBlock(props: ThinkingBlockProps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx

  const streaming = () => props.block.status === "streaming"
  const liveElapsed = useElapsed(() => streaming() ? props.block.timestamp : undefined)
  const elapsed = createMemo(() => {
    if (streaming()) return liveElapsed()
    return Math.max(0, (props.block.completedAt ?? props.block.timestamp) - props.block.timestamp)
  })
  const collapsedContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stBold(stFg(theme.text)("Thinking")),
    ]
    return new StyledText(chunks)
  })

  const showContent = createMemo(() => props.showContent !== false)
  const disclosure = useBlockDisclosure()
  const key = () => `${blockIdentity(props.block)}#thinking`
  const expanded = () => disclosure.disclosure(key()) ?? false
  const toggle = () => disclosure.setDisclosure(key(), !expanded())

  const trimmed = () => props.block.content.trim()

  // Streaming appends per flush; count only the delta's newlines and locate the
  // tail by scanning back from the end instead of splitting the full string.
  const lineStats = createMemo<{ src: string; count: number; tail: string }>((prev) => {
    const text = trimmed()
    let count: number
    if (prev && text.startsWith(prev.src)) {
      count = prev.count
      for (let i = prev.src.length; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
    } else {
      count = 1
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
    }
    return { src: text, count, tail: lastLines(text, COLLAPSED_LINES) }
  })

  const tailLines = () => lineStats().tail
  const lineCount = () => lineStats().count
  const isLong = () => lineCount() > COLLAPSED_LINES
  const headerToggle = useHeaderToggle(isLong, toggle)
  // Whole-body expand/contract: the collapsed tail expands and the expanded
  // body collapses on click, mirroring the header chevron.
  const bodyToggle = useBodyToggle(isLong, toggle)

  const rail = () => ({ paddingLeft: 2, border: ["left" as const], borderColor: theme.borderSubtle, customBorderChars: VerticalBarBorder })

  const headerContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stItalic(stFg(theme.textMuted)("Thinking")),
    ]
    if (elapsed() >= 1000) {
      chunks.push(stFg(theme.textMuted)(` ${formatElapsed(elapsed())}`))
    }
    if (isLong()) {
      chunks.push(stFg(theme.textMuted)(` ${expanded() ? "\u25be" : `\u25b8 \u2026${lineCount()} lines`}`))
    }
    return new StyledText(chunks)
  })

  return (
    <BlockFrame>
      <Show when={showContent()} fallback={
        <text
          ref={(el: TextRenderable) => {
            createEffect(() => { el.content = collapsedContent() })
          }}
        />
      }>
        {/* The header and the body each draw their part of the rail, so the
            rail and padding beside the body belong to the body's hitbox and
            the header keeps its text-width one (PI-INTERACTION-080). */}
        <box flexDirection="column">
          <box {...rail()}>
            <box
              selectable={false}
              {...headerToggle.handlers}
              backgroundColor={headerToggle.background()}
            >
              <text ref={bindStyledTextContent(headerContent)} />
            </box>
          </box>

          <CollapsibleBox
            expanded={expanded()}
            {...rail()}
            handlers={bodyToggle.handlers}
            ref={bodyToggle.body}
          >
            <box flexDirection="column" backgroundColor={bodyToggle.background()}>
              <MarkdownBody dimColor unwrapFences>{trimmed()}</MarkdownBody>
            </box>
          </CollapsibleBox>

          <CollapsibleBox
            expanded={!expanded()}
            {...rail()}
            handlers={bodyToggle.handlers}
            ref={bodyToggle.body}
          >
            <box flexDirection="column" backgroundColor={bodyToggle.background()}>
              <MarkdownBody dimColor unwrapFences>{tailLines()}</MarkdownBody>
            </box>
          </CollapsibleBox>
        </box>
      </Show>
    </BlockFrame>
  )
}
