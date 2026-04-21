/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo, createEffect } from "solid-js"
import { StyledText, fg as stFg, bold as stBold, dim as stDim, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useSpinnerFrame } from "@tui/shared/hooks/use-spinner-frame.js"
import type { QuestionBlock } from "@infra/output-blocks"
import { SUCCESS_ICON, ERROR_ICON } from "./tool-row.js"

interface QuestionHistoryBlockProps {
  block: QuestionBlock
}

export function QuestionHistoryBlock(props: QuestionHistoryBlockProps) {
  const { theme } = useTheme()
  const isAnswered = () => !!props.block.answers
  const isCancelled = () => !!props.block.cancelled
  const isResolved = () => isAnswered() || isCancelled()
  const isSingleQuestion = () => props.block.questions.length === 1

  const spinnerFrame = useSpinnerFrame(() => !isResolved())

  const icon = createMemo(() => {
    if (isCancelled()) return { text: ERROR_ICON, color: theme.error }
    if (isAnswered()) return { text: SUCCESS_ICON, color: theme.primary }
    return { text: spinnerFrame(), color: theme.secondary }
  })

  const singleLineSummary = createMemo(() => {
    const first = props.block.questions[0]
    if (!first) return { text: "", color: theme.textSubtle }
    if (isCancelled()) return { text: `${first.question} — Cancelled`, color: theme.error }
    if (isAnswered()) {
      const answer = props.block.answers?.[first.question] ?? ""
      return { text: `${first.question} → ${answer}`, color: theme.textSubtle }
    }
    return { text: first.question, color: theme.textSubtle }
  })

  const headerContent = createMemo(() => {
    const chunks: TextChunk[] = [
      stFg(icon().color)(icon().text),
      stFg(theme.text)(" "),
      stBold(stFg(theme.text)("Ask User")),
    ]
    if (isSingleQuestion()) {
      const summary = singleLineSummary()
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(summary.color)(summary.text))
    } else {
      const detail = isCancelled()
        ? "Cancelled"
        : isAnswered()
          ? `${props.block.questions.filter(q => props.block.answers?.[q.question] !== undefined).length}/${props.block.questions.length} answered`
          : `${props.block.questions.length} questions`
      chunks.push(stFg(theme.text)(" · "))
      chunks.push(stFg(theme.textSubtle)(detail))
    }
    return new StyledText(chunks)
  })

  const header = () => (
    <box paddingLeft={1}>
      <text
        ref={(el: TextRenderable) => {
          createEffect(() => { el.content = headerContent() })
        }}
        overflow="hidden"
        wrapMode="none"
      />
    </box>
  )

  return (
    <box flexDirection="column">
      {header()}
      <Show when={!isSingleQuestion() && isResolved()}>
        <box flexDirection="column" paddingLeft={4}>
          <For each={props.block.questions}>
            {(q) => {
              const answer = props.block.answers?.[q.question]
              const unanswered = answer === undefined
              const rowChunks: TextChunk[] = [
                stDim(stFg(theme.textMuted)("·")),
                unanswered
                  ? stFg(theme.textMuted)(` ${q.question} (unanswered)`)
                  : stFg(theme.textSubtle)(` ${q.question} → ${answer}`),
              ]
              return (
                <text
                  ref={(el: TextRenderable) => { el.content = new StyledText(rowChunks) }}
                  overflow="hidden"
                  wrapMode="none"
                />
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}
