import { createSignal, createMemo, type Accessor } from "solid-js"
import type { QuestionBlock, QuestionEntry } from "@infra/output-blocks"

interface QuestionFormOptions {
  question: Accessor<QuestionBlock>
  onAnswer: (answers: Record<string, string>) => void
  onCancel: () => void
}

interface QuestionForm {
  questions: Accessor<QuestionEntry[]>
  total: Accessor<number>
  tab: Accessor<number>
  cursor: Accessor<number>
  editing: Accessor<boolean>
  currentQuestion: Accessor<QuestionEntry | undefined>
  multi: Accessor<boolean>
  options: Accessor<QuestionEntry["options"]>
  rowCount: Accessor<number>
  otherIndex: Accessor<number>
  isOnOther: Accessor<boolean>
  currentSelections: Accessor<string[]>
  currentCustom: Accessor<string>
  currentCustomOn: Accessor<boolean>
  selections: Accessor<string[][]>
  customText: Accessor<string[]>
  customOn: Accessor<boolean[]>
  isAnswered(i: number): boolean
  handleKey(evt: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; preventDefault: () => void }): void
}

type KeyEvent = Parameters<QuestionForm["handleKey"]>[0]

export function createQuestionForm(opts: QuestionFormOptions): QuestionForm {
  const questions = createMemo(() => opts.question().questions)
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
      opts.onCancel()
      return
    }
    opts.onAnswer(answers)
  }

  function handleKeyEditing(evt: KeyEvent): void {
    if (evt.name === "escape") {
      evt.preventDefault(); setEditing(false); return
    }
    if (evt.name === "return") {
      evt.preventDefault(); commitOther(); return
    }
    // Tab commits the custom text and advances to the next question (or
    // submits if last). Shift+Tab commits and goes back. Consistent with
    // Tab's "next" semantic outside editing mode.
    if (evt.name === "tab" && !evt.shift) {
      evt.preventDefault(); commitOther(); advance(); return
    }
    if (evt.name === "shift-tab" || (evt.name === "tab" && evt.shift)) {
      evt.preventDefault(); commitOther(); back(); return
    }
    if (evt.name === "backspace") {
      evt.preventDefault(); updateAt(setCustomText, tab(), currentCustom().slice(0, -1)); return
    }
    if (evt.name === "space") {
      evt.preventDefault(); updateAt(setCustomText, tab(), currentCustom() + " "); return
    }
    if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      evt.preventDefault(); updateAt(setCustomText, tab(), currentCustom() + evt.name); return
    }
  }

  function handleKey(evt: KeyEvent): void {
    if (editing()) { handleKeyEditing(evt); return }

    if (evt.name === "escape") {
      evt.preventDefault(); opts.onCancel(); return
    }
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      evt.preventDefault(); setCursor((i) => (i - 1 + rowCount()) % rowCount()); return
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      evt.preventDefault(); setCursor((i) => (i + 1) % rowCount()); return
    }
    if (evt.name === "tab" && !evt.shift) {
      evt.preventDefault(); advance(); return
    }
    if (evt.name === "shift-tab" || (evt.name === "tab" && evt.shift)) {
      evt.preventDefault(); back(); return
    }
    if (evt.name === "space" && multi() && !isOnOther()) {
      evt.preventDefault()
      const opt = options()[cursor()]
      if (opt) toggle(opt.label)
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      if (isOnOther()) { openOther(); return }
      const opt = options()[cursor()]
      if (!opt) return
      if (multi()) {
        // Multi: Enter does not auto-advance — user explicitly presses Tab to move on.
        toggle(opt.label)
        return
      }
      pick(opt.label)
      advance()
    }
  }

  function isAnswered(i: number): boolean {
    const sel = selections()[i] ?? []
    const custom = customOn()[i] === true && (customText()[i] ?? "").trim().length > 0
    return sel.length > 0 || custom
  }

  return {
    questions, total, tab, cursor, editing,
    currentQuestion, multi, options, rowCount, otherIndex, isOnOther,
    currentSelections, currentCustom, currentCustomOn,
    selections, customText, customOn,
    isAnswered, handleKey,
  }
}
