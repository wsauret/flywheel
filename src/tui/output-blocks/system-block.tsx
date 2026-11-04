/** @jsxImportSource @opentui/solid */

import type { DividerBlock as DividerBlockType, SystemBlock as SystemBlockType } from "@infra/output-blocks"
import { blockIdentity } from "../../protocol/block-identity.js"
import { isReturnedInputNotice } from "../../protocol/composer-returns.js"
import { StyledText, bold as stBold, fg as stFg, type TextChunk, type TextRenderable } from "@opentui/core"
import { useUnifiedToggle } from "@tui/hooks/use-body-toggle.js"
import { BlankVerticalBarBorder, VerticalBarBorder } from "@tui/utils/border"
import { BlockFrame } from "./block-frame.js"
import { MutationEvidencePreview } from "./diff-preview.js"
import { useTheme } from "@tui/context/theme"
import { useBlockDisclosure } from "@tui/context/block-disclosure.js"
import { allowSelectionStart } from "@tui/utils/selection.js"
import { type Accessor, createEffect, createMemo, For } from "solid-js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"

interface SystemBlockProps {
  block: SystemBlockType
  diffColors?: Accessor<DiffColorMode>
  /** Lazy full-body fetch for a wire-truncated notice: invoked with the block's
   *  durable identity while a disclosed body has remote-omitted lines. */
  onHydrateBody?: (blockId: string) => void
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const isError = createMemo(() => props.block.level === "error")
  const isReturnedInput = createMemo(() => isReturnedInputNotice(props.block.id))

  const hasDiff = () => (props.block.mutationEvidence?.applied ?? 0) > 0 || (props.block.mutationEvidence?.omissions ?? 0) > 0
  const disclosure = useBlockDisclosure()
  const key = () => `${blockIdentity(props.block)}#notice-diff`
  const bodyExpanded = () => disclosure.disclosure(key()) ?? false

  const chevron = createMemo(() => hasDiff() ? (bodyExpanded() ? "▾" : "▸") : null)

  const toggleDiff = (): void => { disclosure.setDisclosure(key(), !bodyExpanded()) }
  const toggle = useUnifiedToggle(() => chevron() !== null, toggleDiff, () => hasDiff() && bodyExpanded())

  // Returned person input is literal text, not the notice author's code spans.
  const messageLines = createMemo(() => props.block.message.split("\n"))
  const styledLine = (line: string, index: number): StyledText => {
    const hasCode = !isReturnedInput() && line.includes("`")
    const fg = isReturnedInput() ? (index === 0 ? theme.textMuted : theme.text) : hasCode ? theme.secondary : isError() ? theme.error : theme.textMuted
    const chunks: TextChunk[] = [stFg(fg)(hasCode ? line.replace(/`/g, "") : (line || " "))]
    const marker = index === messageLines().length - 1 ? chevron() : null
    if (marker) {
      chunks.push(stFg(theme.text)(" "), toggle.hovered() ? stBold(stFg(theme.primaryBright)(marker)) : stFg(theme.primary)(marker))
    }
    return new StyledText(chunks)
  }

  return (
    <BlockFrame>
      <box
        flexDirection="column"
        {...toggle.handlers}
      >
        <box flexDirection="column" selectable={false}>
          <For each={messageLines()}>
            {(line, index) => (
              <text
                ref={(el: TextRenderable) => {
                  el.content = styledLine(line, index())
                  createEffect(() => { el.content = styledLine(line, index()) })
                }}
              />
            )}
          </For>
        </box>
        {hasDiff() && bodyExpanded() ? (
          <box
            ref={toggle.body}
            flexDirection="column"
            border={["left"]}
            borderColor={theme.primary}
            customBorderChars={toggle.hovered() ? VerticalBarBorder : BlankVerticalBarBorder}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
          >
            {props.block.mutationEvidence !== undefined ? <MutationEvidencePreview
              ownerId={blockIdentity(props.block)}
              evidence={props.block.mutationEvidence}
              expanded
              diffColors={props.diffColors}
            /> : null}
          </box>
        ) : null}
      </box>
    </BlockFrame>
  )
}

interface DividerBlockProps {
  block: DividerBlockType
}

/** An implicit divider retains the transcript's selectable leading space. */
export function Divider() {
  return <box flexDirection="column">
    <box height={1} width="100%" ref={allowSelectionStart} />
    <DividerBlock block={{ kind: "divider", id: "boundary-before", label: "", timestamp: 0 }} />
  </box>
}

export function DividerBlock(props: DividerBlockProps) {
  const themeCtx = useTheme()
  const boundaryContent = createMemo(() => {
    const chunks: TextChunk[] = []
    if (props.block.label) {
      chunks.push(stBold(stFg(themeCtx.theme.accent)(props.block.label)), stFg(themeCtx.theme.borderSubtle)(` ${"\u2500".repeat(200)}`))
    } else {
      chunks.push(stFg(themeCtx.theme.borderSubtle)("\u2500".repeat(200)))
    }
    return new StyledText(chunks)
  })
  return (
    <box marginTop={0} marginBottom={0}>
      <text
        ref={(el: TextRenderable) => {
          createEffect(() => { el.content = boundaryContent() })
        }}
        overflow="hidden"
        wrapMode="none"
      />
    </box>
  )
}
