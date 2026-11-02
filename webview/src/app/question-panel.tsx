import { createEffect, createMemo, createSignal, Match, on, Show, Switch, untrack, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { scrollEdges } from "./scroll-edges.js"

import { applyNamedText, resolveQuestionAnswer, type FrontendQuestionBlock, type FrontendQuestionEntry, type NamedSelectionState, type QuestionAnswer } from "../client/question-answer.js"
import { actionKey } from "../client/action-key.js"
import { questionSkip } from "../../../src/protocol/client/question-settlement.js"
import { useClient, type ClientContextValue } from "./client-context.js"
import type { ClientActions } from "../client/actions.js"
import { Icon, ICONS } from "./icons.js"

interface QuestionInteraction {
  readonly chosen: { readonly [question: string]: NamedSelectionState }
  readonly freeform: { readonly [question: string]: string }
  readonly otherOpen: { readonly [question: string]: boolean }
  readonly collapsed: boolean
}

const emptyInteraction = (): QuestionInteraction => ({
  chosen: {},
  freeform: {},
  otherOpen: {},
  collapsed: false,
})

/** Keeps each session's unanswered question choices until current data settles them. */
export function createQuestionInteractions() {
  const states = new Map<string, ReturnType<typeof createSignal<QuestionInteraction>>>()
  const restored = new Set<string>()
  const keyOf = (sessionId: string, toolUseId: string) => `${sessionId}\u0000${toolUseId}`
  const stateOf = (sessionId: string, toolUseId: string) => {
    const key = keyOf(sessionId, toolUseId)
    let state = states.get(key)
    if (state === undefined) {
      state = createSignal(emptyInteraction())
      states.set(key, state)
    }
    return state
  }
  return {
    state: stateOf,
    forget: (sessionId: string, toolUseId: string) => { restored.delete(keyOf(sessionId, toolUseId)); states.delete(keyOf(sessionId, toolUseId)) },
    restored: (sessionId: string, toolUseId: string) => restored.has(keyOf(sessionId, toolUseId)),
    edit: (sessionId: string, toolUseId: string) => { restored.delete(keyOf(sessionId, toolUseId)) },
    /** Skips the question with the picks held for it. Skip keeps every
     *  complete answer while it leaves another question unanswered, so the
     *  record marks only the skipped questions cancelled (PI-INTERACTION-009).
     *  With nothing to keep, it cancels the question. */
    skip(actions: Pick<ClientActions, "answer" | "cancelQuestion">, sessionId: string, block: FrontendQuestionBlock): void {
      const { chosen, freeform } = stateOf(sessionId, block.toolUseId)[0]()
      const settlement = questionSkip(block.questions.map((entry) => [entry.question, resolveQuestionAnswer(entry, chosen[entry.question], freeform[entry.question])]))
      if (settlement.kind === "answer") actions.answer(block.toolUseId, settlement.answers)
      else actions.cancelQuestion(block.toolUseId)
    },
    capture: (): { readonly [key: string]: QuestionInteraction } => Object.fromEntries([...states].map(([key, [read]]) => [key, read()])),
    adopt(saved: { readonly [key: string]: QuestionInteraction }): void {
      for (const [key, value] of Object.entries(saved)) {
        restored.add(key)
        const current = states.get(key)
        if (current === undefined) states.set(key, createSignal(value))
        else current[1](value)
      }
    },
  }
}

/** An attention tap reveals the question without discarding a slash draft.
 *  Editing the draft makes the command panel available again. */
export function createQuestionAttention(client: ClientContextValue, draft: Accessor<string>) {
  const [hiddenDraft, setHiddenDraft] = createSignal<string>()
  const request = createMemo(() => {
    const attention = client.attention?.()
    return attention?.sessionId === client.state().sessionId ? attention?.sequence : undefined
  })
  let handled = 0
  createEffect(on(request, (sequence) => {
    if (sequence === undefined || sequence === handled) return
    handled = sequence
    setHiddenDraft(untrack(draft))
  }))
  return { request, panelHidden: () => draft() === hiddenDraft() }
}

/** A question the agent is waiting on, docked at the composer.
 *
 *  Mirrors the TUI, where a pending question takes over the prompt area rather
 *  than sitting in the transcript: answering is the next thing to do, and the
 *  place to do it is where typing happens. The panel borrows the command
 *  panel's frame, and it leaves once the runtime records the answer; the
 *  transcript then carries the record.
 *
 *  Every choice is one row of a list: a mark, a title, and the description
 *  under it, separated by hairlines so a thumb knows where one choice ends and
 *  the next begins. A choice that needs words, and the freeform "Other" row,
 *  open their text field inside their own row once picked, so the field can
 *  only ever belong to the choice above it. */
export function QuestionPanel(props: {
  readonly block: Accessor<FrontendQuestionBlock>
  readonly interactions: ReturnType<typeof createQuestionInteractions>
  readonly sessionId: Accessor<string>
  readonly current?: Accessor<boolean>
  readonly hidden?: Accessor<boolean>
  readonly expand?: Accessor<number | undefined>
}) {
  const client = useClient()
  const state = () => props.interactions.state(props.sessionId(), props.block().toolUseId)
  const interaction = () => state()[0]()
  const update = (change: (current: QuestionInteraction) => QuestionInteraction) => {
    state()[1](change)
  }
  const chosen = () => interaction().chosen
  /** An answer or a skip waits on the runtime; the control that sent it says so. */
  const answering = () => client.actions.working(actionKey("answer", props.block().toolUseId))
  const skipping = () => client.actions.working(actionKey("skip", props.block().toolUseId))
  const freeform = () => interaction().freeform
  /** Which questions have their freeform row open; typing there keeps it open. */
  const otherOpen = () => interaction().otherOpen
  const collapsed = () => interaction().collapsed
  const held = () => props.current?.() === false
  const heldTitle = () => held() ? "Waiting for the latest messages" : undefined
  const setChosen = (change: (current: QuestionInteraction["chosen"]) => QuestionInteraction["chosen"]) =>
    update((current) => ({ ...current, chosen: change(current.chosen) }))
  const setFreeform = (change: (current: QuestionInteraction["freeform"]) => QuestionInteraction["freeform"]) =>
    update((current) => ({ ...current, freeform: change(current.freeform) }))
  const setOtherOpen = (change: (current: QuestionInteraction["otherOpen"]) => QuestionInteraction["otherOpen"]) =>
    update((current) => ({ ...current, otherOpen: change(current.otherOpen) }))
  const setCollapsed = (value: boolean | ((current: boolean) => boolean)) => {
    update((current) => {
      const updated = typeof value === "function" ? value(current.collapsed) : value
      return { ...current, collapsed: updated }
    })
  }
  createEffect(on(() => props.expand?.(), (request) => { if (request !== undefined) setCollapsed(false) }, { defer: true }))

  const questions = () => props.block().questions
  const answerFor = (entry: FrontendQuestionEntry) => resolveQuestionAnswer(entry, chosen()[entry.question], freeform()[entry.question])
  const complete = () => questions().every((entry) => answerFor(entry) !== undefined)

  const submit = () => {
    if (held() || !complete()) return
    const answers: { [question: string]: QuestionAnswer } = {}
    for (const entry of questions()) {
      const answer = answerFor(entry)
      if (answer) answers[entry.question] = answer
    }
    client.actions.answer(props.block().toolUseId, answers)
  }

  const skip = () => {
    if (!held()) props.interactions.skip(client.actions, props.sessionId(), props.block())
  }
  /** Escape anywhere in the panel skips the question, as it does at the
   *  composer and in the terminal (PI-INTERACTION-009). */
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    skip()
  }

  /** A field's height follows its text, so an answer wraps and stays in view
   *  from its first word (PI-INTERACTION-004). The measure runs at height auto,
   *  so the field also shrinks when text goes; the border is outside
   *  `scrollHeight` and is added back. */
  const fitField = (element: HTMLTextAreaElement) => {
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`
  }
  /** Focus lands in the field a pick just opened, so the next thing typed goes
   *  where it belongs, and the field scrolls into the panel's view: on a phone
   *  the keyboard shrinks the panel, and the row that opened may sit past its
   *  fold. A field that opens again over kept text fits that text first. */
  const openField = (element: HTMLTextAreaElement) => queueMicrotask(() => {
    fitField(element)
    if (props.interactions.restored(props.sessionId(), props.block().toolUseId)) return
    element.focus()
    element.scrollIntoView({ block: "nearest" })
  })

  const pick = (entry: FrontendQuestionEntry, choiceId: string | undefined) => {
    props.interactions.edit(props.sessionId(), props.block().toolUseId)
    // A pick that would change the answer already on its way joins it instead:
    // the marks keep showing the answer that was sent.
    if (!choiceId || answering()) return
    setFreeform((current) => ({ ...current, [entry.question]: "" }))
    setOtherOpen((current) => ({ ...current, [entry.question]: false }))
    setChosen((current) => {
      const existing = current[entry.question] ?? { ids: [], text: {} }
      const selected = existing.ids.includes(choiceId)
      const ids = entry.multiSelect ? (selected ? existing.ids.filter((id) => id !== choiceId) : [...existing.ids, choiceId]) : [choiceId]
      return { ...current, [entry.question]: { ...existing, ids } }
    })
  }
  /** Opening Other only opens its field. The picks stay until the person types
   *  there, because the text, not the open field, is what replaces them; the
   *  terminal dock follows the same rule. */
  const openOther = (entry: FrontendQuestionEntry) => {
    props.interactions.edit(props.sessionId(), props.block().toolUseId)
    setOtherOpen((current) => ({ ...current, [entry.question]: true }))
  }
  const typeNamed = (entry: FrontendQuestionEntry, choiceId: string, text: string) => {
    setChosen((current) => ({ ...current, [entry.question]: applyNamedText(current[entry.question] ?? { ids: [], text: {} }, choiceId, text, entry.multiSelect) }))
  }
  const typeOther = (entry: FrontendQuestionEntry, text: string) => {
    setFreeform((current) => ({ ...current, [entry.question]: text }))
    if (text.trim()) setChosen((current) => ({ ...current, [entry.question]: { ...(current[entry.question] ?? { text: {} }), ids: [] } }))
  }
  const isPicked = (question: string, choiceId: string | undefined) => choiceId ? chosen()[question]?.ids.includes(choiceId) ?? false : false
  const isOtherOpen = (question: string) => otherOpen()[question] === true
  /** Other is marked when it is what the answer would be: it has text, or it
   *  is open with no other pick beside it. */
  const isOtherPicked = (question: string) =>
    isOtherOpen(question) && (Boolean(freeform()[question]?.trim()) || (chosen()[question]?.ids.length ?? 0) === 0)
  /** Enter answers and Shift+Enter breaks the line, as in the composer. */
  const onEnter = (event: KeyboardEvent) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit() } }
  const markIcon = (entry: FrontendQuestionEntry, picked: boolean) => (
    <span class="question-mark" classList={{ "question-mark-box": entry.multiSelect, "question-mark-on": picked }} aria-hidden="true">
      <Show when={picked}><Icon path={ICONS.check} size={12} /></Show>
    </span>
  )

  /** Minimized, the panel is one strip that names the question and keeps every
   *  pick and draft; a person reads the transcript above, then taps to return.
   *  Skip is the only way to dismiss a question. With several questions, the
   *  strip counts them and names each one, so none waits unseen. */
  const collapsedHeader = () => questions().length > 1 ? `${questions().length} questions` : questions()[0]?.header ?? "Ask User"
  const collapsedText = () => questions().length > 1
    ? questions().map((entry) => entry.header ?? entry.question).join(" · ")
    : questions()[0]?.question

  return (
    <div class="command-panel question-panel" style={{ display: props.hidden?.() ? "none" : undefined }} role="group" aria-label="A question from the agent" data-collapsed={collapsed() ? "true" : "false"} onKeyDown={onEscape}>
      <Show when={collapsed()}>
        <button data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, "expand"])} class="question-collapsed" aria-expanded="false" title="Show the question" onClick={() => setCollapsed(false)}>
          <span class="question-collapsed-label">
            <span class="question-collapsed-header">{collapsedHeader()}</span>
            <span class="question-collapsed-text">{collapsedText()}</span>
          </span>
          <Icon path={ICONS.chevronUp} />
        </button>
      </Show>
      <div class="panel-scroll scroll-edges" style={{ display: collapsed() ? "none" : undefined }} ref={scrollEdges}>
        <div class="panel-scroll-content">
        <Key each={questions()} by="question">
          {(question, index) => (
            <>
              <Show when={index() > 0}><div class="panel-divider" /></Show>
              <div class="question-head">
                <span class="panel-section">
                  {question().header ?? "Ask User"}
                  <Show when={question().multiSelect}> · pick any that apply</Show>
                </span>
                <Show when={index() === 0}>
                  <button data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, "minimize"])} class="ghost" aria-expanded="true" title="Minimize the question and keep your answer" aria-label="Minimize question" onClick={() => setCollapsed(true)}>
                    <Icon path={ICONS.chevronDown} />
                  </button>
                </Show>
              </div>
              <div class="question-text">{question().question}</div>
              <div class="question-choices" role={question().multiSelect ? "group" : "radiogroup"} aria-label={question().question}>
                <Key each={question().choices} by={(choice) => choice.kind === "option" ? choice.choiceId ?? choice.label : "freeform"}>
                  {(choice) => {
                    const optionChoice = () => { const value = choice(); return value.kind === "option" ? value : undefined }
                    const freeformChoice = () => { const value = choice(); return value.kind === "freeform" ? value : undefined }
                    return (
                    <Switch>
                      <Match when={optionChoice()}>
                        {(option) => {
                          const picked = () => isPicked(question().question, option().choiceId)
                          return (
                            <div class="question-choice" data-active={picked() ? "true" : "false"}>
                              <button
                                data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, question().question, option().choiceId, "pick"])}
                                class="question-choice-row"
                                role={question().multiSelect ? "checkbox" : "radio"}
                                aria-checked={picked()}
                                onClick={() => pick(question(), option().choiceId)}
                              >
                                {markIcon(question(), picked())}
                                <span class="question-choice-body">
                                  <span class="question-choice-title">
                                    {option().label}
                                    <Show when={option().recommended}><span class="question-recommended">Recommended</span></Show>
                                  </span>
                                  <Show when={option().description}><span class="question-choice-description">{option().description}</span></Show>
                                </span>
                              </button>
                              <Show when={option().requiresText && option().choiceId && picked()}>
                                <textarea
                                  data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, question().question, option().choiceId, "text"])}
                                  ref={openField}
                                  class="question-input"
                                  rows="1"
                                  placeholder="Add the details this choice needs"
                                  aria-label={`${option().label}: ${question().question}`}
                                  value={chosen()[question().question]?.text[option().choiceId ?? ""] ?? ""}
                                  onInput={(event) => { typeNamed(question(), option().choiceId ?? "", event.currentTarget.value); fitField(event.currentTarget) }}
                                  onKeyDown={onEnter}
                                />
                              </Show>
                            </div>
                          )
                        }}
                      </Match>
                      <Match when={freeformChoice()}>
                        {(entry) => (
                          <div class="question-choice" data-active={isOtherOpen(question().question) ? "true" : "false"}>
                            <button
                              data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, question().question, "other"])}
                              aria-label={`Open ${entry().label}: ${question().question}`}
                              class="question-choice-row"
                              role={question().multiSelect ? "checkbox" : "radio"}
                              aria-checked={isOtherPicked(question().question)}
                              onClick={() => openOther(question())}
                            >
                              {markIcon(question(), isOtherPicked(question().question))}
                              <span class="question-choice-body">
                                <span class="question-choice-title">{entry().label}</span>
                                <span class="question-choice-description">{entry().placeholder ?? "Answer in your own words"}</span>
                              </span>
                            </button>
                            <Show when={isOtherOpen(question().question)}>
                              <textarea
                                data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, question().question, "freeform"])}
                                ref={openField}
                                class="question-input"
                                rows="1"
                                placeholder={entry().placeholder ?? "Type your answer"}
                                aria-label={`${entry().label}: ${question().question}`}
                                value={freeform()[question().question] ?? ""}
                                onInput={(event) => { typeOther(question(), event.currentTarget.value); fitField(event.currentTarget) }}
                                onKeyDown={onEnter}
                              />
                            </Show>
                          </div>
                        )}
                      </Match>
                    </Switch>
                    )
                  }}
                </Key>
              </div>
            </>
          )}
        </Key>
        </div>
      </div>
      <div class="panel-actions" style={{ display: collapsed() ? "none" : undefined }}>
        <button data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, "skip"])} class="ghost-text" title={heldTitle() ?? "Continue without answering"} aria-disabled={held() ? "true" : undefined} aria-busy={skipping() || undefined} onClick={skip}>Skip</button>
        <button data-input-focus={JSON.stringify([props.sessionId(), props.block().toolUseId, "answer"])} class="primary" disabled={!complete()} aria-disabled={held() ? "true" : undefined} title={heldTitle()} aria-busy={answering() || undefined} onClick={submit}>{answering() ? "Answering…" : "Answer"}</button>
      </div>
    </div>
  )
}
