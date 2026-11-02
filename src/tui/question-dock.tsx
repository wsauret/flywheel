/** @jsxImportSource @opentui/solid */

import type { QuestionBlock, QuestionChoice } from "@infra/output-blocks"
import { MouseButton, StyledText, bg as stBg, bold as stBold, fg as stFg, type BoxRenderable, type MouseEvent, type TextChunk, type TextRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useQuestionInput } from "@tui/components/question-input"
import { OpaqueBox } from "@tui/components/opaque-box"
import { useTheme } from "@tui/context/theme"
import { VerticalBarBorder } from "@tui/utils/border"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import type { AgentInputAnswer } from "../protocol/question-protocol-types.js"
import type { DraftCache } from "./hooks/create-draft-cache.js"
import { MarkdownBody } from "./output-blocks/markdown/markdown-body.js"
import { createQuestionForm } from "./question-dock-form.js"
import { layoutQuestionDockEditor } from "./question-dock-editor-layout.js"
import { createModalScrollController } from "./components/modal-scroll-controller.js"

interface QuestionAnswers {
  [question: string]: AgentInputAnswer
}

interface QuestionDockProps {
  sessionId: string
  question: QuestionBlock
  draftCache: DraftCache
  width: number
  /** False while an overlay covers the dock, so the dock leaves the terminal cursor alone. */
  captureFocus: () => boolean
  escapeHint?: string
  onAnswer: (answers: QuestionAnswers) => Promise<boolean>
  onCancel: () => Promise<boolean>
  /** Reports whether the dock has measured its content. Until it has, it
   *  takes no rows and paints nothing, so its owner keeps showing what the
   *  dock replaces. */
  onMeasured?: (measured: boolean) => void
}

const NUMBER_SHORTCUT_CEILING = 9
const QUESTION_DOCK_CHROME_WIDTH = 5

// The blank rows that separate the dock's parts. The dock gives them back in
// this order when its rows are short, so the content rows (the header, the
// question, every choice, and the key hint) show before any blank row. The
// gap above the choices helps the reader most and the outer padding helps
// least.
const SPACING_SLOTS = ["choicesTop", "headerBottom", "choicesBottom", "top", "bottom"] as const
type SpacingSlot = typeof SPACING_SLOTS[number]

/** The spacing slots the dock keeps when it gets `allottedRows` rows and its
 *  content without spacing needs `contentRows`. Only spare rows become blank
 *  rows. */
function dockSpacing(allottedRows: number, contentRows: number): ReadonlySet<SpacingSlot> {
  return new Set(SPACING_SLOTS.slice(0, Math.max(0, allottedRows - contentRows)))
}

