const CHAR_INTERVAL_MS = 8
const ENTER_SUPPRESS_WINDOW_MS = 120

type PasteBurstPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly char: string; readonly at: number }
  | { readonly kind: "buffering"; readonly text: string; readonly lastAt: number }

interface PasteBurstState {
  readonly phase: PasteBurstPhase
  readonly lastCharAt?: number
  readonly consecutiveChars: number
  readonly suppressUntil?: number
}

type PasteBurstEvent =
  | { readonly type: "ascii"; readonly char: string; readonly now: number }
  | { readonly type: "append"; readonly char: string; readonly now: number }
  | { readonly type: "begin"; readonly text: string; readonly now: number }
  | { readonly type: "control"; readonly char: "\n" | "\t"; readonly now: number }
  | { readonly type: "release" }
  | { readonly type: "clear" }

interface PasteBurstTransition {
  readonly state: PasteBurstState
  readonly retained: boolean
}

const initialState: PasteBurstState = { phase: { kind: "idle" }, consecutiveChars: 0 }

function noteCharacter(state: PasteBurstState, now: number): Pick<PasteBurstState, "lastCharAt" | "consecutiveChars"> {
  return {
    lastCharAt: now,
    consecutiveChars: state.lastCharAt !== undefined && now - state.lastCharAt <= CHAR_INTERVAL_MS
      ? state.consecutiveChars + 1
      : 1,
  }
}

/** Pure transition function for terminal key-stream classification. */
function reducePasteBurst(state: PasteBurstState, event: PasteBurstEvent): PasteBurstTransition {
  if (event.type === "clear") return { state: initialState, retained: false }
  if (event.type === "release") return { state: { ...state, phase: { kind: "idle" } }, retained: false }
  if (event.type === "begin") {
    return {
      state: {
        ...state,
        phase: { kind: "buffering", text: event.text, lastAt: event.now },
        lastCharAt: event.now,
        suppressUntil: event.now + ENTER_SUPPRESS_WINDOW_MS,
      },
      retained: true,
    }
  }
  if (event.type === "control") {
    if (state.phase.kind === "idle") return { state, retained: false }
    const text = state.phase.kind === "pending" ? state.phase.char + event.char : state.phase.text + event.char
    return {
      state: {
        ...state,
        phase: { kind: "buffering", text, lastAt: event.now },
        lastCharAt: event.now,
        suppressUntil: event.now + ENTER_SUPPRESS_WINDOW_MS,
      },
      retained: true,
    }
  }

  const timing = noteCharacter(state, event.now)
  if (state.phase.kind === "buffering") {
    return {
      state: {
        ...state,
        ...timing,
        phase: { kind: "buffering", text: state.phase.text + event.char, lastAt: event.now },
        suppressUntil: event.now + ENTER_SUPPRESS_WINDOW_MS,
      },
      retained: true,
    }
  }
  if (event.type === "append") return { state: { ...state, ...timing }, retained: false }
  if (state.phase.kind === "pending" && event.now - state.phase.at <= CHAR_INTERVAL_MS) {
    return {
      state: {
        ...state,
        ...timing,
        phase: { kind: "buffering", text: state.phase.char + event.char, lastAt: event.now },
        suppressUntil: event.now + ENTER_SUPPRESS_WINDOW_MS,
      },
      retained: true,
    }
  }
  return {
    state: { ...state, ...timing, phase: { kind: "pending", char: event.char, at: event.now } },
    retained: true,
  }
}

export interface PasteBurstControllerOptions {
  readonly insertTyped: (text: string) => void
  readonly applyPaste: (text: string) => void
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | undefined
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void
  readonly textBeforeCursor?: () => string
  readonly retractBeforeCursor?: (start: number, end: number) => void
  readonly onPendingStart?: () => void
}

export interface PasteBurstController {
  onCharacter(char: string, now?: number): boolean
  onControl(char: "\n" | "\t", now?: number): boolean
  newlineShouldInsert(now?: number): boolean
  flushDue(now?: number): void
  flushBeforeModifiedInput(): void
  settlePendingText(): string
  snapshot(): string
  decideRetroCapture(beforeCursor: string, characterCount: number): { readonly start: number; readonly text: string } | undefined
  clear(): void
  dispose(): void
}

/**
 * Owns one paste classifier and its idle timer. Callers route both emitted
 * paste payloads and explicit terminal paste payloads to the same applyPaste.
 */
