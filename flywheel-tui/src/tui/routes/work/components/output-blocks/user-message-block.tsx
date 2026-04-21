/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, Show } from "solid-js"
import { StyledText, fg as stFg, bold as stBold, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { ITALIC } from "@tui/shared/ui/text-attributes"
import { useTheme } from "@tui/shared/context/theme"
import { VerticalBarBorder } from "@tui/shared/ui/border"
import { preventSelectionMouseDown } from "@tui/utils/mouse.js"
import type { UserMessageBlock as UserMessageBlockType } from "@infra/output-blocks"

interface UserMessageBlockProps {
  block: UserMessageBlockType
}

function previewLine(content: string, maxLen = 80): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 3) + "..." : trimmed
    }
  }
  return "(empty)"
}

export function UserMessageBlock(props: UserMessageBlockProps) {
  const { theme, syntax } = useTheme()
  const pending = () => props.block.pending === true
  const injected = () => props.block.injected === true
  const [expanded, setExpanded] = createSignal(false)

  return (
    <Show when={injected()} fallback={
      <box
        border={["left"]}
        borderColor={pending() ? theme.textMuted : theme.secondary}
        customBorderChars={VerticalBarBorder}
      >
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={theme.backgroundElement}
          flexShrink={0}
        >
          <code
            filetype="markdown"
            syntaxStyle={syntax}
            content={props.block.content}
            streaming={false}
            conceal={true}
            fg={pending() ? theme.textMuted : theme.text}
          />
          {pending() && <text fg={theme.textMuted} attributes={ITALIC}> (queued)</text>}
        </box>
      </box>
    }>
      {/* Injected message — collapsed by default */}
      <box flexDirection="column">
        <box onMouseDown={preventSelectionMouseDown(() => setExpanded((v) => !v))}>
          <text
            ref={(el: TextRenderable) => {
              createEffect(() => {
                const chunks: TextChunk[] = [
                  stFg(theme.textMuted)("↳"),
                  stFg(theme.textMuted)(" "),
                  stBold(stFg(theme.textMuted)("System")),
                  stFg(theme.textMuted)(` ${expanded() ? "▾" : "▸"}`),
                ]
                if (!expanded()) {
                  chunks.push(stFg(theme.textMuted)(` ${previewLine(props.block.content)}`))
                }
                el.content = new StyledText(chunks)
              })
            }}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
        <Show when={expanded()}>
          <box
            border={["left"]}
            borderColor={theme.textMuted}
            customBorderChars={VerticalBarBorder}
          >
            <box
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              backgroundColor={theme.backgroundElement}
              flexShrink={0}
            >
              <code
                filetype="markdown"
                syntaxStyle={syntax}
                content={props.block.content}
                streaming={false}
                conceal={true}
                fg={theme.textMuted}
              />
            </box>
          </box>
        </Show>
      </box>
    </Show>
  )
}
