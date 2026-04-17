/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { BOLD, DIM } from "@tui/shared/ui/text-attributes"
import { SplitBorder } from "@tui/shared/ui/border"
import type { QuestionBlock } from "@infra/output-blocks"

interface QuestionDockProps {
  question: QuestionBlock
  onAnswer: (answers: Record<string, string>) => void
  onCancel: () => void
}

/**
 * Interactive prompt for Claude's AskUserQuestion tool.
 *
 * Handles 1–4 questions per invocation, each with 2–4 options and its own
 * `multiSelect` flag. Navigation model adapted from OpenCode's pattern
 * (inspiration/opencode/.../session-question-dock.tsx):
 *   - Per-question selection state (array of labels for multi, single-element for radio)
 *   - Tab forward / back to move between questions
 *   - Progress dots show which questions are answered
 *   - "Other…" opens an inline text entry scoped to the current question
 *
 * Answer format matches Claude's wire protocol (see
 * inspiration/claude-code/.../AskUserQuestionTool.tsx): `Record<questionText, string>`
 * with multi-select values comma-joined.
 */
export function QuestionDock(props: QuestionDockProps) {
  const { theme } = useTheme()

  const questions = createMemo(() => props.question.questions)
  const total = createMemo(() => questions().length)

  const [tab, setTab] = createSignal(0)
  const currentQuestion = createMemo(() => questions()[tab()])

  // Per-question: selected option labels. Arrays because multiSelect can hold multiple.
  const [selections, setSelections] = createSignal<string[][]>(
    Array.from({ length: total() }, () => []),
  )
  // Per-question: free-text ("Other") entry and whether it's active.
  const [customText, setCustomText] = createSignal<string[]>(
    Array.from({ length: total() }, () => ""),
  )
  const [customOn, setCustomOn] = createSignal<boolean[]>(
    Array.from({ length: total() }, () => false),
  )
  const [editing, setEditing] = createSignal(false)

  const [cursor, setCursor] = createSignal(0)

  const multi = createMemo(() => currentQuestion()?.multiSelect === true)
  const options = createMemo(() => currentQuestion()?.options ?? [])
  // Total rows the cursor can land on: all options + the "Other…" row.
  const rowCount = createMemo(() => options().length + 1)
  const otherIndex = createMemo(() => options().length)
  const isOnOther = createMemo(() => cursor() === otherIndex())
  const last = createMemo(() => tab() >= total() - 1)

  const currentSelections = createMemo(() => selections()[tab()] ?? [])
  const currentCustom = createMemo(() => customText()[tab()] ?? "")
  const currentCustomOn = createMemo(() => customOn()[tab()] === true)

  function updateAt<T>(setter: (u: (prev: T[]) => T[]) => void, index: number, value: T): void {
    setter((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }

  function pick(label: string): void {
    updateAt(setSelections, tab(), [label])
    updateAt(setCustomOn, tab(), false)
    setEditing(false)
  }

  function toggle(label: string): void {
    const cur = currentSelections()
    const idx = cur.indexOf(label)
    const next = idx >= 0 ? cur.filter((_, i) => i !== idx) : [...cur, label]
    updateAt(setSelections, tab(), next)
  }

  function openOther(): void {
    updateAt(setCustomOn, tab(), true)
    setEditing(true)
  }

  function commitOther(): void {
    setEditing(false)
    const text = currentCustom().trim()
    if (!text) {
      updateAt(setCustomOn, tab(), false)
    }
  }

  function advance(): void {
    if (last()) {
      submit()
      return
    }
    setTab(tab() + 1)
    // Reset cursor to first option of the next question. Preserve existing selections.
    setCursor(0)
    setEditing(false)
  }

  function back(): void {
    if (tab() <= 0) return
    setTab(tab() - 1)
    setCursor(0)
    setEditing(false)
  }

  function submit(): void {
    const all = questions()
    const sels = selections()
    const custom = customText()
    const customFlags = customOn()

    const answers: Record<string, string> = {}
    for (let i = 0; i < all.length; i++) {
      const q = all[i]
      if (!q) continue
      const parts: string[] = []
      const picks = sels[i] ?? []
      parts.push(...picks)
      if (customFlags[i]) {
        const text = (custom[i] ?? "").trim()
        if (text) parts.push(text)
      }
      if (parts.length > 0) {
        answers[q.question] = parts.join(", ")
      }
    }

    if (Object.keys(answers).length === 0) {
      // Nothing selected anywhere — treat as cancel so Claude doesn't get an empty allow.
      props.onCancel()
      return
    }
    props.onAnswer(answers)
  }

  useKeyboard((evt) => {
    if (editing()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setEditing(false)
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        commitOther()
        return
      }
      // Tab commits the custom text and advances to the next question (or
      // submits if last). Shift+Tab commits and goes back. Consistent with
      // Tab's "next" semantic outside editing mode.
      if (evt.name === "tab" && !evt.shift) {
        evt.preventDefault()
        commitOther()
        advance()
        return
      }
      if (evt.name === "shift-tab" || (evt.name === "tab" && evt.shift)) {
        evt.preventDefault()
        commitOther()
        back()
        return
      }
      if (evt.name === "backspace") {
        evt.preventDefault()
        updateAt(setCustomText, tab(), currentCustom().slice(0, -1))
        return
      }
      if (evt.name === "space") {
        evt.preventDefault()
        updateAt(setCustomText, tab(), currentCustom() + " ")
        return
      }
      if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
        evt.preventDefault()
        updateAt(setCustomText, tab(), currentCustom() + evt.name)
        return
      }
      return
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      props.onCancel()
      return
    }

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      evt.preventDefault()
      setCursor((i) => (i - 1 + rowCount()) % rowCount())
      return
    }

    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      evt.preventDefault()
      setCursor((i) => (i + 1) % rowCount())
      return
    }

    if (evt.name === "tab" && !evt.shift) {
      evt.preventDefault()
      advance()
      return
    }
    if (evt.name === "shift-tab" || (evt.name === "tab" && evt.shift)) {
      evt.preventDefault()
      back()
      return
    }

    if (evt.name === "space" && multi() && !isOnOther()) {
      evt.preventDefault()
      const opt = options()[cursor()]
      if (opt) toggle(opt.label)
      return
    }

    if (evt.name === "return") {
      evt.preventDefault()
      if (isOnOther()) {
        openOther()
        return
      }
      const opt = options()[cursor()]
      if (!opt) return
      if (multi()) {
        toggle(opt.label)
        // Multi: Enter does not auto-advance — user explicitly presses Tab to move on.
        return
      }
      pick(opt.label)
      advance()
    }
  })

  const progress = () => `Question ${tab() + 1} of ${total()}`
  const isAnswered = (i: number): boolean => {
    const sel = selections()[i] ?? []
    const custom = customOn()[i] === true && (customText()[i] ?? "").trim().length > 0
    return sel.length > 0 || custom
  }

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundElement}
      border={["left"]}
      borderColor={theme.primary}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box flexDirection="row" gap={1} paddingBottom={1}>
        <text fg={theme.primary} attributes={BOLD}>Ask User</text>
        <Show when={total() > 1}>
          <text fg={theme.textMuted} attributes={DIM}>{"\u00B7"}</text>
          <text fg={theme.textMuted}>{progress()}</text>
          <text fg={theme.textMuted}>{" "}</text>
          <For each={questions()}>
            {(_, i) => (
              <text fg={i() === tab() ? theme.primary : (isAnswered(i()) ? theme.success : theme.textMuted)}>
                {i() === tab() ? "\u25CF" : (isAnswered(i()) ? "\u25CF" : "\u25CB")}
              </text>
            )}
          </For>
        </Show>
      </box>

      <text fg={theme.text}>{currentQuestion()?.question ?? ""}</text>

      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <For each={options()}>
          {(opt, i) => {
            const isCursor = () => cursor() === i()
            const isPicked = () => currentSelections().includes(opt.label)
            const indicator = () => {
              if (multi()) return isPicked() ? "\u25A3" : "\u25A1"  // ▣ filled / ▢ empty (checkbox toggle)
              // Single-select: the cursor itself marks the highlighted option —
              // user confirms with Enter, so there's no separate "picked" state
              // to distinguish from "on cursor".
              return isCursor() ? "\u25CF" : "\u25CB"              // ● under cursor / ○ not
            }
            const indicatorColor = () => (multi() ? (isPicked() ? theme.primary : (isCursor() ? theme.primary : theme.textMuted)) : (isCursor() ? theme.primary : theme.textMuted))
            const labelColor = () => isCursor() ? theme.text : theme.textMuted
            return (
              <box flexDirection="row" gap={1} overflow="hidden">
                <text fg={indicatorColor()} flexShrink={0}>{indicator()}</text>
                <text fg={labelColor()} flexShrink={1} overflow="hidden" wrapMode="none">
                  {opt.description ? `${opt.label} \u2014 ${opt.description}` : opt.label}
                </text>
              </box>
            )
          }}
        </For>

        <box flexDirection="row" gap={1} overflow="hidden">
          <text fg={isOnOther() ? theme.primary : theme.textMuted} flexShrink={0}>
            {(() => {
              const filled = multi()
                ? currentCustomOn() && currentCustom().trim().length > 0
                : isOnOther() || (currentCustomOn() && currentCustom().trim().length > 0)
              if (multi()) return filled ? "\u25A3" : "\u25A1"
              return filled ? "\u25CF" : "\u25CB"
            })()}
          </text>
          <text fg={isOnOther() ? theme.text : theme.textMuted} flexShrink={1} overflow="hidden" wrapMode="none">
            {currentCustomOn() && currentCustom() ? `Other — ${currentCustom()}` : "Other\u2026"}
          </text>
        </box>
      </box>

      <Show when={editing()}>
        <box flexDirection="row" gap={1} paddingBottom={1} overflow="hidden">
          <text fg={theme.textMuted} flexShrink={0}>{"\u25B8"}</text>
          <text fg={theme.text} flexShrink={1} flexGrow={1} wrapMode="word">
            {currentCustom() + "_"}
          </text>
        </box>
      </Show>

      <box flexDirection="row">
        <Show when={editing()} fallback={
          <text fg={theme.textMuted} attributes={DIM}>
            <Show when={multi()} fallback="Enter select">Space toggle · Enter submit/open Other</Show>
            {" \u00B7 \u2191\u2193 navigate"}
            <Show when={total() > 1}>{" \u00B7 Tab next \u00B7 Shift+Tab back"}</Show>
            {" \u00B7 Esc cancel"}
          </text>
        }>
          <text fg={theme.textMuted} attributes={DIM}>
            Enter submit {"\u00B7"} Esc back to options
            <Show when={total() > 1}>{" \u00B7 Tab next \u00B7 Shift+Tab back"}</Show>
          </text>
        </Show>
      </box>
    </box>
  )
}
