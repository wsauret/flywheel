/** @jsxImportSource @opentui/solid */
/**
 * UserMessageBlock Component
 *
 * Renders user messages:
 * Left border in secondary color + panel background + padded text.
 */

import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { EmptyBorder } from "@tui/shared/ui/border"
import type { UserMessageBlock as UserMessageBlockType } from "@tui/types"

export interface UserMessageBlockProps {
  block: UserMessageBlockType
}

export function UserMessageBlock(props: UserMessageBlockProps) {
  const { theme, syntax } = useTheme()
  const pending = () => props.block.pending === true

  return (
    <box
      marginTop={1}
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
        backgroundColor={theme.backgroundPanel}
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
  )
}
