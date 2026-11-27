import type { Accessor } from "solid-js"
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import { Log } from "../../../infra/diagnostics/log.js"
import type { AttachedRuntimeClient } from "../../../protocol/runtime/app-service-types.js"

const log = Log.create({ service: "terminal-presence" })

/** How long a terminal that does not report focus counts the person as at
 *  it after their last key press, paste, click, or scroll. */
export const INPUT_PRESENCE_MS = 60_000

/** The part of the renderer that presence reads: its focus events, the
 *  capability that says whether the terminal reports focus, its key input,
 *  and the input stream that its mouse reports arrive on. */
interface PresenceRenderer {
  on(event: "focus" | "blur", listener: () => void): void
  off(event: "focus" | "blur", listener: () => void): void
  readonly capabilities: { readonly focus_tracking: boolean } | null
  readonly keyInput: {
    on(event: "keypress" | "paste", listener: () => void): void
    off(event: "keypress" | "paste", listener: () => void): void
  }
  readonly stdin: {
    on(event: "data", listener: (chunk: Buffer | string) => void): void
    off(event: "data", listener: (chunk: Buffer | string) => void): void
  }
}

// An SGR mouse report: ESC [ < code ; x ; y, then M for a press, a drag, a
// move, or a scroll, and m for a release. Code bit 32 marks a drag or a move.
// oxlint-disable-next-line no-control-regex -- boundary: a mouse report starts with the ESC control character
const SGR_MOUSE_REPORT = /\x1b\[<(\d+);\d+;\d+M/g

/** Whether an input chunk holds a click or a scroll. The renderer hands a
 *  mouse event to the element under the pointer, and an element can stop it
 *  before any shared ancestor sees it, so presence reads the reports from the
 *  input stream itself. A move or a drag is not a sign that the person is
 *  at the terminal: the pointer can cross a window that the person does not
 *  use. */
function holdsClickOrScroll(chunk: Buffer | string): boolean {
  const text = typeof chunk === "string" ? chunk : chunk.toString("latin1")
  for (const match of text.matchAll(SGR_MOUSE_REPORT)) {
    if ((Number(match[1]) & 32) === 0) return true
  }
  return false
}

interface TerminalPresenceDeps {
  readonly renderer: PresenceRenderer
  readonly client: Pick<AttachedRuntimeClient, "dispatch" | "onLane">
  /** The chat in front of this terminal, if any. */
  readonly frontChat: Accessor<string | undefined>
  /** Whether this terminal runs inside a terminal multiplexer. */
  readonly multiplexed: boolean
  readonly now?: () => number
  /** Runs `run` after `ms`, and answers its cancel. */
  readonly schedule?: (run: () => void, ms: number) => () => void
}

/** Reports to the runtime which chat the person is at on this terminal, or
 *  none (PI-INTERACTION-187, ARCH-SESSIONS-052). A terminal that reports
 *  focus counts the person while it has focus. Any other terminal counts
 *  them for `INPUT_PRESENCE_MS` after each key press, paste, click, or
 *  scroll. Before the first focus report the focus state is unknown, so the
 *  input rule applies until then; in a terminal that reports focus, input
 *  also says that it has focus. Inside a terminal multiplexer, input never
 *  says that the terminal has focus: the renderer can claim focus tracking
 *  there while the multiplexer forwards no focus report, so only a real
 *  focus or blur report replaces the input rule.
 *
 *  A report goes out only when the chat that it names changes: a new chat in
 *  front, or the person arriving or leaving. A key press sends nothing when
 *  presence does not change. Presence lasts as long as its connection, so
 *  each new lane hears the current chat again. The report changes nothing
 *  on screen (ARCH-PROTOCOL-062). */
export function createTerminalPresence(deps: TerminalPresenceDeps): void {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? ((run, ms) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  })
  const [focused, setFocused] = createSignal<boolean | undefined>()
  const [recentInput, setRecentInput] = createSignal(false)
  let lastInputAt = 0
  let cancelExpiry: (() => void) | undefined

  // One timer covers a run of input: when it fires early, it waits out the
  // rest of the window from the last input instead of being reset per key.
  const expire = (): void => {
    const left = lastInputAt + INPUT_PRESENCE_MS - now()
    if (left > 0) {
      cancelExpiry = schedule(expire, left)
      return
    }
    cancelExpiry = undefined
    setRecentInput(false)
  }
  const input = (): void => {
    if (untrack(focused) !== undefined) return
    if (!deps.multiplexed && deps.renderer.capabilities?.focus_tracking === true) {
      setFocused(true)
      return
    }
    lastInputAt = now()
    if (cancelExpiry === undefined) cancelExpiry = schedule(expire, INPUT_PRESENCE_MS)
    setRecentInput(true)
  }
  const onFocus = (): void => { setFocused(true) }
  const onBlur = (): void => { setFocused(false) }
  deps.renderer.on("focus", onFocus)
  deps.renderer.on("blur", onBlur)
  deps.renderer.keyInput.on("keypress", input)
  deps.renderer.keyInput.on("paste", input)
  const onData = (chunk: Buffer | string): void => { if (holdsClickOrScroll(chunk)) input() }
  deps.renderer.stdin.on("data", onData)

  const present = () => focused() ?? recentInput()
  const reported = createMemo(() => present() ? deps.frontChat() : undefined)
  const report = (sessionId: string | undefined): void => {
    void deps.client.dispatch(sessionId === undefined ? { type: "chat.presence" } : { type: "chat.presence", sessionId })
      .then((result) => { if (!result.ok) log.debug("presence report refused", { error: result.error }) })
      // A report that its lane lost is sent again on the next lane.
      .catch((error: unknown) => { log.debug("presence report not delivered", { error: errorMessage(error) }) })
  }
  createEffect(on(reported, report, { defer: true }))
  // A new lane holds no presence of this terminal, so only a chat needs saying.
  const stopLanes = deps.client.onLane(() => {
    const sessionId = untrack(reported)
    if (sessionId !== undefined) report(sessionId)
  })

  onCleanup(() => {
    stopLanes()
    cancelExpiry?.()
    deps.renderer.off("focus", onFocus)
    deps.renderer.off("blur", onBlur)
    deps.renderer.keyInput.off("keypress", input)
    deps.renderer.keyInput.off("paste", input)
    deps.renderer.stdin.off("data", onData)
  })
}
