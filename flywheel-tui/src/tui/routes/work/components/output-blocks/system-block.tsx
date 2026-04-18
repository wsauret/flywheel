/** @jsxImportSource @opentui/solid */

import { For } from "solid-js"
import { StyledText, fg as stFg, bold as stBold, dim as stDim, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import type { SystemBlock as SystemBlockType } from "@infra/output-blocks"

interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
  const isStepBoundary = props.block.message.startsWith("[step-boundary]")

  if (isStepBoundary) {
    const label = props.block.message.slice("[step-boundary]".length).trim()
    const boundaryChunks: TextChunk[] = []
    if (label) {
      boundaryChunks.push(stBold(stDim(stFg(themeCtx.theme.accent)(label))))
    } else {
      boundaryChunks.push(stDim(stFg(themeCtx.theme.borderSubtle)("\u2500\u2500")))
    }
    boundaryChunks.push(stDim(stFg(themeCtx.theme.borderSubtle)(` ${ "\u2500".repeat(200)}`)))
    const boundaryContent = new StyledText(boundaryChunks)
    return (
      <box marginTop={1} marginBottom={0}>
        <text
          ref={(el: TextRenderable) => { el.content = boundaryContent }}
          overflow="hidden"
          wrapMode="none"
        />
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
