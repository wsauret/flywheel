/** @jsxImportSource @opentui/solid */

import { Show, createEffect } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { StyledText, fg as stFg, bold as stBold, dim as stDim, type TextChunk } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { SplitBorder } from "@tui/shared/ui/border"
import type { QuestionBlock } from "@infra/output-blocks"
import { createQuestionForm } from "./question-dock-form.js"

interface QuestionDockProps {
  question: QuestionBlock
  onAnswer: (answers: Record<string, string>) => void
  onCancel: () => void
}

export function QuestionDock(props: QuestionDockProps) {
  const { theme } = useTheme()

  const form = createQuestionForm({
    question: () => props.question,
    onAnswer: (a) => props.onAnswer(a),
    onCancel: () => props.onCancel(),
  })

  useKeyboard(form.handleKey)

  // Header: "Ask User · Question N of M ● ○ ○" — composed as chunks on a single
  // <text> so the full line is selectable as one region (ADR-006 §8b).
  const headerContent = () => {
    const chunks: TextChunk[] = [stBold(stFg(theme.primary)("Ask User"))]
    if (form.total() > 1) {
      chunks.push(stDim(stFg(theme.textMuted)(" \u00B7 ")))
      chunks.push(stFg(theme.textMuted)(`Question ${form.tab() + 1} of ${form.total()} `))
      form.questions().forEach((_, i) => {
        const color = i === form.tab() ? theme.primary : (form.isAnswered(i) ? theme.success : theme.textMuted)
        const glyph = i === form.tab() || form.isAnswered(i) ? "\u25CF" : "\u25CB"
        chunks.push(stFg(color)(` ${glyph}`))
      })
    }
    return new StyledText(chunks)
  }

  const questionContent = () => new StyledText([stFg(theme.text)(form.currentQuestion()?.question ?? "")])

  function optionContent(label: string, description: string | undefined, isCursor: boolean, isPicked: boolean): StyledText {
    // Single-select shows the cursor as the "picked" glyph; multi-select has a
    // distinct checkbox toggle independent of cursor position.
    const glyph = form.multi()
      ? (isPicked ? "\u25A3" : "\u25A1")
      : (isCursor ? "\u25CF" : "\u25CB")
    const indicatorColor = (form.multi() && isPicked) || isCursor ? theme.primary : theme.textMuted
    const labelColor = isCursor ? theme.text : theme.textMuted
    const text = description ? `${label} \u2014 ${description}` : label
    return new StyledText([
      stFg(indicatorColor)(glyph),
      stFg(labelColor)(` ${text}`),
    ])
  }

  function otherContent(): StyledText {
    const onOther = form.isOnOther()
    const custom = form.currentCustom()
    const hasText = custom.trim().length > 0
    const filled = form.multi() ? (form.currentCustomOn() && hasText) : (onOther || (form.currentCustomOn() && hasText))
    const glyph = form.multi()
      ? (filled ? "\u25A3" : "\u25A1")
      : (filled ? "\u25CF" : "\u25CB")
    const indicatorColor = onOther ? theme.primary : theme.textMuted
    const labelColor = onOther ? theme.text : theme.textMuted
    const label = form.currentCustomOn() && custom ? `Other \u2014 ${custom}` : "Other\u2026"
    return new StyledText([
      stFg(indicatorColor)(glyph),
      stFg(labelColor)(` ${label}`),
    ])
  }

  const editingContent = () => new StyledText([
    stFg(theme.textMuted)("\u25B8"),
    stFg(theme.text)(` ${form.currentCustom()}_`),
  ])

  const hintsContent = () => {
    // Two variants: option-selection hints vs. text-editing hints.
    const chunks: TextChunk[] = []
    const push = (s: string) => chunks.push(stDim(stFg(theme.textMuted)(s)))
    if (form.editing()) {
      push("Enter submit \u00B7 Esc back to options")
      if (form.total() > 1) push(" \u00B7 Tab next \u00B7 Shift+Tab back")
    } else {
      push(form.multi() ? "Space toggle \u00B7 Enter submit/open Other" : "Enter select")
      push(" \u00B7 \u2191\u2193 navigate")
      if (form.total() > 1) push(" \u00B7 Tab next \u00B7 Shift+Tab back")
      push(" \u00B7 Esc cancel")
    }
    return new StyledText(chunks)
  }

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundElement}
      // Why the left divider is correct here: this dock is the live input surface
      // for a pending question, so the gutter acts as an attachment point to the
      // transcript above it rather than a decorative status stripe on a passive card.
      border={["left"]}
      borderColor={theme.primary}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box paddingBottom={1}>
        <text ref={(el: TextRenderable) => { createEffect(() => { el.content = headerContent() }) }} overflow="hidden" wrapMode="none" />
      </box>

      <text ref={(el: TextRenderable) => { createEffect(() => { el.content = questionContent() }) }} />

      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        {form.options().map((opt, i) => (
          <text
            ref={(el: TextRenderable) => {
              createEffect(() => { el.content = optionContent(opt.label, opt.description, form.cursor() === i, form.currentSelections().includes(opt.label)) })
            }}
            overflow="hidden"
            wrapMode="none"
          />
        ))}
        <text
          ref={(el: TextRenderable) => { createEffect(() => { el.content = otherContent() }) }}
          overflow="hidden"
          wrapMode="none"
        />
      </box>

      <Show when={form.editing()}>
        <box paddingBottom={1}>
          <text
            ref={(el: TextRenderable) => { createEffect(() => { el.content = editingContent() }) }}
            wrapMode="word"
          />
        </box>
      </Show>

      <text ref={(el: TextRenderable) => { createEffect(() => { el.content = hintsContent() }) }} />
    </box>
  )
}