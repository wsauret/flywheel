/** @jsxImportSource @opentui/solid */
/**
 * TodoListBlock Component
 *
 * Renders a visual todo list from TodoWrite tool calls. Each item shows
 * a status indicator and content text:
 *
 *   ○ Pending task              (muted)
 *   ◉ In-progress task          (warning/orange, bold)
 *   ✓ Completed task            (primary check, muted text)
 *
 * The block updates in-place as subsequent TodoWrite calls arrive,
 * giving users a live view of the agent's task progress.
 */

import { For } from "solid-js"
import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import type { Theme } from "@tui/shared/context/theme/resolve"
import type { TodoListBlock as TodoListBlockType, TodoItem } from "@tui/types"

const BOLD = createTextAttributes({ bold: true })

/** Status symbol and color for each todo state. */
function todoStyle(status: TodoItem["status"], theme: Theme) {
  if (status === "completed") return { symbol: "✓", symbolFg: theme.secondary, textFg: theme.secondary, attrs: BOLD, textAttrs: undefined }
  if (status === "in_progress") return { symbol: "◉", symbolFg: theme.warning, textFg: theme.warning, attrs: BOLD, textAttrs: undefined }
  return { symbol: "○", symbolFg: theme.textMuted, textFg: theme.text, attrs: undefined, textAttrs: undefined }
}

export interface TodoListBlockProps {
  block: TodoListBlockType
}

export function TodoListBlock(props: TodoListBlockProps) {
  const { theme } = useTheme()

  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={theme.textMuted} attributes={BOLD}>Tasks</text>
      <For each={props.block.todos}>
        {(item) => {
          const style = todoStyle(item.status, theme)
          return (
            <box flexDirection="row" gap={1} paddingLeft={2}>
              <text fg={style.symbolFg} attributes={style.attrs}>{style.symbol}</text>
              <text fg={style.textFg} attributes={style.textAttrs}>{item.content}</text>
            </box>
          )
        }}
      </For>
    </box>
  )
}
