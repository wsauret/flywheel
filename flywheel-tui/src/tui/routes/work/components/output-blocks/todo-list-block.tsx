/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo, createEffect } from "solid-js"
import { StyledText, fg as stFg, bold as stBold, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import type { Theme } from "@tui/shared/context/theme/resolve"
import type { TodoListBlock as TodoListBlockType, TodoItem } from "@infra/output-blocks"

const MAX_VISIBLE = 4

function todoStyle(status: TodoItem["status"], theme: Theme) {
  if (status === "in_progress") return { symbol: "\u25C9", symbolFg: theme.primary, textFg: theme.text, bold: true }
  return { symbol: "\u25CB", symbolFg: theme.textMuted, textFg: theme.text, bold: false }
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
      <box flexDirection="column">
        <text
          ref={(el: TextRenderable) => {
            createEffect(() => {
              const chunks: TextChunk[] = [
                stBold(stFg(theme.accent)("\u2261 Tasks")),
              ]
              if (completedCount() > 0) {
                const bar = progressBar(completedCount(), totalCount(), theme)
                chunks.push(stFg(theme.text)(" "))
                chunks.push(stFg(bar.fg)(bar.text))
                chunks.push(stFg(theme.text)(" "))
                chunks.push(stBold(stFg(theme.success)(`${completedCount()}/${totalCount()}`)))
              }
              el.content = new StyledText(chunks)
            })
          }}
          overflow="hidden"
          wrapMode="none"
        />
        <For each={visible()}>
          {(item) => {
            const style = todoStyle(item.status, theme)
            const itemChunks: TextChunk[] = [
              stFg(style.symbolFg)(style.symbol),
              stFg(style.textFg)(` ${item.content}`),
            ]
            const styled = style.bold
              ? new StyledText(itemChunks.map(c => stBold(c)))
              : new StyledText(itemChunks)
            return (
              <box paddingLeft={2}>
                <text ref={(el: TextRenderable) => { el.content = styled }} />
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
