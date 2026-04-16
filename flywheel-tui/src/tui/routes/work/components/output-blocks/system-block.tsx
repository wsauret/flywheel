/** @jsxImportSource @opentui/solid */

import { For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { DIM, BOLD_DIM } from "@tui/shared/ui/text-attributes"
import type { SystemBlock as SystemBlockType } from "@infra/output-blocks"

interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
  const isStepBoundary = props.block.message.startsWith("[step-boundary]")

  if (isStepBoundary) {
    const label = props.block.message.slice("[step-boundary]".length).trim()
    return (
      <box marginTop={1} marginBottom={0} flexDirection="row" gap={1} overflow="hidden">
        {label
          ? <text fg={themeCtx.theme.accent} attributes={BOLD_DIM}>{label}</text>
          : <text fg={themeCtx.theme.borderSubtle} attributes={DIM}>{"\u2500\u2500"}</text>
        }
        <text fg={themeCtx.theme.borderSubtle} attributes={DIM} flexShrink={1} overflow="hidden" wrapMode="none">{"\u2500".repeat(200)}</text>
      </box>
    )
  }

  if (!props.block.message.includes("`")) {
    return (
      <box>
        <text fg={themeCtx.theme.textMuted}>{props.block.message}</text>
      </box>
    )
  }

  return (
    <box flexDirection="column">
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
