/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { createReadRetry } from "../../../protocol/client/background-reads.js"
import type { LeadQuestionOutcome } from "../../../protocol/modules/lead.js"
import { createQuestionInputRegistry, type QuestionInputContext } from "../../components/question-input.js"
import { useTheme } from "../../context/theme.js"
import { useRevealInTranscript } from "../../context/transcript-reveal.js"
import { useRowWidth } from "../../context/row-width.js"
import { MarkdownBody } from "../../output-blocks/markdown/markdown-body.js"
import { QuestionDock } from "../../question-dock.js"
import type { TuiStripKeyClaim, TuiStripKeyEvent } from "../../tui-module.js"
import type { TuiModuleClientHost } from "../../tui-module-client.js"

/** What a question widget reads and sends: the chat's live question, the answer and skip that the chat's own dock
 *  sends, and the drafts that every dock of one question shares. */
export type LeadQuestionHost = Pick<TuiModuleClientHost, "client" | "question" | "answerQuestion" | "cancelQuestion" | "questionDrafts">

/** The key claim that the lead's strip lends, and whether its input holds no draft. */
interface StripKeys {
  readonly claim: TuiStripKeyClaim
  readonly composerEmpty: Accessor<boolean>
}

/** A pending widget's keys. */
interface QuestionWidgetKeys {
  readonly toolUseId: string
  readonly openedAt: number
  readonly input: QuestionInputContext
  /** Scrolls the lead's transcript so that it shows the widget, when a key moved focus to it. */
  readonly reveal: () => void
}

/** The key focus of the question widgets in the lead's transcript (PI-LEAD-005). The person moves focus into the
 *  newest pending widget with shift+Up from an empty input, moves between pending widgets with shift+Up and
 *  shift+Down, and leaves with Escape; a click in a widget focuses it. A key that moves focus scrolls the transcript
 *  to the widget; a click does not, so the widget never moves under the pointer. Plain Up stays with the input, which
 *  recalls queued messages and history with it, and moves the option cursor of a focused widget. A widget never takes
 *  focus by itself. The lead's strip lends its key claim through `bind`, and while the claim holds focus every key and
 *  paste goes to the focused widget's form. */
export interface LeadQuestionFocus {
  /** The ask_user call of the widget that holds key focus; undefined while none does. */
  readonly focused: Accessor<string | undefined>
  /** Adds a pending widget, and answers its removal, which gives focus back to the input when it held it. */
  register(widget: QuestionWidgetKeys): () => void
  focus(toolUseId: string): void
  /** Gives focus back to the lead's input. */
  release(): void
  bind(keys: StripKeys | undefined): void
  onKey(event: TuiStripKeyEvent): boolean
  /** Gives a paste to the focused widget's form; false while no widget holds focus. */
  paste(text: string): boolean
}

export function createLeadQuestionFocus(): LeadQuestionFocus {
  // Read only when a key or a click arrives.
  const widgets = new Map<string, QuestionWidgetKeys>()
  const [target, setTarget] = createSignal<string>()
  const [bound, setBound] = createSignal<StripKeys>()
  const focused = (): string | undefined => bound()?.claim.focused() ? target() : undefined
  const ordered = (): QuestionWidgetKeys[] => [...widgets.values()].toSorted((left, right) => left.openedAt - right.openedAt)
  const release = (): void => { untrack(bound)?.claim.setFocused(false) }
  const focus = (toolUseId: string): void => {
    const keys = untrack(bound)
    if (!keys || !widgets.has(toolUseId)) return
    setTarget(toolUseId)
    keys.claim.setFocused(true)
  }
  return {
    focused,
    register(widget) {
      widgets.set(widget.toolUseId, widget)
      return () => {
        if (widgets.get(widget.toolUseId) !== widget) return
        widgets.delete(widget.toolUseId)
        if (untrack(focused) === widget.toolUseId) release()
      }
    },
    focus,
    release,
    bind: setBound,
    onKey(event) {
      const keys = untrack(bound)
      if (!keys) return false
      if (!keys.claim.focused()) {
        if (event.ctrl || event.meta || !event.shift || event.name !== "up" || !keys.composerEmpty()) return false
        const newest = ordered().at(-1)
        if (!newest) return false
        focus(newest.toolUseId)
        newest.reveal()
        return true
      }
      const pending = ordered()
      const index = pending.findIndex((widget) => widget.toolUseId === untrack(target))
      if (event.shift && !event.ctrl && !event.meta && (event.name === "up" || event.name === "down")) {
        const next = pending[Math.min(Math.max(index + (event.name === "up" ? -1 : 1), 0), pending.length - 1)]
        if (next) {
          setTarget(next.toolUseId)
          next.reveal()
        }
        return true
      }
      const widget = pending[index]
      if (!widget) {
        release()
        return false
      }
      const taken = widget.input.input(event)
      // A form that sends its answer swallows every key, Escape included; Escape still leaves it.
      if (event.name === "escape") release()
      return taken || event.name === "escape"
    },
    paste(text) {
      const widget = untrack(focused)
      return widget !== undefined && (widgets.get(widget)?.input.paste(text) ?? false)
    },
  }
}

/** How the keys reach the widgets. The line shows in every state of the widget's focus, so focus never moves a row. */
const KEYS_HINT = "shift+↑ from the empty input to answer by key · shift+↑↓ other questions"

