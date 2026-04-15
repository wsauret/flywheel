/** @jsxImportSource @opentui/solid */

import { For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import type { SystemBlock as SystemBlockType } from "@infra/output-blocks"

interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
  const isStepBoundary = props.block.message.startsWith("[step-boundary]")

  if (isStepBoundary) {
    return (
      <box marginTop={1}>
        <text fg={themeCtx.theme.borderSubtle}>{"───"}</text>
      </box>
    )
  }

  if (!props.block.message.includes("`")) {
    return (
      <box marginTop={1}>
        <text fg={themeCtx.theme.textMuted}>{props.block.message}</text>
      </box>
    )
  }

  return (
    <box marginTop={1} flexDirection="column">
      <For each={props.block.message.split("\n")}>
        {(line) => {
          const hasCode = line.includes("`")
          return (
            <text fg={hasCode ? themeCtx.theme.secondary : themeCtx.theme.textMuted}>
              {hasCode ? line.replace(/`/g, "") : (line || " ")}
            </text>
          )
        }}
      </For>
    </box>
  )
}
