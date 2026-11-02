import type { QuestionBlock, QuestionChoice, QuestionEntry } from "@infra/output-blocks"
import { formatQuestionChoiceAnswer, type AgentInputAnswer } from "../protocol/question-protocol-types.js"
import { type Accessor, batch, createEffect, createSignal, on } from "solid-js"
import { questionSkip } from "../protocol/client/question-settlement.js"
import type { QuestionDraftNamespace, QuestionFormDraft } from "./hooks/create-draft-cache.js"
import { createControlledTextEditor, MULTILINE_TEXT_ENTRY_POLICY, type TextEditorPresentation, type TextEntryVisualLine } from "./keymap/text-entry.js"

interface QuestionAnswers { [question: string]: AgentInputAnswer }
interface QuestionFormOptions {
  question: Accessor<QuestionBlock>
  ownerId?: Accessor<string>
  /** Holds the input the person has not sent yet. The form clears its draft
   *  when it sends an answer or a cancel, and writes it again when the send
   *  is refused, so a question that leaves holds a draft only when this
   *  client did not settle it. */
  drafts?: QuestionDraftNamespace
  onAnswer: (answers: QuestionAnswers) => boolean | void | Promise<boolean | void>
  onCancel: () => boolean | void | Promise<boolean | void>
}
interface Answer {
  picked: ReadonlySet<number>
  freeformPicked: boolean
}
/** A validation message. It names the choice it belongs to, or no choice when
 *  it is about the question as a whole. */
interface QuestionFormError {
  readonly message: string
  readonly choiceIndex?: number
}
type KeyEvent = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string; raw?: string; preventDefault?: () => void }

export interface QuestionForm {
  questions: Accessor<QuestionEntry[]>
  total: Accessor<number>
  tab: Accessor<number>
  cursor: Accessor<number>
  currentQuestion: Accessor<QuestionEntry | undefined>
  currentChoices: Accessor<QuestionChoice[]>
  currentFreeform: Accessor<string>
  currentFreeformPresentation: Accessor<TextEditorPresentation>
  editorError: Accessor<QuestionFormError | undefined>
  multi: Accessor<boolean>
  settlement: Accessor<"idle" | "sending" | "accepted">
  isOnFreeform: Accessor<boolean>
  isOnEditable: Accessor<boolean>
  isPicked(choiceIndex: number): boolean
  isAnswered(questionIndex: number): boolean
  editorPresentation(choiceIndex: number): TextEditorPresentation
  focusEditor(choiceIndex: number, offset: number): void
  focusFreeform(offset: number): void
  setEditorVisualLines(choiceIndex: number, lines: readonly TextEntryVisualLine[]): void
  setCurrentFreeformVisualLines(lines: readonly TextEntryVisualLine[]): void
  handleKey(evt: KeyEvent): boolean
  handlePaste(text: string): void
}

