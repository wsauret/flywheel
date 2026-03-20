/**
 * QuestionPrompt — Pure logic & state management
 *
 * Extracted from the JSX component so unit tests can import
 * and exercise all state transitions without pulling in OpenTUI/SolidJS.
 *
 * Adapted from OpenCode's question.tsx, replacing SDK calls with
 * QuestionService props.
 */

import type {
  QuestionInfo,
  QuestionAnswer,
  QuestionRequest,
  QuestionService,
} from "../../controller/question-service"

// ---------------------------------------------------------------------------
// Store shape (mirrors OpenCode's createStore shape)
// ---------------------------------------------------------------------------

export interface QuestionStore {
  /** Index of the currently active question tab */
  tab: number
  /** Per-question answers: array of selected option labels */
  answers: QuestionAnswer[]
  /** Per-question custom text input */
  custom: string[]
  /** Currently highlighted option index (reset on tab switch) */
  selected: number
  /** Whether custom text editing mode is active */
  editing: boolean
}

// ---------------------------------------------------------------------------
// Derivations (pure functions — used by createMemo in the component)
// ---------------------------------------------------------------------------

/** Whether this is a single-question, single-select request (fast-path eligible) */
export function isSingle(questions: QuestionInfo[]): boolean {
  return questions.length === 1 && questions[0]?.multiple !== true
}

/** Total tab count: questions + confirm tab (no confirm for single-select single-question) */
export function tabCount(questions: QuestionInfo[]): number {
  return isSingle(questions) ? 1 : questions.length + 1
}

/** Get the current question info for a given tab index, or undefined if on confirm tab */
export function currentQuestion(
  questions: QuestionInfo[],
  tab: number,
): QuestionInfo | undefined {
  return questions[tab]
}

/** Whether the current tab is the confirm tab */
export function isConfirmTab(questions: QuestionInfo[], tab: number): boolean {
  return !isSingle(questions) && tab === questions.length
}

/** Whether a question allows multiple selections */
export function isMulti(q: QuestionInfo | undefined): boolean {
  return q?.multiple === true
}

/** Whether a question is text-only (bare text input, no options) */
export function isTextOnly(q: QuestionInfo | undefined): boolean {
  return q?.textOnly === true
}

/** Whether a question has a custom/free-text option (enabled by default unless explicitly false) */
export function hasCustom(q: QuestionInfo | undefined): boolean {
  if (!q) return false
  if (isTextOnly(q)) return false // textOnly handles its own input
  return q.custom !== false
}

/** Whether the cursor is on the custom/"other" option */
export function isOther(q: QuestionInfo | undefined, selected: number): boolean {
  if (!q || !hasCustom(q)) return false
  return selected === q.options.length
}

