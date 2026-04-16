/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js"
import { BOLD, DIM } from "@tui/shared/ui/text-attributes"
import { useTheme } from "@tui/shared/context/theme"
import type { Theme } from "@tui/shared/context/theme/resolve"
import type { TodoListBlock as TodoListBlockType, TodoItem } from "@infra/output-blocks"

const MAX_VISIBLE = 4

function todoStyle(status: TodoItem["status"], theme: Theme) {
  if (status === "in_progress") return { symbol: "\u25C9", symbolFg: theme.primary, textFg: theme.text, attrs: BOLD }
  return { symbol: "\u25CB", symbolFg: theme.textMuted, textFg: theme.text, attrs: undefined }
}

function progressBar(completed: number, total: number, theme: Theme): { text: string; fg: typeof theme.success } {
  const width = 12
  const filled = total > 0 ? Math.round((completed / total) * width) : 0
  const bar = "\u2501".repeat(filled) + "\u2500".repeat(width - filled)
  const fg = completed === total ? theme.success : completed > 0 ? theme.primary : theme.textMuted
  return { text: bar, fg }
}

interface TodoListBlockProps {
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
  const completedCount = createMemo(() =>
    props.block.todos.filter(t => t.status === "completed").length
  )
  const totalCount = createMemo(() => props.block.todos.length)

  return (
    <Show when={incomplete().length > 0}>
      <box flexDirection="column" marginTop={1}>
        <box flexDirection="row" gap={1} overflow="hidden">
          <text fg={theme.accent} attributes={BOLD}>{"\u2630"} Tasks</text>
          <Show when={completedCount() > 0}>
            {(() => {
              const bar = () => progressBar(completedCount(), totalCount(), theme)
              return (
                <>
                  <text fg={bar().fg}>{bar().text}</text>
                  <text fg={theme.success} attributes={DIM}>{completedCount()}/{totalCount()}</text>
                </>
              )
            })()}
          </Show>
        </box>
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
          <text fg={theme.textMuted} paddingLeft={2}>{remaining()} pending</text>
        </Show>
      </box>
    </Show>
  )
}