export function QuestionDock(props: QuestionDockProps) {
  const themeContext = useTheme()
  const { theme } = themeContext
  const renderer = useRenderer()
  const scroll = createModalScrollController()
  onCleanup(scroll.detach)

  const form = createQuestionForm({
    question: () => props.question,
    ownerId: () => props.sessionId,
    // eslint-disable-next-line solid/reactivity -- the draft cache is one object for the dock's lifetime
    drafts: props.draftCache.questions,
    onAnswer: (answers) => props.onAnswer(answers),
    onCancel: () => props.onCancel(),
  })

  // Registers with the single question-input authority instead of an
  // independent global listener, so a real modal opened over a pending
  // question (e.g. the auth modal) is dispatched to first - see
  // question-input.tsx.
  const questionInput = useQuestionInput()
  onMount(() => { questionInput.register({ onKey: form.handleKey, onPaste: form.handlePaste }) })
  onCleanup(() => { questionInput.clear() })

  // The editable row under the dock cursor places the terminal cursor while it
  // renders, as the prompt textarea does. Nothing renders a caret elsewhere, so
  // the dock hides the cursor when the caret leaves the editable rows.
  const caretShown = () => props.captureFocus() && form.isOnEditable()
  createEffect(() => { if (!caretShown()) renderer.setCursorPosition(0, 0, false) })
  onCleanup(() => renderer.setCursorPosition(0, 0, false))

  function chipChunks(index: number): TextChunk[] {
    const q = form.questions()[index]
    if (!q) return []
    const isActive = index === form.tab()
    const isAnswered = form.isAnswered(index)
    const color = isActive ? theme.primary : isAnswered ? theme.success : theme.textMuted
    const glyph = isActive || isAnswered ? "\u25CF" : "\u25CB"
    const label = q.header ?? `Q${index + 1}`
    return [stFg(color)(` ${glyph} ${label}`)]
  }

  // One question carries its own header as the dock title, as the web panel
  // shows it. Several questions keep one title and show each header as a chip.
  const headerContent = () => {
    const single = form.total() === 1 ? form.questions()[0]?.header : undefined
    const chunks: TextChunk[] = [stBold(stFg(theme.primary)(single ?? "Ask User"))]
    if (form.total() > 1) {
      chunks.push(stFg(theme.textMuted)(" \u00B7 "))
      for (let i = 0; i < form.total(); i++) chunks.push(...chipChunks(i))
    }
    return new StyledText(chunks)
  }

  const questionText = () => form.currentQuestion()?.question ?? ""

  function rowStyle(choiceIndex: number) {
    const isCursor = form.cursor() === choiceIndex
    const picked = form.isPicked(choiceIndex)
    const glyph = form.multi()
      ? (picked ? "\u25A3" : "\u25A1")
      : (picked ? "\u25CF" : "\u25CB")
    return {
      glyph,
      indicatorColor: picked || isCursor ? theme.primary : theme.textMuted,
      labelColor: isCursor ? theme.text : theme.textMuted,
      shortcut: choiceIndex < NUMBER_SHORTCUT_CEILING ? `${choiceIndex + 1}. ` : "",
      isCursor,
    }
  }

  function optionRowContent(choice: Extract<QuestionChoice, { kind: "option" }>, choiceIndex: number): StyledText {
    const style = rowStyle(choiceIndex)
    const body = choice.description ? `${choice.label} - ${choice.description}` : choice.label
    const chunks: TextChunk[] = [
      stFg(style.indicatorColor)(style.glyph),
      stFg(style.labelColor)(` ${style.shortcut}${body}`),
    ]
    if (choice.recommended) chunks.push(stFg(theme.success)(" (Recommended)"))
    return new StyledText(chunks)
  }

  function EditableRow(rowProps: { choice: QuestionChoice; choiceIndex: number }) {
    const measured = createMeasuredWidth(() => props.width - QUESTION_DOCK_CHROME_WIDTH)
    let textElement: TextRenderable | undefined
    const prefix = () => {
      const style = rowStyle(rowProps.choiceIndex)
      if (rowProps.choice.kind === "freeform") {
        return { text: `${style.glyph} ${style.shortcut}${rowProps.choice.label} - `, recommended: undefined }
      }
      const body = rowProps.choice.description ? `${rowProps.choice.label} - ${rowProps.choice.description}` : rowProps.choice.label
      const recommended = rowProps.choice.recommended ? " (Recommended)" : ""
      const text = `${style.glyph} ${style.shortcut}${body}${recommended} - `
      return {
        text,
        recommended: recommended ? { start: text.length - recommended.length - 3, end: text.length - 3 } : undefined,
      }
    }
    // One layout per change serves content, mouse hit testing, and the cursor placed on every frame.
    const layout = createMemo(() => {
      const style = rowStyle(rowProps.choiceIndex)
      const presentation = form.editorPresentation(rowProps.choiceIndex)
      const result = layoutQuestionDockEditor({
        prefix: prefix().text,
        value: presentation.value,
        cursor: presentation.cursor,
        selection: presentation.selection,
        width: measured.width() || 10_000,
        showCaret: style.isCursor && props.captureFocus(),
      })
      form.setEditorVisualLines(rowProps.choiceIndex, result.visualLines)
      return result
    })
    const content = () => {
      const style = rowStyle(rowProps.choiceIndex)
      const currentLayout = layout()
      const recommendedSource = prefix().recommended
      const recommended = recommendedSource
        ? currentLayout.prefixRange(recommendedSource.start, recommendedSource.end)
        : undefined
      const text = currentLayout.text
      const boundaries = new Set([0, style.glyph.length, text.length])
      if (recommended) { boundaries.add(recommended.start); boundaries.add(recommended.end) }
      for (const selection of currentLayout.selections) { boundaries.add(selection.start); boundaries.add(selection.end) }
      const points = [...boundaries].sort((left, right) => left - right)
      const chunks: TextChunk[] = []
      for (let index = 0; index < points.length - 1; index++) {
        const start = points[index] ?? 0
        const end = points[index + 1] ?? start
        const value = text.slice(start, end)
        if (!value) continue
        if (currentLayout.selections.some((selection) => start >= selection.start && end <= selection.end)) {
          chunks.push(stBg(theme.selectionBackground)(stFg(theme.selectionForeground)(value)))
        } else if (recommended && start >= recommended.start && end <= recommended.end) {
          chunks.push(stFg(theme.success)(value))
        } else {
          chunks.push(stFg(start < style.glyph.length ? style.indicatorColor : style.labelColor)(value))
        }
      }
      return new StyledText(chunks)
    }
    const placeCursor = (event: MouseEvent) => {
      if (event.button !== MouseButton.LEFT || !textElement) return
      event.preventDefault()
      event.stopPropagation()
      form.focusEditor(rowProps.choiceIndex, layout().cursorOffsetAt(event.x - textElement.x, event.y - textElement.y))
    }
    return (
      <box ref={(element: BoxRenderable) => {
        measured.ref(element)
        // The box, not the text, places the cursor: text renderables skip
        // renderAfter. The text sits at the box's origin.
        // oxlint-disable-next-line solid/reactivity -- boundary: OpenTUI calls renderAfter on every frame, so it reads the current layout untracked
        element.renderAfter = function () {
          const caret = layout().caret
          if (!caret) return
          // The scrollbox clips glyphs, not the terminal cursor.
          const row = this.screenY + caret.row
          if (!scroll.showsScreenRow(row)) { renderer.setCursorPosition(0, 0, false); return }
          // Terminal cursor coordinates are one-based.
          renderer.setCursorPosition(this.screenX + caret.column + 1, row + 1, true)
          renderer.setCursorStyle({ style: "block", blinking: true, color: themeContext.cursorColor })
        }
      }} selectable={false} onMouseDown={placeCursor}>
        <text ref={(element: TextRenderable) => {
          textElement = element
          createEffect(() => {
            element.content = content()
            if (form.cursor() === rowProps.choiceIndex) scroll.scrollIntoView(element, { preferTop: true, row: layout().caret?.row })
          })
        }} overflow="hidden" wrapMode="none" selectable={false} />
      </box>
    )
  }

  const hintsContent = () => {
    const chunks: TextChunk[] = []
    const push = (text: string) => chunks.push(stFg(theme.textMuted)(text))
    if (form.settlement() !== "idle") {
      push(form.settlement() === "sending" ? "Sending response..." : "Response received")
      return new StyledText(chunks)
    }
    // Enter moves to the next question until the last one, which it submits.
    // Inside a text row the arrow keys move the caret, not the question.
    const enter = form.tab() < form.total() - 1 ? "enter next" : "enter submit"
    if (form.isOnEditable()) {
      push(`type · shift/ctrl+enter newline · ${enter}`)
    } else {
      push("1-9 select · ")
      push(form.multi() ? `space toggle · ${enter}` : "enter select")
    }
    push(" · ↑↓ navigate")
    if (form.total() > 1 && !form.isOnEditable()) push(" \u00B7 \u2190\u2192 question")
    push(` \u00B7 esc ${props.escapeHint ?? "cancel"}`)
    return new StyledText(chunks)
  }

  // The dock gets the rows its layout leaves. It scrolls inside them and
  // keeps the focused choice visible, with the question above it whenever
  // both fit, so a long question never pushes the choices out of the frame.
  // The dock measures two heights. `contentRows` is its content without
  // any spacing row. `allottedRows` is the height of its scrollbox, which is
  // what the layout leaves. Yoga cannot size a shrinking scrollbox from its
  // content reliably, so the dock asks for its full spaced height as a fixed
  // basis. Yoga lays out once per frame, so the dock cannot know that basis
  // on the frame it mounts. It spends that frame out of the flow and fully
  // transparent: its content is measured, it takes no rows from the
  // transcript, and its owner keeps the prompt on screen. On the next frame
  // it takes its measured rows in one step. The basis never reads
  // `allottedRows`, so a dock that went compact
  // in a short terminal gets its spacing back when the terminal grows. The
  // measured content height excludes the padding from that same Yoga layout,
  // not the spacing signal, which size callbacks can change before this one.
  // A size callback runs after this frame's layout, so a change it made would
  // paint against that stale layout: the prompt would vanish before the dock
  // took its rows. The measurement waits for the next frame's lifecycle pass,
  // which runs before that frame's layout.
  const [contentRows, setContentRows] = createSignal(0)
  let laidOutContentRows = 0
  const [allottedRows, setAllottedRows] = createSignal<number>()
  const measured = () => contentRows() > 0
  createEffect(() => props.onMeasured?.(measured()))
  onCleanup(() => props.onMeasured?.(false))
  const spacing = createMemo(() => dockSpacing(allottedRows() ?? Number.POSITIVE_INFINITY, contentRows()))
  let laidOutPadding = untrack(spacing).size
  const gap = (slot: SpacingSlot) => spacing().has(slot) ? 1 : 0
  // The scrollbar shows only while the content does not fit. Its own rule
  // reads the sizes of the previous layout, so it would flash on the first
  // frame of every question.
  const overflowing = () => contentRows() > (allottedRows() ?? Number.POSITIVE_INFINITY)
  const content = () => (
    <box flexDirection="column" flexShrink={0} paddingTop={gap("top")} paddingBottom={gap("bottom")}
      onSizeChange={function (this: BoxRenderable) {
        if (!Number.isFinite(this.height)) return
        laidOutContentRows = this.height - laidOutPadding
        if (laidOutContentRows !== contentRows()) this.requestRender()
      }}>
      <box paddingBottom={gap("headerBottom")}>
        <text ref={(el: TextRenderable) => { createEffect(() => { el.content = headerContent() }) }} overflow="hidden" wrapMode="none" />
      </box>

      <box>
        <MarkdownBody cache={true} dimColor={form.isAnswered(form.tab())}>{questionText()}</MarkdownBody>
      </box>

      <box flexDirection="column" paddingTop={gap("choicesTop")} paddingBottom={gap("choicesBottom")}>
        <Key each={form.currentChoices()} by={(choice) => choice.kind === "option" ? `option:${choice.choiceId}` : "freeform"}>
          {(choice, i) => {
            const editable = () => { const current = choice(); return current.kind === "freeform" || current.requiresText }
            return (
            <>
              {editable()
                ? <EditableRow choice={choice()} choiceIndex={i()} />
                : (
                    <text
                      ref={(element: TextRenderable) => {
                        createEffect(() => {
                          const current = choice()
                          if (current.kind === "option") element.content = optionRowContent(current, i())
                          if (form.cursor() === i()) scroll.scrollIntoView(element, { preferTop: true })
                        })
                      }}
                      wrapMode="word"
                    />
                  )}
              <Show when={form.editorError()?.choiceIndex === i() ? form.editorError() : undefined}>
                {(error) => <text fg={theme.error}>{`  ${error().message}`}</text>}
              </Show>
            </>
          )}}
        </Key>
        <Show when={form.editorError()?.choiceIndex === undefined ? form.editorError() : undefined}>
          {(error) => <text fg={theme.error}>{`  ${error().message}`}</text>}
        </Show>
      </box>

      <text ref={(el: TextRenderable) => { createEffect(() => { el.content = hintsContent() }) }} />
    </box>
  )
  // The dock scrolls only its content. The rail and the fill stay
  // outside the scrollbox, because a scrollbox clips its content rows but
  // not the border of a box taller than its viewport. The vertical padding
  // moves inside the scrollbox as spacing slots, so a short dock spends its
  // rows on content first. The dock scrolls only when even its content
  // without spacing is taller than its rows. The viewport overflows as a
  // scroll container, because Yoga then measures the content at its full
  // height, which the scroll range needs.
  return (
    <OpaqueBox
      flexDirection="column"
      flexShrink={1}
      position={measured() ? "relative" : "absolute"}
      left={0}
      right={0}
      bottom={0}
      opacity={measured() ? 1 : 0}
      flexBasis={measured() ? contentRows() + SPACING_SLOTS.length : "auto"}
      // Assigned before insertion, so the parent registers the pass.
      ref={(element: BoxRenderable) => { element.onLifecyclePass = () => untrack(() => {
        setContentRows(laidOutContentRows)
        // Capture before size callbacks can choose spacing for the next layout.
        laidOutPadding = spacing().size
      }) }}
      paddingLeft={2}
      paddingRight={2}
      // The raised fill sits inside the border ring: the rail column keeps
      // the default background so Terminal.app renders the bar connected.
      interiorColor={theme.backgroundRaised}
      // The left divider acts as an attachment point to the transcript above:
      // this dock is the active input surface, not a passive status card.
      border={["left"]}
      borderColor={theme.primary}
      customBorderChars={VerticalBarBorder}
    >
      <scrollbox ref={scroll.attach}
        onSizeChange={function (this: BoxRenderable) { if (Number.isFinite(this.height) && measured()) setAllottedRows(this.height) }} minHeight={1} flexBasis={0} flexGrow={1} scrollY={true} scrollX={false} viewportOptions={{ overflow: "scroll" }} verticalScrollbarOptions={{ visible: overflowing() }}>
        {content()}
      </scrollbox>
    </OpaqueBox>
  )
}
