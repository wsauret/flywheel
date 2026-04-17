/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { BOLD, DIM } from "@tui/shared/ui/text-attributes"
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

  // Header row — common to both single and multi-question cases
  const header = () => (
    <box flexDirection="row" gap={1} paddingLeft={1} overflow="hidden">
      <text fg={icon().color} flexShrink={0}>{icon().text}</text>
      <text fg={theme.text} attributes={BOLD} flexShrink={0}>Ask User</text>
      <Show when={isSingleQuestion()} fallback={
        <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">
          {isCancelled() ? "Cancelled" : isAnswered() ? `${props.block.questions.length} questions answered` : `${props.block.questions.length} questions`}
        </text>
      }>
        <text fg={singleLineSummary().color} flexShrink={1} overflow="hidden" wrapMode="none">{singleLineSummary().text}</text>
      </Show>
    </box>
  )

  return (
    <box flexDirection="column">
      {header()}
      <Show when={!isSingleQuestion() && isAnswered()}>
        <box flexDirection="column" paddingLeft={4}>
          <For each={props.block.questions}>
            {(q) => (
              <box flexDirection="row" gap={1} overflow="hidden">
                <text fg={theme.textMuted} attributes={DIM} flexShrink={0}>·</text>
                <text fg={theme.textSubtle} flexShrink={1} overflow="hidden" wrapMode="none">
                  {q.question} → {props.block.answers?.[q.question] ?? ""}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