/** Total number of selectable items for a question (options + custom if enabled) */
export function optionCount(q: QuestionInfo | undefined): number {
  if (!q) return 0
  if (isTextOnly(q)) return 0
  return q.options.length + (hasCustom(q) ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Initial store factory
// ---------------------------------------------------------------------------

export function createInitialStore(questions: QuestionInfo[]): QuestionStore {
  const firstIsTextOnly = isTextOnly(questions[0])
  return {
    tab: 0,
    answers: questions.map(() => []),
    custom: questions.map(() => ""),
    selected: 0,
    editing: firstIsTextOnly, // textOnly questions start in editing mode
  }
}

// ---------------------------------------------------------------------------
// State transition functions (pure — return patches for the store)
// ---------------------------------------------------------------------------

/** Move option cursor to a specific index (wrapping) */
export function moveTo(
  q: QuestionInfo | undefined,
  index: number,
): { selected: number } {
  const total = optionCount(q)
  if (total === 0) return { selected: 0 }
  return { selected: ((index % total) + total) % total }
}

/** Select a tab by index (wrapping), resets selected to 0. Sets editing for textOnly tabs. */
export function selectTab(
  questions: QuestionInfo[],
  index: number,
): { tab: number; selected: number; editing?: boolean } {
  const total = tabCount(questions)
  const tab = ((index % total) + total) % total
  const q = questions[tab]
  return { tab, selected: 0, ...(isTextOnly(q) ? { editing: true } : {}) }
}

/**
 * Toggle an option in a multi-select question.
 * Returns updated answers array.
 */
export function toggleAnswer(
  answers: QuestionAnswer[],
  tab: number,
  label: string,
): QuestionAnswer[] {
  const existing = answers[tab] ?? []
  const next = [...existing]
  const idx = next.indexOf(label)
  if (idx === -1) next.push(label)
  else next.splice(idx, 1)
  const result = [...answers]
  result[tab] = next
  return result
}

/**
 * Single-select pick: sets the answer to [label] for the given tab.
 * Returns updated answers array.
 */
export function pickAnswer(
  answers: QuestionAnswer[],
  tab: number,
  label: string,
): QuestionAnswer[] {
  const result = [...answers]
  result[tab] = [label]
  return result
}

/**
 * Set custom text for a tab.
 */
export function setCustomText(
  customs: string[],
  tab: number,
  text: string,
): string[] {
  const result = [...customs]
  result[tab] = text
  return result
}

/**
 * Handle "selectOption" logic — what happens when the user presses enter
 * on the currently highlighted option.
 *
 * Returns a store patch and metadata about what happened.
 */
export function selectOption(
  store: QuestionStore,
  questions: QuestionInfo[],
): {
  patch: Partial<QuestionStore>
  fastPath: boolean
  startedEditing: boolean
} {
  const q = questions[store.tab]
  if (!q) return { patch: {}, fastPath: false, startedEditing: false }

  const multi = isMulti(q)
  const other = isOther(q, store.selected)

  // Custom option selected
  if (other) {
    if (!multi) {
      return { patch: { editing: true }, fastPath: false, startedEditing: true }
    }
    // Multi + custom: toggle existing custom value or start editing
    const input = store.custom[store.tab] ?? ""
    const customPicked = input && (store.answers[store.tab]?.includes(input) ?? false)
    if (input && customPicked) {
      return {
        patch: { answers: toggleAnswer(store.answers, store.tab, input) },
        fastPath: false,
        startedEditing: false,
      }
    }
    return { patch: { editing: true }, fastPath: false, startedEditing: true }
  }

  // Regular option
  const opt = q.options[store.selected]
  if (!opt) return { patch: {}, fastPath: false, startedEditing: false }

  if (multi) {
    return {
      patch: { answers: toggleAnswer(store.answers, store.tab, opt.label) },
      fastPath: false,
      startedEditing: false,
    }
  }

  // Single-select: set answer and check for fast path
  const answers = pickAnswer(store.answers, store.tab, opt.label)
  const single = isSingle(questions)

  if (single) {
    // Fast path: single-select single-question -> submit immediately
    return { patch: { answers }, fastPath: true, startedEditing: false }
  }

  // Multi-question single-select: advance to next tab
  const next = selectTab(questions, store.tab + 1)
  return {
    patch: { answers, ...next },
    fastPath: false,
    startedEditing: false,
  }
}

/**
 * Handle committing a custom text answer (enter pressed while editing).
 */
export function commitCustom(
  store: QuestionStore,
  questions: QuestionInfo[],
  text: string,
): { patch: Partial<QuestionStore>; fastPath: boolean } {
  const q = questions[store.tab]
  const trimmed = text.trim()
  const prev = store.custom[store.tab]
  const multi = isMulti(q)

  // Empty text: clear custom answer
  if (!trimmed) {
    if (prev) {
      const customs = setCustomText(store.custom, store.tab, "")
      const answers = [...store.answers]
      answers[store.tab] = (answers[store.tab] ?? []).filter((x) => x !== prev)
      return { patch: { editing: false, custom: customs, answers }, fastPath: false }
    }
    return { patch: { editing: false }, fastPath: false }
  }

  if (multi) {
    const customs = setCustomText(store.custom, store.tab, trimmed)
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    if (prev) {
      const idx = next.indexOf(prev)
      if (idx !== -1) next.splice(idx, 1)
    }
    if (!next.includes(trimmed)) next.push(trimmed)
    const answers = [...store.answers]
    answers[store.tab] = next
    return { patch: { editing: false, custom: customs, answers }, fastPath: false }
  }

  // Single-select custom: pick it
  const answers = pickAnswer(store.answers, store.tab, trimmed)
  const customs = setCustomText(store.custom, store.tab, trimmed)
  const fastPath = isSingle(questions)

  if (!fastPath) {
    const next = selectTab(questions, store.tab + 1)
    return { patch: { editing: false, custom: customs, answers, ...next }, fastPath: false }
  }

  return { patch: { editing: false, custom: customs, answers }, fastPath: true }
}

// ---------------------------------------------------------------------------
// Submit / Reject
// ---------------------------------------------------------------------------

/** Build the final answers array for submission */
export function buildFinalAnswers(
  store: QuestionStore,
  questions: QuestionInfo[],
): QuestionAnswer[] {
  return questions.map((_, i) => store.answers[i] ?? [])
}

/** Submit answers to the question service */
export function submitAnswers(
  store: QuestionStore,
  questions: QuestionInfo[],
  request: QuestionRequest,
  service: QuestionService,
): void {
  const answers = buildFinalAnswers(store, questions)
  service.reply(request.id, answers)
}

/** Reject/dismiss the question */
export function rejectQuestion(
  request: QuestionRequest,
  service: QuestionService,
): void {
  service.reject(request.id)
}

// ---------------------------------------------------------------------------
// Keyboard hint text
// ---------------------------------------------------------------------------

export function keyboardHints(
  questions: QuestionInfo[],
  tab: number,
  editing: boolean,
  multi: boolean,
): string {
  if (editing) {
    return "enter confirm  esc cancel"
  }
  const confirm = isConfirmTab(questions, tab)
  const single = isSingle(questions)
  if (confirm) {
    return "enter submit  ⇆ tab  esc dismiss"
  }
  const parts: string[] = []
  if (!single) parts.push("⇆ tab")
  parts.push("↑↓ select")
  const action = confirm
    ? "submit"
    : multi
      ? "toggle"
      : single
        ? "submit"
        : "confirm"
  parts.push(`enter ${action}`)
  parts.push("esc dismiss")
  return parts.join("  ")
}
