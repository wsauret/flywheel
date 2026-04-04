/** @jsxImportSource @opentui/solid */
/**
 * QuestionPrompt — TUI component for interactive question dialogs
 *
 * Presents questions with option
 * selection, tab navigation for multi-question requests, and a confirm
 * tab for review before submission.
 *
 * Pure logic lives in `./question-prompt-logic.ts` for testability.
 */

import { createStore } from "solid-js/store"
import { createMemo, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TextareaRenderable, TextareaAction } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useDialog } from "@tui/shared/context/dialog"
import type { QuestionRequest, QuestionService } from "../../queue/question-service"
import {
  createInitialStore,
  selectOption,
  selectTab,
  moveTo,
  commitCustom,
  setCustomText,
  submitAnswers,
  rejectQuestion,
  isSingle,
  isConfirmTab,
  isMulti,
  isTextOnly,
  hasCustom,
  isOther,
  optionCount,
  tabCount,
  keyboardHints,
} from "./question-prompt-logic"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QuestionPromptProps {
  request: QuestionRequest
  questionService: QuestionService
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuestionPrompt(props: QuestionPromptProps) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => isSingle(questions()))
  const [store, setStore] = createStore(createInitialStore(props.request.questions))

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => isConfirmTab(questions(), store.tab))
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => hasCustom(question()))
  const textOnly = createMemo(() => isTextOnly(question()))
  const other = createMemo(() => isOther(question(), store.selected))
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => isMulti(question()))
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  function submit() {
    submitAnswers(store, questions(), props.request, props.questionService)
  }

  function reject() {
    rejectQuestion(props.request, props.questionService)
  }

  function doSelectOption() {
    const result = selectOption(store, questions())
    if (Object.keys(result.patch).length > 0) {
      // Apply each patch key individually for solid-js/store compatibility
      for (const [key, value] of Object.entries(result.patch)) {
        setStore(key as keyof typeof store, value as never)
      }
    }
    if (result.fastPath) {
      // Single-select single-question: submit immediately
      const answers = questions().map((_, i) => store.answers[i] ?? [])
      // Use the patched answers since setStore is synchronous in solid
      if (result.patch.answers) {
        props.questionService.reply(props.request.id, result.patch.answers as string[][])
      } else {
        props.questionService.reply(props.request.id, answers)
      }
    }
  }

  // Ref for the textarea in textOnly mode (for imperative clear)
  let textareaRef: TextareaRenderable | undefined

  // Handle input changes from the <input> element (custom option mode)
  function handleTextInput(value: string) {
    setStore("custom", setCustomText(store.custom, store.tab, value))
  }

  // Handle content changes from the <textarea> element (textOnly mode)
  // Note: onContentChange fires with {} (not the text), so read from ref
  function handleTextareaChange() {
    const text = textareaRef?.plainText ?? ""
    setStore("custom", setCustomText(store.custom, store.tab, text))
  }

  // Handle submit from textarea (Enter key remapped to submit action)
  function handleTextSubmit() {
    const text = textareaRef?.plainText ?? ""
    const result = commitCustom(store, questions(), text)
    for (const [key, value] of Object.entries(result.patch)) {
      setStore(key as keyof typeof store, value as never)
    }
    if (result.fastPath) {
      const answers = result.patch.answers ?? store.answers
      props.questionService.reply(props.request.id, answers as string[][])
    }
  }

  // Handle special keys from the <input>/<textarea> element (escape, enter, ctrl+u)
  function handleTextKeyDown(evt: { name?: string; ctrl?: boolean; preventDefault?: () => void }) {
    if (evt.name === "escape") {
      evt.preventDefault?.()
      if (textOnly()) {
        reject()
      } else {
        setStore("editing", false)
      }
      return
    }
    if (evt.ctrl && evt.name === "u") {
      evt.preventDefault?.()
      // For textarea, read from ref since store may lag; for input, use store
      const text = textOnly() ? (textareaRef?.plainText ?? "") : input()
      if (!text) {
        setStore("editing", false)
        return
      }
      setStore("custom", setCustomText(store.custom, store.tab, ""))
      textareaRef?.clear()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault?.()
      const result = commitCustom(store, questions(), input())
      for (const [key, value] of Object.entries(result.patch)) {
        setStore(key as keyof typeof store, value as never)
      }
      if (result.fastPath) {
        const answers = result.patch.answers ?? store.answers
        props.questionService.reply(props.request.id, answers as string[][])
      }
    }
  }

  // Keyboard handler
  useKeyboard((evt) => {
    // Skip if a dialog is open
    if (dialog.isOpen()) return

    // Editing mode: the <input> element handles text editing, cursor, arrow keys.
    // Only intercept keys not handled by handleTextKeyDown here.
    if (store.editing && !confirm()) {
      return
    }

    // Tab navigation: left/right/tab
    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      const next = selectTab(questions(), store.tab - 1)
      setStore("tab", next.tab)
      setStore("selected", next.selected)
      return
    }

    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      const next = selectTab(questions(), store.tab + 1)
      setStore("tab", next.tab)
      setStore("selected", next.selected)
      return
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      const direction = evt.shift ? -1 : 1
      const next = selectTab(questions(), store.tab + direction)
      setStore("tab", next.tab)
      setStore("selected", next.selected)
      return
    }

    // Confirm tab
    if (confirm()) {
      if (evt.name === "return") {
        evt.preventDefault()
        submit()
        return
      }
      if (evt.name === "escape") {
        evt.preventDefault()
        reject()
        return
      }
      return
    }

    // Question tab: option navigation and selection
    const q = question()
    const total = optionCount(q)
    const max = Math.min(total, 9)
    const digit = Number(evt.name)

    if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
      evt.preventDefault()
      const next = moveTo(q, digit - 1)
      setStore("selected", next.selected)
      doSelectOption()
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      const next = moveTo(q, store.selected - 1)
      setStore("selected", next.selected)
      return
    }

    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      const next = moveTo(q, store.selected + 1)
      setStore("selected", next.selected)
      return
    }

    if (evt.name === "return") {
      evt.preventDefault()
      doSelectOption()
      return
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      reject()
      return
    }
  })

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.primary}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        {/* Tab bar (only for multi-question) */}
        <Show when={!single()}>
          <box flexDirection="row" gap={1} paddingLeft={1}>
            <For each={questions()}>
              {(q, index) => {
                const isActive = () => index() === store.tab
                const isAnswered = () => (store.answers[index()]?.length ?? 0) > 0
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={isActive() ? theme.primary : theme.backgroundPanel}
                  >
                    <text
                      fg={
                        isActive()
                          ? theme.background
                          : isAnswered()
                            ? theme.text
                            : theme.textMuted
                      }
                    >
                      {q.header}
                    </text>
                  </box>
                )
              }}
            </For>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={confirm() ? theme.primary : theme.backgroundPanel}
            >
              <text fg={confirm() ? theme.background : theme.textMuted}>Confirm</text>
            </box>
          </box>
        </Show>

        {/* Question content */}
        <Show when={!confirm()}>
          <box paddingLeft={1} gap={1}>
            <box>
              <text fg={theme.text}>
                {question()?.question}
                {multi() ? " (select all that apply)" : ""}
              </text>
            </box>

            {/* Text-only mode: textarea input, no options */}
            <Show when={textOnly()}>
              <box paddingLeft={1} flexDirection="row">
                <text fg={theme.primary} flexShrink={0}>{"▸ "}</text>
                <textarea
                  ref={textareaRef}
                  initialValue={input()}
                  placeholder="Type your answer..."
                  placeholderColor={theme.textMuted}
                  height={3}
                  wrapMode="word"
                  onContentChange={handleTextareaChange}
                  onSubmit={handleTextSubmit}
                  onKeyDown={handleTextKeyDown}
                  focused={store.editing}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                  cursorColor={theme.primary}
                  backgroundColor="transparent"
                  focusedBackgroundColor="transparent"
                  flexGrow={1}
                  keyBindings={[
                    { name: "return", action: "submit" as TextareaAction },
                    { name: "z", ctrl: true, action: "undo" as TextareaAction },
                    { name: "z", ctrl: true, shift: true, action: "redo" as TextareaAction },
                  ]}
                />
              </box>
            </Show>

            {/* Options mode: option list + optional custom */}
            <Show when={!textOnly()}>
              <box>
                {/* Regular options */}
                <For each={options()}>
                  {(opt, i) => {
                    const active = () => i() === store.selected
                    const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                    return (
                      <box>
                        <box flexDirection="row">
                          <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                            <text fg={active() ? theme.textMuted : theme.textMuted}>
                              {`${i() + 1}.`}
                            </text>
                          </box>
                          <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                            <text fg={active() ? theme.secondary : picked() ? theme.success : theme.text}>
                              {multi() ? `[${picked() ? "✓" : " "}] ${opt.label}` : opt.label}
                            </text>
                          </box>
                          <Show when={!multi()}>
                            <text fg={theme.success}>{picked() ? " ✓" : ""}</text>
                          </Show>
                        </box>
                        <box paddingLeft={3}>
                          <text fg={theme.textMuted}>{opt.description}</text>
                        </box>
                      </box>
                    )
                  }}
                </For>

                {/* Custom option */}
                <Show when={custom()}>
                  <box>
                    <box flexDirection="row">
                      <box backgroundColor={other() ? theme.backgroundElement : undefined} paddingRight={1}>
                        <text fg={other() ? theme.textMuted : theme.textMuted}>
                          {`${options().length + 1}.`}
                        </text>
                      </box>
                      <box backgroundColor={other() ? theme.backgroundElement : undefined}>
                        <text fg={other() ? theme.secondary : customPicked() ? theme.success : theme.text}>
                          {multi()
                            ? `[${customPicked() ? "✓" : " "}] Type your own answer`
                            : "Type your own answer"}
                        </text>
                      </box>
                      <Show when={!multi()}>
                        <text fg={theme.success}>{customPicked() ? " ✓" : ""}</text>
                      </Show>
                    </box>
                    <Show when={store.editing}>
                      <box paddingLeft={3}>
                        <input
                          value={input()}
                          placeholder="Type your answer..."
                          placeholderColor={theme.textMuted}
                          onInput={handleTextInput}
                          onKeyDown={handleTextKeyDown}
                          focused={true}
                          textColor={theme.text}
                          focusedTextColor={theme.text}
                          cursorColor={theme.primary}
                          backgroundColor="transparent"
                          focusedBackgroundColor="transparent"
                          flexGrow={1}
                          keyBindings={[
                            { name: "z", ctrl: true, action: "undo" as TextareaAction },
                            { name: "z", ctrl: true, shift: true, action: "redo" as TextareaAction },
                          ]}
                        />
                      </box>
                    </Show>
                    <Show when={!store.editing && input()}>
                      <box paddingLeft={3}>
                        <text fg={theme.textMuted}>{input()}</text>
                      </box>
                    </Show>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
        </Show>

        {/* Confirm tab: review answers */}
        <Show when={confirm() && !single()}>
          <box paddingLeft={1}>
            <text fg={theme.text}>Review</text>
          </box>
          <For each={questions()}>
            {(q, index) => {
              const value = () => store.answers[index()]?.join(", ") ?? ""
              const answered = () => Boolean(value())
              return (
                <box paddingLeft={1}>
                  <text>
                    <span style={{ fg: theme.textMuted }}>{q.header}:</span>{" "}
                    <span style={{ fg: answered() ? theme.text : theme.error }}>
                      {answered() ? value() : "(not answered)"}
                    </span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>

      {/* Keyboard hints bar */}
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between"
      >
        <box flexDirection="row" gap={2}>
          <Show when={!single()}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>tab</span>
            </text>
          </Show>
          <Show when={!confirm() && !textOnly()}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
          </Show>
          <text fg={theme.text}>
            enter{" "}
            <span style={{ fg: theme.textMuted }}>
              {confirm()
                ? "submit"
                : textOnly()
                  ? "submit"
                  : multi()
                    ? "toggle"
                    : single()
                      ? "submit"
                      : "confirm"}
            </span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>dismiss</span>
          </text>
        </box>
      </box>
    </box>
  )
}