export function createPasteBurstController(options: PasteBurstControllerOptions): PasteBurstController {
  let state = initialState
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = options.cancel ?? clearTimeout
  const activeIdleMs = (options.platform ?? process.platform) === "win32" ? 60 : 8

  function cancelTimer(): void {
    if (timer !== undefined) cancel(timer)
    timer = undefined
  }

  function scheduleFlush(fullDelay = false): void {
    if (timer !== undefined) return
    if (state.phase.kind === "idle") return
    const threshold = state.phase.kind === "buffering" ? activeIdleMs : CHAR_INTERVAL_MS
    const lastAt = state.phase.kind === "buffering" ? state.phase.lastAt : state.phase.at
    const delay = fullDelay ? threshold : Math.max(0, threshold - (now() - lastAt))
    timer = schedule(() => {
      timer = undefined
      flushDue(now())
      scheduleFlush()
    }, delay)
  }

  function transition(event: PasteBurstEvent): boolean {
    const wasIdle = state.phase.kind === "idle"
    const result = reducePasteBurst(state, event)
    state = result.state
    if (wasIdle && state.phase.kind !== "idle") options.onPendingStart?.()
    return result.retained
  }

  function emitPendingAsTyped(): void {
    if (state.phase.kind !== "pending") return
    const text = state.phase.char
    transition({ type: "release" })
    options.insertTyped(text)
  }

  function emitBufferedAsPaste(): void {
    if (state.phase.kind !== "buffering") return
    const text = state.phase.text
    transition({ type: "release" })
    options.applyPaste(text)
  }

  function flushDue(at = now()): void {
    if (disposed) return
    if (state.phase.kind === "pending" && at - state.phase.at >= CHAR_INTERVAL_MS) emitPendingAsTyped()
    else if (state.phase.kind === "buffering" && at - state.phase.lastAt >= activeIdleMs) emitBufferedAsPaste()
  }

  function beginWithRetroCapture(char: string, at: number): boolean {
    const timing = noteCharacter(state, at)
    if (state.phase.kind !== "idle" || timing.consecutiveChars < 3) return false
    if (!options.textBeforeCursor || !options.retractBeforeCursor) return false
    const before = options.textBeforeCursor()
    const grab = decideRetroCapture(before, timing.consecutiveChars - 1)
    if (!grab) return false
    options.retractBeforeCursor(grab.start, before.length)
    transition({ type: "begin", text: grab.text + char, now: at })
    scheduleFlush(true)
    return true
  }

  return {
    onCharacter(char, at = now()) {
      if (disposed || [...char].length !== 1) return false
      flushDue(at)
      const codePoint = char.codePointAt(0)
      if (codePoint === undefined || codePoint > 0x7f) {
        if (state.phase.kind === "pending") {
          cancelTimer()
          const pending = state.phase.char
          transition({ type: "clear" })
          options.applyPaste(pending)
        }
        if (beginWithRetroCapture(char, at)) return true
        const retained = transition({ type: "append", char, now: at })
        if (!retained) options.insertTyped(char)
        else scheduleFlush(true)
        return retained
      }
      if (beginWithRetroCapture(char, at)) return true
      const retained = transition({ type: "ascii", char, now: at })
      scheduleFlush(true)
      return retained
    },
    onControl(char, at = now()) {
      if (disposed) return false
      const retained = transition({ type: "control", char, now: at })
      if (retained) scheduleFlush(true)
      return retained
    },
    newlineShouldInsert(at = now()) {
      return state.phase.kind !== "idle" || (state.suppressUntil !== undefined && at <= state.suppressUntil)
    },
    flushDue,
    flushBeforeModifiedInput() {
      if (disposed) return
      cancelTimer()
      const text = state.phase.kind === "pending" ? state.phase.char : state.phase.kind === "buffering" ? state.phase.text : ""
      transition({ type: "clear" })
      if (text) options.applyPaste(text)
    },
    settlePendingText() {
      if (disposed) return ""
      cancelTimer()
      const text = state.phase.kind === "pending" ? state.phase.char : state.phase.kind === "buffering" ? state.phase.text : ""
      transition({ type: "clear" })
      return text
    },
    snapshot() {
      return state.phase.kind === "pending" ? state.phase.char : state.phase.kind === "buffering" ? state.phase.text : ""
    },
    decideRetroCapture(beforeCursor, characterCount) {
      return decideRetroCapture(beforeCursor, characterCount)
    },
    clear() {
      cancelTimer()
      transition({ type: "clear" })
    },
    dispose() {
      cancelTimer()
      disposed = true
      transition({ type: "clear" })
    },
  }
}

function decideRetroCapture(beforeCursor: string, characterCount: number): { readonly start: number; readonly text: string } | undefined {
  const characters = [...beforeCursor]
  const startCharacter = Math.max(0, characters.length - characterCount)
  const text = characters.slice(startCharacter).join("")
  if (![...text].some((char) => /\s/u.test(char)) && [...text].length < 16) return undefined
  return { start: characters.slice(0, startCharacter).join("").length, text }
}
