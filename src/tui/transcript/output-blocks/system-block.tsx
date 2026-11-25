/** @jsxImportSource @opentui/solid */

import type { DividerBlock as DividerBlockType, SystemBlock as SystemBlockType } from "@infra/output-blocks"
import { watchRowView } from "../../../protocol/client/chat/transcript/transcript-model.js"
import { blockIdentity } from "../../../protocol/transcript/block-identity.js"
import { isReturnedInputNotice } from "../../../protocol/transcript/composer-returns.js"
import { StyledText, bold as stBold, fg as stFg, type TextChunk, type TextRenderable } from "@opentui/core"
import { useUnifiedToggle } from "@tui/transcript/output-blocks/use-body-toggle.js"
import { BlankVerticalBarBorder, VerticalBarBorder } from "@tui/transcript/output-blocks/border"
import { BlockFrame } from "./block-frame.js"
import { MutationEvidencePreview } from "./tools/diff-preview.js"
import { useTheme } from "@tui/context/theme"
import { useBlockDisclosure } from "@tui/context/transcript/block-disclosure.js"
import { allowSelectionStart } from "@tui/terminal/selection.js"
import { type Accessor, createEffect, createMemo, For } from "solid-js"
import type { DiffColorMode } from "../../../orchestration/config/schema/schema.js"

interface SystemBlockProps {
  block: SystemBlockType
  diffColors?: Accessor<DiffColorMode>
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

  // A watch row names its command on a muted label line and shows the
  // command's own lines below it as body text, never as a person's message.
  // The first line of an end row says how the watch ended, in notice style.
  // A long row shows its first lines until it is disclosed (`watchRowView`).
  const watch = createMemo(() => {
    const row = props.block.watch
    return row ? watchRowView({ watch: row, message: props.block.message }, bodyExpanded()) : undefined
  })
  const chevron = createMemo(() => hasDiff() || watch()?.expandable === true ? (bodyExpanded() ? "▾" : "▸") : null)

  const toggleDiff = (): void => { disclosure.setDisclosure(key(), !bodyExpanded()) }
  const toggle = useUnifiedToggle(() => chevron() !== null, toggleDiff, () => hasDiff() && bodyExpanded())

  // Returned person input and watch output are literal text, not the notice
  // author's code spans.
  const isLiteral = () => isReturnedInput() || watch() !== undefined
  /** Each line with whether it is muted: a watch row's label, its summary,
   *  and its count of hidden lines are; its command's lines are not. */
  const messageLines = createMemo((): readonly { readonly text: string; readonly muted: boolean }[] => {
    const view = watch()
    if (view === undefined) return props.block.message.split("\n").map((text) => ({ text, muted: false }))
    return [
      { text: view.label, muted: true },
      ...(view.summary === undefined ? [] : [{ text: view.summary, muted: true }]),
      ...view.lines.map((text) => ({ text, muted: false })),
      ...(view.hidden > 0 ? [{ text: `${view.hidden} more lines`, muted: true }] : []),
    ]
  })
  const noticeLineColor = (index: number, hasCode: boolean) => {
    if (isReturnedInput()) return index === 0 ? theme.textMuted : theme.text
    if (hasCode) return theme.secondary
    return isError() ? theme.error : theme.textMuted
  }
  const styledLine = ({ text: line, muted }: { readonly text: string; readonly muted: boolean }, index: number): StyledText => {
    const hasCode = !isLiteral() && line.includes("`")
    const fg = watch() !== undefined ? (muted ? theme.textMuted : theme.text) : noticeLineColor(index, hasCode)
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
