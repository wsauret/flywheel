import fuzzysort from "fuzzysort"
import type { Accessor } from "solid-js"
import { createMemo, createSignal } from "solid-js"
import type { ModalSelectOption } from "../components/modal-select-types.js"

/** The leading slash token of the input (`/model`). */
const LEADING_TOKEN = /^\/[\w:.-]*/
/** Popup trigger: the text before the cursor is exactly a leading slash token,
 *  i.e. the caret sits inside the command token with no whitespace typed yet. */
const TOKEN_BEFORE_CURSOR = /^\/([\w:.-]*)$/

export interface SlashSuggestionsOptions {
  textBeforeCursor: Accessor<string>
  inputText: Accessor<string>
  catalog: () => readonly ModalSelectOption[]
  /** Command usage counts from the runtime's account-global command usage
   *  record; ranks the empty-query listing. */
  frequency: Accessor<ReadonlyMap<string, number>>
  /** Every dispatchable command token, lowercased, including hidden commands
   *  and aliases the catalog omits. An exact match outside the catalog hides
   *  the popup so enter submits the typed command instead of a fuzzy row. */
  dispatchableTokens: () => ReadonlySet<string>
}

export interface SlashSuggestionsHook {
  visible: () => boolean
  matches: () => readonly ModalSelectOption[]
  selectedIndex: () => number
  /** Move the highlight, wrapping at either end of the suggestions. */
  moveSelection: (delta: 1 | -1) => void
  /** Highlight a row; clicks activate directly. */
  select: (index: number) => void
  /** The full input text with the leading slash token replaced by the selected
   *  suggestion (trailing space when no arguments follow), or undefined when
   *  nothing is selected. */
  completedText: () => string | undefined
  /** Hide the popup for the current token; typing a different token reopens it. */
  dismiss: () => void
}

/** Suggestion state for the slash-command popup above the prompt. Matching
 *  mirrors the command palette (fuzzysort over tokens and title); an empty
 *  query lists every row by the runtime's command use counts. */
export function createSlashSuggestions(opts: SlashSuggestionsOptions): SlashSuggestionsHook & {
  /** Whether the person dismissed the popup for the token being typed. */
  dismissedHere: () => boolean
} {
  const query = createMemo(() => TOKEN_BEFORE_CURSOR.exec(opts.textBeforeCursor())?.[1])
  // Text edits invalidate the choice before deferred caret callbacks arrive.
  // Returning to an earlier query must not restore its old choice.
  const queryRevision = createMemo<number>((revision) => { query(); opts.inputText(); return revision + 1 }, 0)

  // Trigger episodes: n increments each time the caret enters a fresh slash
  // token (query transitions undefined -> defined). Dismissal is keyed to the
  // episode and token, so escape suppresses the popup only until the token
  // changes or the input stops being a slash token (submit, clear, arguments).
  const episode = createMemo(
    (prev: { n: number; active: boolean }) => {
      const active = query() !== undefined
      return active === prev.active ? prev : { n: prev.n + (active ? 1 : 0), active }
    },
    { n: 0, active: false },
  )
  const [dismissed, setDismissed] = createSignal<{ episode: number; token: string }>()
  const [selection, setSelection] = createSignal<{ revision: number; index: number; value: string }>()

  const matches = createMemo<readonly ModalSelectOption[]>(() => {
    const q = query()
    if (q === undefined) return []
    const entries = opts.catalog()
    if (!q) {
      const frequency = opts.frequency()
      return [...entries].sort((a, b) =>
        (frequency.get(b.value.slice(1)) ?? 0) - (frequency.get(a.value.slice(1)) ?? 0))
    }
    return fuzzysort
      .go(q.toLowerCase(), entries, {
        keys: ["footer", "title"],
        scoreFn: (r) => {
          const [footer, title] = r
          // SAFETY: fuzzysort yields one Result per key, so both keys above are present.
          return Math.max(footer!.score * 2, title!.score)
        },
      })
      .map((r) => r.obj)
  })

  const catalogTokens = createMemo(() => new Set(opts.catalog().map((o) => o.value.slice(1).toLowerCase())))

  function visible(): boolean {
    const q = query()
    if (q === undefined || matches().length === 0) return false
    const lower = q.toLowerCase()
    if (opts.dispatchableTokens().has(lower) && !catalogTokens().has(lower)) return false
    return !dismissedHere()
  }

  function dismissedHere(): boolean {
    const d = dismissed()
    return d !== undefined && d.episode === episode().n && d.token === query()
  }

  function currentSelection() {
    const s = selection()
    return s && s.revision === queryRevision() && matches()[s.index]?.value === s.value ? s : undefined
  }

  function selectedIndex(): number {
    return currentSelection()?.index ?? 0
  }

  function select(index: number): void {
    const row = matches()[index]
    if (!row) return
    setSelection({ revision: queryRevision(), index, value: row.value })
  }

  return {
    visible,
    matches,
    selectedIndex,
    moveSelection(delta) {
      const len = matches().length
      if (len === 0) return
      select((selectedIndex() + delta + len) % len)
    },
    select,
    completedText() {
      const selected = matches()[selectedIndex()]
      if (!selected) return undefined
      const input = opts.inputText()
      const token = LEADING_TOKEN.exec(input)?.[0] ?? input
      const rest = input.slice(token.length)
      return `${selected.value}${rest || " "}`
    },
    dismiss() {
      const q = query()
      if (q !== undefined) setDismissed({ episode: episode().n, token: q })
    },
    dismissedHere,
  }
}