/** The widget of one chat's question in the lead's transcript (PI-LEAD-005): while the question waits, its context and
 *  the chat's own question dock, which sends the answer to the chat as the chat's dock does; once the question is
 *  settled anywhere, the answer or the skip in a few muted lines. It reads where the question stands at its mount and
 *  again at each change of the chat's live question until the question is settled, which never changes again. A read
 *  that fails reads again with the client core's backoff (ARCH-PROTOCOL-019). */
export function LeadQuestionWidget(props: { readonly sessionId: string; readonly toolUseId: string; readonly host: LeadQuestionHost; readonly focus: LeadQuestionFocus }) {
  const [outcome, setOutcome] = createSignal<LeadQuestionOutcome>()
  // One message names one call of one chat, so the read is fixed for the widget's lifetime.
  const { client, request } = untrack(() => ({ client: props.host.client, request: { type: "lead.question" as const, sessionId: props.sessionId, toolUseId: props.toolUseId } }))
  const retry = createReadRetry(client, "lead question", () => { void refresh() })
  let reading = 0
  async function refresh(): Promise<void> {
    const read = ++reading
    try {
      const next = await retry.read(() => client.query(request))
      if (read !== reading) return
      retry.succeeded()
      setOutcome(next)
    } catch (cause) {
      if (read === reading) retry.failed(cause)
    }
  }
  createEffect(on(() => props.host.question(props.sessionId)?.toolUseId, () => {
    if (isSettled(outcome())) return
    retry.expedite()
    void refresh()
  }))
  onCleanup(() => {
    reading += 1
    retry.dispose()
  })
  // Each part mounts once for its state: a fresh outcome of the same state keeps the form and its focus.
  const sameState = (left: LeadQuestionOutcome | undefined, right: LeadQuestionOutcome | undefined): boolean => left?.state === right?.state
  const pending = createMemo(() => { const current = outcome(); return current?.state === "pending" ? current : undefined }, undefined, { equals: sameState })
  const settled = createMemo(() => { const current = outcome(); return current && current.state !== "pending" ? current : undefined }, undefined, { equals: sameState })
  return <>
    <Show when={pending()} keyed>{(current) =>
      <PendingQuestion sessionId={props.sessionId} toolUseId={props.toolUseId} pending={current} host={props.host} focus={props.focus} />
    }</Show>
    <Show when={settled()} keyed>{(current) => <SettledQuestion outcome={current} />}</Show>
  </>
}

function PendingQuestion(props: {
  readonly sessionId: string
  readonly toolUseId: string
  readonly pending: Extract<LeadQuestionOutcome, { state: "pending" }>
  readonly host: LeadQuestionHost
  readonly focus: LeadQuestionFocus
}) {
  const input = createQuestionInputRegistry()
  const revealInTranscript = useRevealInTranscript()
  let element: BoxRenderable | undefined
  const reveal = (): void => { if (element) revealInTranscript(element) }
  onCleanup(untrack(() => props.focus.register({ toolUseId: props.toolUseId, openedAt: props.pending.question.timestamp, input, reveal })))
  const row = useRowWidth()
  // Once the answer or the skip reaches the chat, keys go back to the lead's input.
  const settle = async (sent: Promise<boolean>): Promise<boolean> => {
    const ok = await sent
    if (ok && untrack(props.focus.focused) === props.toolUseId) props.focus.release()
    return ok
  }
  const { theme } = useTheme()
  const focus = (): void => { props.focus.focus(props.toolUseId) }
  return <box ref={(box: BoxRenderable) => { element = box }} flexDirection="column" flexShrink={0} paddingLeft={2} onMouseDown={focus}>
    <Show when={props.pending.context}>{(context) => <box paddingBottom={1}><MarkdownBody cache={true}>{context()}</MarkdownBody></box>}</Show>
    <QuestionDock sessionId={props.sessionId} question={props.pending.question} drafts={props.host.questionDrafts} input={input}
      width={Math.max(1, row.width() - 2)} captureFocus={() => props.focus.focused() === props.toolUseId} pointer={true} onPointer={focus}
      onAnswer={(answers) => settle(props.host.answerQuestion(props.sessionId, props.toolUseId, answers))}
      onCancel={() => settle(props.host.cancelQuestion(props.sessionId, props.toolUseId))}
      escape="leave" onLeave={props.focus.release} />
    <text fg={theme.textMuted} wrapMode="none" selectable={false}>{KEYS_HINT}</text>
  </box>
}

/** Whether a question is answered, skipped, or withdrawn: its outcome never changes again. */
const isSettled = (outcome: LeadQuestionOutcome | undefined): boolean => outcome !== undefined && outcome.state !== "pending" && outcome.state !== "unknown"

/** The lines of a settled question: each answer, or how it ended without one. */
function settledQuestionLines(outcome: Exclude<LeadQuestionOutcome, { state: "pending" }>): readonly string[] {
  switch (outcome.state) {
    case "answered": {
      const answers = Object.entries(outcome.answers)
      return answers.length === 1 ? answers.map(([, answer]) => `Answered: ${answer}`) : answers.map(([question, answer]) => `${question}: ${answer}`)
    }
    case "skipped": return ["Skipped"]
    case "withdrawn": return ["Withdrawn by the chat"]
    case "unknown": return ["No longer waits"]
  }
}

function SettledQuestion(props: { readonly outcome: Exclude<LeadQuestionOutcome, { state: "pending" }> }) {
  const { theme } = useTheme()
  return <box flexDirection="column" flexShrink={0} paddingLeft={2}>
    <For each={settledQuestionLines(props.outcome)}>{(line) => <text fg={theme.textMuted} wrapMode="word">{line}</text>}</For>
  </box>
}
