import type { Accessor } from "solid-js"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { insertMention, mentionAt, type MentionToken } from "../../protocol/client/mention.js"
import type { ProjectFileEntry } from "../../protocol/transcript-protocol-types.js"
import type { ModalSelectOption } from "../components/modal-select-types.js"
import type { SlashSuggestionsHook } from "./create-slash-suggestions.js"

const DEBOUNCE_MS = 100

export interface MentionSuggestionsOptions {
  textBeforeCursor: Accessor<string>
  inputText: Accessor<string>
  cursorOffset: Accessor<number>
  /** The runtime's ranked project entries for a query. */
  projectFiles: (query: string) => Promise<readonly ProjectFileEntry[]>
  /** How long after the last keystroke to ask; a test sets none. */
  debounceMs?: number
}

/** The `@` file picker above the prompt, shaped like the slash popup so the
 *  composer renders and drives both the same way. The token under the caret
 *  is the query; the runtime lists and ranks; a pick replaces the token with
 *  `@path` and a space, or `@dir/` and no space so the picker keeps listing
 *  what is inside. Enter picks and never submits. */
export function createMentionSuggestions(opts: MentionSuggestionsOptions): SlashSuggestionsHook {
  const token = createMemo<MentionToken | undefined>(() => mentionAt(opts.textBeforeCursor(), opts.cursorOffset()))
  const [entries, setEntries] = createSignal<readonly ProjectFileEntry[]>([])
  const [selection, setSelection] = createSignal({ query: "", index: 0 })
  const [dismissedQuery, setDismissedQuery] = createSignal<string | undefined>()
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  createEffect(on(() => token()?.query, (query) => {
    if (timer !== undefined) clearTimeout(timer)
    if (query === undefined) {
      setEntries([])
      setDismissedQuery(undefined)
      return
    }
    const mine = ++generation
    timer = setTimeout(() => {
      void opts.projectFiles(query).then((found) => {
        if (mine === generation) setEntries(found)
      })
    }, opts.debounceMs ?? DEBOUNCE_MS)
  }))
  onCleanup(() => { if (timer !== undefined) clearTimeout(timer) })

  const matches = createMemo<readonly ModalSelectOption[]>(() => token() === undefined ? [] : entries().map((entry) => ({
    id: entry.path,
    title: entry.path,
    value: `@${entry.path.slice(entry.path.lastIndexOf("/") + 1)}${entry.directory ? "/" : ""}`,
    description: entry.path,
  })))

  function selectedIndex(): number {
    const s = selection()
    return s.query === (token()?.query ?? "") && s.index < matches().length ? s.index : 0
  }

  return {
    visible: () => token() !== undefined && matches().length > 0 && dismissedQuery() !== token()?.query,
    matches,
    selectedIndex,
    moveSelection(delta) {
      const len = matches().length
      if (len === 0) return
      setSelection({ query: token()?.query ?? "", index: (selectedIndex() + delta + len) % len })
    },
    select(index) {
      if (index < 0 || index >= matches().length) return
      setSelection({ query: token()?.query ?? "", index })
    },
    completedText() {
      const current = token()
      const entry = entries()[selectedIndex()]
      if (!current || !entry) return undefined
      return insertMention(opts.inputText(), current, entry.path, entry.directory).text
    },
    dismiss() {
      setDismissedQuery(token()?.query)
    },
  }
}
