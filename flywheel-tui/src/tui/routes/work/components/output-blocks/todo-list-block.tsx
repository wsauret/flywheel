/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js"
import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import type { Theme } from "@tui/shared/context/theme/resolve"
import type { TodoListBlock as TodoListBlockType, TodoItem } from "@infra/output-blocks"

const BOLD = createTextAttributes({ bold: true })
const MAX_VISIBLE = 4

function todoStyle(status: TodoItem["status"], theme: Theme) {
  if (status === "in_progress") return { symbol: "\u25C9", symbolFg: theme.warning, textFg: theme.warning, attrs: BOLD }
  return { symbol: "\u25CB", symbolFg: theme.textMuted, textFg: theme.text, attrs: undefined }
}

export interface TodoListBlockProps {
  block: TodoListBlockType
}

export function TodoListBlock(props: TodoListBlockProps) {
  const { theme } = useTheme()

  const incomplete = createMemo(() =>
    props.block.todos.filter(t => t.status !== "completed")
  )

  const visible = createMemo(() => {
    const items = incomplete()
    return items.length <= MAX_VISIBLE ? items : items.slice(0, MAX_VISIBLE)
  })

  const remaining = createMemo(() => Math.max(0, incomplete().length - MAX_VISIBLE))

  return (
    <Show when={incomplete().length > 0}>
      <box flexDirection="column" marginTop={1}>
        <text fg={theme.textMuted} attributes={BOLD}>Tasks</text>
        <For each={visible()}>
          {(item) => {
            const style = todoStyle(item.status, theme)
            return (
              <box flexDirection="row" gap={1} paddingLeft={2}>
                <text fg={style.symbolFg} attributes={style.attrs}>{style.symbol}</text>
                <text fg={style.textFg} attributes={style.attrs}>{item.content}</text>
              </box>
            )
          }}
        </For>
        <Show when={remaining() > 0}>
          <text fg={theme.textMuted} paddingLeft={4}>+ {remaining()} more</text>
        </Show>
      </box>
    </Show>
  )
}
