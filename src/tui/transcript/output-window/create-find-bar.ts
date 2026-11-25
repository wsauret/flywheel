import { type Accessor, batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { compileFind, TRANSCRIPT_FIND_LIMIT, type FindMatcher } from "../../../protocol/transcript/transcript-find.js"
import type { TranscriptFindMatch, TranscriptFindRequest, TranscriptFindResult } from "../../../protocol/transcript/transcript-protocol-types.js"
import type { FindTarget } from "../../context/find/find-highlight.js"
import type { OutputTranscriptView } from "../transcript-store/output-transcript-cache-types.js"
import { createControlledTextEditor, SINGLE_LINE_TEXT_ENTRY_POLICY, type TextEditorPresentation, type TextEntryKeyEvent } from "../../terminal/keymap/text-entry.js"

/** Typing settles for this long before the runtime scans the transcript. */
const TYPING_SETTLE_MS = 150
/** While output streams, the part of the transcript that can still change is
 *  scanned again at most this often. */
const OUTPUT_SETTLE_MS = 500

interface TranscriptFindClient {
  query(query: { readonly type: "transcriptFind"; readonly sessionId: string; readonly request: TranscriptFindRequest }): Promise<TranscriptFindResult>
}

interface FindBarDeps {
  readonly client: TranscriptFindClient
  /** The session in front of the person; the bar finds in its transcript. */
  readonly sessionId: Accessor<string | undefined>
  readonly includeThinking: Accessor<boolean>
  /** The transcript of the session in front. Its freshness revision moves
   *  with every write, a streamed delta included. */
  readonly transcript: Accessor<Pick<OutputTranscriptView, "freshness">>
  readonly report: (message: string) => void
}

interface FindScan {
  readonly sessionId: string
  readonly matches: readonly TranscriptFindMatch[]
  readonly more: boolean
  readonly blockCount: number
  readonly openFromBlockIndex: number
}

/** A landing the transcript runs once: `id` grows with each move. */
export interface FindLanding extends FindTarget {
  readonly id: number
}

/** The terminal find bar: the pattern and its toggles, the matches the
 *  runtime finds in the whole transcript of the session in front, and the
 *  current match. Moving to a match publishes a landing that the transcript
 *  scrolls to. While the bar is open, new output scans again only from the
 *  first block that could still change, and keeps the earlier matches. */
export function createFindBar(deps: FindBarDeps) {
  const [isOpen, setOpen] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [pattern, setPattern] = createSignal("")
  const [regex, setRegex] = createSignal(false)
  const [matchCase, setMatchCase] = createSignal(false)
  const [scan, setScan] = createSignal<FindScan | undefined>()
  const [cursor, setCursor] = createSignal<number | undefined>()
  const [landing, setLanding] = createSignal<FindLanding | undefined>()
  const editor = createControlledTextEditor({ value: pattern, setValue: setPattern, policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  const compiled = createMemo(() => compileFind({ pattern: pattern(), regex: regex(), matchCase: matchCase() }))
  const matcher = createMemo((): FindMatcher | undefined => {
    const find = compiled()
    return isOpen() && find.kind === "ready" ? find.matcher : undefined
  })
  let landings = 0
  // Bumps on each new pattern, toggle, session, or thinking setting; a scan
  // of an earlier epoch never applies.
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // A follow-up scan of new output waits for output to settle.
  let following = false
  // The runtime cannot cancel a find and caps live finds per process, so the
  // bar keeps one request in flight and remembers only the latest scan wanted
  // meanwhile. A full scan replaces a wanted follow-up scan.
  let scanning = false
  let wanted: "full" | "follow" | undefined
  onCleanup(() => clearTimeout(timer))

  function request(kind: "full" | "follow"): void {
    if (!scanning) return start(kind)
    if (kind === "full" || wanted === undefined) wanted = kind
  }

  function start(kind: "full" | "follow"): void {
    scanning = true
    void run(kind === "follow").finally(() => {
      scanning = false
      const next = wanted
      wanted = undefined
      if (next !== undefined) start(next)
    })
  }

  /** Scans from the last result's open block when `follow` holds, or the
   *  whole transcript. The result of an earlier epoch never applies. */
  async function run(follow: boolean): Promise<void> {
    const sessionId = deps.sessionId()
    const mine = epoch
    const prior = scan()
    const base = follow && prior?.sessionId === sessionId ? prior : undefined
    if (sessionId === undefined || matcher() === undefined) return
    const fromBlockIndex = base?.openFromBlockIndex ?? 0
    try {
      const result = await deps.client.query({ type: "transcriptFind", sessionId, request: { pattern: pattern(), regex: regex(), matchCase: matchCase(), includeThinking: deps.includeThinking(), fromBlockIndex } })
      if (mine !== epoch) return
      // A transcript that lost blocks was rewound: its earlier matches moved.
      if (base && result.blockCount < base.blockCount) return await run(false)
      const merged = [...base ? base.matches.filter((match) => match.blockIndex < fromBlockIndex) : [], ...result.matches]
      const matches = merged.slice(0, TRANSCRIPT_FIND_LIMIT)
      // The current match keeps its place by identity; a match that is gone
      // ends the landing.
      const at = untrack(cursor)
      const current = at === undefined ? undefined : prior?.matches[at]
      const next = current === undefined ? -1 : matches.findIndex((match) => match.blockId === current.blockId && match.occurrence === current.occurrence)
      batch(() => {
        setScan({ sessionId, matches, more: result.more || merged.length > TRANSCRIPT_FIND_LIMIT, blockCount: result.blockCount, openFromBlockIndex: result.openFromBlockIndex })
        setCursor(next < 0 ? undefined : next)
        if (current !== undefined && next < 0) setLanding(undefined)
      })
    } catch (error) {
      if (mine === epoch) deps.report(`Find failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function followOutput(): void {
    if (following) return
    following = true
    timer = setTimeout(() => {
      following = false
      request("follow")
    }, OUTPUT_SETTLE_MS)
  }

  // A new pattern, toggle, session, or thinking setting scans the whole transcript.
  createEffect(on([matcher, deps.sessionId, deps.includeThinking], ([find]) => {
    epoch += 1
    clearTimeout(timer)
    following = false
    wanted = undefined
    batch(() => { setScan(undefined); setCursor(undefined); setLanding(undefined) })
    if (find !== undefined) timer = setTimeout(() => request("full"), TYPING_SETTLE_MS)
  }))
  // New output scans again from the first block that can still change.
  createEffect(on(() => deps.transcript().freshness()?.revision, () => {
    if (untrack(scan) !== undefined && untrack(matcher) !== undefined) followOutput()
  }, { defer: true }))

  function move(step: 1 | -1): void {
    const matches = scan()?.matches ?? []
    if (matches.length === 0) return
    const at = cursor()
    const next = at === undefined ? (step === 1 ? 0 : matches.length - 1) : (at + step + matches.length) % matches.length
    const match = matches[next]
    if (!match) return
    batch(() => {
      setCursor(next)
      setLanding({ id: ++landings, blockId: match.blockId, occurrence: match.occurrence })
    })
  }

  function open(initial?: string): void {
    batch(() => {
      if (initial !== undefined && initial.trim() !== "") setPattern(initial.trim())
      setOpen(true)
      setFocused(true)
    })
    editor.setSelection(0, pattern().length)
  }

  function close(): void {
    batch(() => {
      setOpen(false)
      setFocused(false)
      setLanding(undefined)
    })
  }

  /** The bar's keys while it holds focus; true when the bar took the key.
   *  Alt+R and Alt+C toggle the regular expression and match case. */
  function input(event: TextEntryKeyEvent): boolean {
    if (!isOpen() || !focused()) return false
    const name = event.name
    const handled = (): true => { event.preventDefault?.(); return true }
    if (name === "escape") { close(); return handled() }
    if (name === "return" || name === "enter" || name === "kpenter" || name === "linefeed") { move(event.shift ? -1 : 1); return handled() }
    if (name === "down") { move(1); return handled() }
    if (name === "up") { move(-1); return handled() }
    if (event.meta && name === "r") { setRegex((enabled) => !enabled); return handled() }
    if (event.meta && name === "c") { setMatchCase((enabled) => !enabled); return handled() }
    // Keys the field does not take, such as the find chord or paging, reach the shell's keymap.
    return editor.handleKey(event) !== "unhandled"
  }

  const status = (): string => {
    const find = compiled()
    if (find.kind === "empty") return ""
    if (find.kind === "bad-pattern") return "bad pattern"
    const found = scan()
    if (found === undefined) return "…"
    const total = found.more ? `${TRANSCRIPT_FIND_LIMIT}+` : String(found.matches.length)
    const at = cursor()
    return `${at === undefined ? 0 : at + 1}/${total}`
  }

  return {
    isOpen,
    focused,
    regex,
    matchCase,
    matcher,
    landing,
    status,
    matchCount: (): number => scan()?.matches.length ?? 0,
    presentation: (): TextEditorPresentation => editor.presentation(),
    open,
    close,
    input,
    next: () => move(1),
    previous: () => move(-1),
    focus: () => setFocused(true),
    blur: () => setFocused(false),
    toggleRegex: () => setRegex((enabled) => !enabled),
    toggleMatchCase: () => setMatchCase((enabled) => !enabled),
    /** A paste while the bar holds focus goes into the pattern. */
    paste: (text: string): boolean => focused() && editor.handlePaste(text) !== "unhandled",
  }
}

export type FindBar = ReturnType<typeof createFindBar>
