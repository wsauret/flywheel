/** @jsxImportSource @opentui/solid */

import { createSignal, Show } from "solid-js"
import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { EmptyBorder } from "@tui/shared/ui/border"
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
        marginTop={1}
        marginBottom={1}
        border={["left"]}
        borderColor={pending() ? theme.textMuted : theme.secondary}
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
        }}
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
          {pending() && <text fg={theme.textMuted} attributes={createTextAttributes({ italic: true })}> (queued)</text>}
        </box>
      </box>
    }>
      {/* Injected message — collapsed by default */}
      <box flexDirection="column" marginTop={1}>
        <box flexDirection="row" gap={1} onMouseDown={() => setExpanded((v) => !v)}>
          <text fg={theme.textMuted}>↳</text>
          <text fg={theme.textMuted} attributes={createTextAttributes({ bold: true })}>System</text>
          <text fg={theme.textMuted}>{expanded() ? "▾" : "▸"}</text>
          <Show when={!expanded()}>
            <text fg={theme.textMuted}>{previewLine(props.block.content)}</text>
          </Show>
        </box>
        <Show when={expanded()}>
          <box
            border={["left"]}
            borderColor={theme.textMuted}
            customBorderChars={{
              ...EmptyBorder,
              vertical: "┃",
            }}
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