export function createQuestionForm(opts: QuestionFormOptions): QuestionForm {
  const questions = () => opts.question().questions
  const total = () => questions().length
  const ownerId = () => opts.ownerId?.() ?? ""
  const loadDraft = () => opts.drafts?.get(ownerId(), opts.question().toolUseId)
  const initialDraft = loadDraft()
  const [tab, setTab] = createSignal(initialDraft?.tab ?? 0)
  const currentQuestion = () => questions()[tab()]
  const currentChoices = (): QuestionChoice[] => currentQuestion()?.choices ?? []
  const multi = () => currentQuestion()?.multiSelect === true
  const blankAnswer = (): Answer => ({ picked: new Set(), freeformPicked: false })
  const answersFromDraft = (draft: QuestionFormDraft | undefined): Answer[] => draft
    ? draft.answers.map((answer) => ({ picked: new Set(answer.picked), freeformPicked: answer.freeformPicked }))
    : Array.from({ length: total() }, blankAnswer)
  // eslint-disable-next-line solid/reactivity -- total() initializes state; question identity is the sole reset trigger below
  const [answers, setAnswers] = createSignal<Answer[]>(answersFromDraft(initialDraft))
  const [cursor, setCursor] = createSignal(initialDraft?.cursor ?? 0)
  const [editorError, setEditorError] = createSignal<QuestionFormError>()
  let editorVisualLines = createVisualLines()
  let editorValues = createEditorValues(initialDraft)
  let editors = createEditors()
  const [settlement, setSettlement] = createSignal<"idle" | "sending" | "accepted">("idle")
  let submission = 0

  createEffect(on([ownerId, () => opts.question().toolUseId], () => {
    const draft = loadDraft()
    batch(() => {
      setTab(draft?.tab ?? 0)
      setAnswers(answersFromDraft(draft))
      setCursor(draft?.cursor ?? 0)
      setEditorError(undefined)
    })
    setSettlement("idle")
    submission += 1
    editorVisualLines = createVisualLines()
    editorValues = createEditorValues(draft)
    editors = createEditors()
  }, { defer: true }))

  const currentAnswer = () => answers()[tab()] ?? blankAnswer()
  const freeformIndex = () => currentChoices().findIndex((choice) => choice.kind === "freeform")
  const currentFreeform = () => textAt(tab(), freeformIndex())
  const isOnFreeform = () => cursor() === freeformIndex() && freeformIndex() >= 0
  const isOnEditable = () => isEditableChoice(currentChoices()[cursor()])
  const emptyPresentation = (value = ""): TextEditorPresentation => ({ value, cursor: 0, selection: null, preferredVisualColumn: null })
  const currentFreeformPresentation = () => editorPresentation(freeformIndex())

  function createVisualLines(): (readonly TextEntryVisualLine[])[][] {
    return questions().map((question) => question.choices.map(() => []))
  }

  function createEditorValue(initialValue: string) {
    const [read, write] = createSignal(initialValue)
    return { read, write }
  }

  function createEditorValues(draft?: QuestionFormDraft) {
    return questions().map((question, questionIndex) => question.choices.map((choice, choiceIndex) => (
      isEditableChoice(choice) ? createEditorValue(draft?.editorText[questionIndex]?.[choiceIndex] ?? "") : undefined
    )))
  }

  function textAt(questionIndex: number, choiceIndex: number): string {
    return editorValues[questionIndex]?.[choiceIndex]?.read() ?? ""
  }

  function setText(questionIndex: number, choiceIndex: number, text: string): void {
    const choice = questions()[questionIndex]?.choices[choiceIndex]
    const answer = answers()[questionIndex] ?? blankAnswer()
    const value = editorValues[questionIndex]?.[choiceIndex]
    if (!choice || !value) return
    value.write(text)
    const hasText = text.trim().length > 0
    if (choice.kind === "freeform") {
      updateAnswer(questionIndex, { picked: hasText ? new Set() : answer.picked, freeformPicked: hasText })
    } else {
      const picked = questions()[questionIndex]?.multiSelect ? new Set(answer.picked) : new Set<number>()
      if (hasText) picked.add(choiceIndex)
      else picked.delete(choiceIndex)
      updateAnswer(questionIndex, { picked, freeformPicked: false })
    }
    setEditorError(undefined)
  }

  function createEditors() {
    return questions().map((question, questionIndex) => question.choices.map((choice, choiceIndex) => isEditableChoice(choice) ? createControlledTextEditor({
      value: () => textAt(questionIndex, choiceIndex),
      setValue: (value) => { setText(questionIndex, choiceIndex, value) },
      policy: MULTILINE_TEXT_ENTRY_POLICY,
      visualLines: () => editorVisualLines[questionIndex]?.[choiceIndex] ?? [],
    }) : undefined))
  }

  function currentDraft(): QuestionFormDraft {
    return {
      tab: tab(),
      cursor: cursor(),
      answers: answers().map((answer) => ({ picked: [...answer.picked], freeformPicked: answer.freeformPicked })),
      editorText: questions().map((question, questionIndex) => question.choices.map((_choice, choiceIndex) => textAt(questionIndex, choiceIndex))),
    }
  }

  function persistDraft(): void {
    if (settlement() !== "idle") return
    opts.drafts?.set(ownerId(), opts.question().toolUseId, currentDraft())
  }

  function updateAnswer(index: number, patch: Partial<Answer>): void {
    setAnswers((previous) => {
      const next = [...previous]
      next[index] = { ...(next[index] ?? blankAnswer()), ...patch }
      return next
    })
    persistDraft()
  }

  function editorPresentation(choiceIndex: number): TextEditorPresentation {
    return editors[tab()]?.[choiceIndex]?.presentation() ?? emptyPresentation(textAt(tab(), choiceIndex))
  }

  function focusEditor(choiceIndex: number, offset: number): void {
    if (settlement() !== "idle" || !isEditableChoice(currentChoices()[choiceIndex])) return
    setCursor(choiceIndex)
    editors[tab()]?.[choiceIndex]?.setCursor(offset)
    setEditorError(undefined)
    persistDraft()
  }

  function focusFreeform(offset: number): void { focusEditor(freeformIndex(), offset) }
  function setEditorVisualLines(choiceIndex: number, lines: readonly TextEntryVisualLine[]): void {
    const row = editorVisualLines[tab()]
    if (row) row[choiceIndex] = lines
  }
  function setCurrentFreeformVisualLines(lines: readonly TextEntryVisualLine[]): void { setEditorVisualLines(freeformIndex(), lines) }

  // A named pick and the Other answer exclude each other in the picked state
  // only. The typed Other text stays, so a pick never discards input.
  function pickOption(choiceIndex: number): void {
    if (!multi()) {
      updateAnswer(tab(), { picked: new Set([choiceIndex]), freeformPicked: false })
      return
    }
    const next = new Set(currentAnswer().picked)
    if (next.has(choiceIndex)) next.delete(choiceIndex)
    else next.add(choiceIndex)
    updateAnswer(tab(), { picked: next, freeformPicked: false })
  }

  function isPicked(choiceIndex: number): boolean {
    const choice = currentChoices()[choiceIndex]
    return choice?.kind === "freeform" ? currentAnswer().freeformPicked : currentAnswer().picked.has(choiceIndex)
  }

  function answerIsValid(questionIndex: number): boolean {
    const question = questions()[questionIndex]
    const answer = answers()[questionIndex]
    if (!question || !answer || (answer.picked.size === 0 && !answer.freeformPicked)) return false
    return [...answer.picked].every((index) => {
      const choice = question.choices[index]
      return choice?.kind === "option" && (!choice.requiresText || textAt(questionIndex, index).trim().length > 0)
    })
  }

  function isAnswered(questionIndex: number): boolean { return answerIsValid(questionIndex) }
  function cursorForQuestion(index: number): number {
    const question = questions()[index]
    const answer = answers()[index]
    if (!question || !answer) return 0
    const other = question.choices.findIndex((choice) => choice.kind === "freeform")
    if (other >= 0 && answer.freeformPicked) return other
    return answer.picked.values().next().value ?? 0
  }

  function advance(): void {
    setEditorError(undefined)
    if (tab() >= total() - 1) { submit(); return }
    const next = tab() + 1
    setTab(next)
    setCursor(cursorForQuestion(next))
    persistDraft()
  }
  function back(): void {
    if (tab() <= 0) return
    const next = tab() - 1
    setEditorError(undefined)
    setTab(next)
    setCursor(cursorForQuestion(next))
    persistDraft()
  }
  function beginSettlement(): boolean {
    if (settlement() !== "idle") return false
    setSettlement("sending")
    opts.drafts?.clear(ownerId(), opts.question().toolUseId)
    return true
  }
  async function settle(action: () => boolean | void | Promise<boolean | void>): Promise<void> {
    const attempt = submission
    let accepted: boolean | void
    try {
      accepted = await action()
    } catch {
      accepted = false
    }
    if (attempt !== submission) return
    setSettlement(accepted === false ? "idle" : "accepted")
    persistDraft()
  }
  function submit(): void {
    const invalid = questions().findIndex((_question, index) => !answerIsValid(index))
    if (invalid >= 0) {
      setTab(invalid)
      const answer = answers()[invalid]
      const missingText = [...(answer?.picked ?? [])].find((index) => {
        const choice = questions()[invalid]?.choices[index]
        return choice?.kind === "option" && choice.requiresText && !textAt(invalid, index).trim()
      })
      if (missingText !== undefined) {
        setCursor(missingText)
        setEditorError({ message: "Enter a response", choiceIndex: missingText })
      } else {
        setEditorError({ message: "Select an option" })
      }
      persistDraft()
      return
    }
    if (!beginSettlement()) return
    const record: QuestionAnswers = {}
    for (const [index, question] of questions().entries()) {
      const answer = resolvedAnswer(index)
      if (answer) record[question.question] = answer
    }
    void settle(() => opts.onAnswer(record))
  }

  function resolvedAnswer(questionIndex: number): AgentInputAnswer | undefined {
    const question = questions()[questionIndex]
    const answer = answers()[questionIndex]
    if (!question || !answer) return undefined
    return resolvedQuestionAnswer(question, answer, question.choices.map((_choice, choiceIndex) => textAt(questionIndex, choiceIndex)))
  }

  // Escape skips the question it shows. The complete answers to the other
  // questions of the call stay given, so the call settles with them.
  function cancel(): void {
    const skip = questionSkip(questions().map((question, index) => [
      question.question,
      index !== tab() && answerIsValid(index) ? resolvedAnswer(index) : undefined,
    ]))
    if (!beginSettlement()) return
    void settle(skip.kind === "answer" ? () => opts.onAnswer(skip.answers) : opts.onCancel)
  }

  function handleNavigation(evt: KeyEvent): boolean {
    const rows = currentChoices().length
    const plain = !evt.ctrl && !evt.meta && !evt.shift
    if (rows === 0) return false
    if (plain && evt.name === "up") { evt.preventDefault?.(); setEditorError(undefined); setCursor((index) => (index - 1 + rows) % rows); persistDraft(); return true }
    if (plain && evt.name === "down") { evt.preventDefault?.(); setEditorError(undefined); setCursor((index) => (index + 1) % rows); persistDraft(); return true }
    if (plain && total() > 1 && evt.name === "left") { evt.preventDefault?.(); back(); return true }
    if (plain && total() > 1 && evt.name === "right") { evt.preventDefault?.(); advance(); return true }
    return false
  }

  function activate(choiceIndex: number): void {
    const choice = currentChoices()[choiceIndex]
    if (!choice) return
    setEditorError(undefined)
    setCursor(choiceIndex)
    if (choice.kind === "freeform") {
      persistDraft()
      return
    }
    pickOption(choiceIndex)
    if (!multi() && !choice.requiresText) advance()
  }

  /** The choice a plain 1-9 key names, if the current question has it. */
  function numberShortcut(evt: KeyEvent): number | undefined {
    if (evt.name.length !== 1 || evt.name < "1" || evt.name > "9" || evt.ctrl || evt.meta) return undefined
    const index = Number(evt.name) - 1
    return index < currentChoices().length ? index : undefined
  }

  function handleSelection(evt: KeyEvent): boolean {
    const shortcut = numberShortcut(evt)
    if (shortcut !== undefined) { evt.preventDefault?.(); activate(shortcut); return true }
    const choice = currentChoices()[cursor()]
    if (evt.name === "space" && multi() && choice?.kind === "option") { evt.preventDefault?.(); pickOption(cursor()); return true }
    if (evt.name !== "return") return false
    evt.preventDefault?.()
    if (!choice) return true
    if (multi()) {
      if (choice.kind === "option" && !isAnswered(tab())) pickOption(cursor())
      if (choice.kind === "option" && choice.requiresText) return true
      advance()
      return true
    }
    activate(cursor())
    return true
  }

  function handleKey(evt: KeyEvent): boolean {
    if (settlement() !== "idle") { evt.preventDefault?.(); return true }
    if ((evt.name === "up" || evt.name === "down") && handleNavigation(evt)) return true
    const choice = currentChoices()[cursor()]
    // A digit that names another choice selects it while the focused field is
    // still empty. Once the field holds text, every digit is text.
    const shortcut = numberShortcut(evt)
    const selectsAnotherChoice = shortcut !== undefined && shortcut !== cursor() && textAt(tab(), cursor()) === ""
    if (isEditableChoice(choice) && !selectsAnotherChoice) {
      const editor = editors[tab()]?.[cursor()]
      const result = editor?.handleKey(evt) ?? "unhandled"
      if (result === "cancel") { cancel(); return true }
      if (result === "submit") {
        const text = textAt(tab(), cursor())
        if (!text.trim()) setEditorError({ message: "Enter a response", choiceIndex: cursor() })
        else {
          if (choice?.kind === "freeform") setText(tab(), cursor(), text)
          advance()
        }
        return true
      }
      if (result === "handled") return true
    }
    if (evt.name === "escape") { evt.preventDefault?.(); cancel(); return true }
    if (handleNavigation(evt)) return true
    return handleSelection(evt)
  }

  function handlePaste(text: string): void {
    if (settlement() !== "idle" || !isOnEditable()) return
    editors[tab()]?.[cursor()]?.handlePaste(text)
  }

  return {
    questions, total, tab, cursor, currentQuestion, currentChoices, currentFreeform, currentFreeformPresentation,
    editorError, multi, settlement, isOnFreeform, isOnEditable, isPicked, isAnswered,
    editorPresentation, focusEditor, focusFreeform, setEditorVisualLines, setCurrentFreeformVisualLines, handleKey, handlePaste,
  }
}

function isEditableChoice(choice: QuestionChoice | undefined): boolean {
  return choice?.kind === "freeform" || (choice?.kind === "option" && choice.requiresText === true)
}

function resolvedQuestionAnswer(question: QuestionEntry, answer: Answer, editorText: readonly string[]): AgentInputAnswer | undefined {
  const selections: Array<{ choiceId: string; text?: string }> = []
  for (let index = 0; index < question.choices.length; index++) {
    const choice = question.choices[index]
    if (choice?.kind !== "option" || !answer.picked.has(index) || !choice.choiceId) continue
    const text = editorText[index]?.trim()
    selections.push({ choiceId: choice.choiceId, ...(text ? { text } : {}) })
  }
  const freeformIndex = question.choices.findIndex((choice) => choice.kind === "freeform")
  const freeform = answer.freeformPicked ? editorText[freeformIndex]?.trim() : ""
  if (freeform) return { kind: "freeform", text: freeform }
  if (selections.length === 0) return undefined
  return { kind: "choice", selections, text: formatQuestionChoiceAnswer(question, selections) }
}