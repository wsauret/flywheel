/** @jsxImportSource @opentui/solid */
/**
 * ContextGroupBlock Component
 *
 * Renders a context group with progressive disclosure:
 * Collapsed (default): `◆ Gathered context (N files) ▸`
 * Expanded: shows individual file names from the tool list.
 */

import { createSignal, Show, For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { truncate } from "@tui/utils/text"
import { displayToolName } from "./tool-block"
import type { ContextGroupBlock as ContextGroupBlockType } from "@tui/types"

export interface ContextGroupBlockProps {
  block: ContextGroupBlockType
}

export function ContextGroupBlock(props: ContextGroupBlockProps) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(false)

  const fileCount = () => props.block.tools.length

  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => setExpanded((v) => !v)}>
        <text fg={theme.textMuted}>◆ Gathered context ({fileCount()} files)</text>
        <text fg={theme.textMuted}>{expanded() ? "▾" : "▸"}</text>
      </box>
      <Show when={expanded()}>
        <box flexDirection="column" paddingLeft={3}>
          <For each={props.block.tools}>
            {(tool) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme.textMuted}>{displayToolName(tool.name)}</text>
                <text fg={theme.textMuted}>{truncate(tool.detail, 60)}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
