import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createRoot, createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import { TabsBar } from "../../../../../src/tui/components/chrome/tabs-bar.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
import { createTerminalPresence, INPUT_PRESENCE_MS } from "../../../../../src/tui/hooks/foreground/create-terminal-presence.js"
import { fakeLanes } from "../../../../helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch } from "../../../../helpers/runtime-dispatch.js"
import type { FrontendMutation } from "../../../../../src/protocol/runtime/app-service-types.js"


/** Builds the presence under its own root, so its effects run as they do in
 *  the shell, and the test drives it from outside the root. */
function fixture(options: { focusTracking?: boolean; multiplexed?: boolean } = {}) {
  return createRoot((dispose) => ({ ...build(options), dispose }))
}

/** Listeners by event name, as the renderer and its key input hold them. */
function emitter<Payload = void>() {
  const listeners = new Map<string, Set<(payload: Payload) => void>>()
  return {
    on(event: string, listener: (payload: Payload) => void) { listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)) },
    off(event: string, listener: (payload: Payload) => void) { listeners.get(event)?.delete(listener) },
    emit(event: string, payload: Payload) { for (const listener of listeners.get(event) ?? []) listener(payload) },
  }
}

function build(options: { focusTracking?: boolean; multiplexed?: boolean }) {
  const renderer = emitter()
  const keyInput = emitter()
  const stdin = emitter<Buffer | string>()
  const reports: FrontendMutation[] = []
  const lanes = fakeLanes()
  let time = 0
  let timer: { run: () => void; at: number } | undefined
  const [front, setFront] = createSignal<string | undefined>("chat-a")
  createTerminalPresence({
    renderer: { on: renderer.on, off: renderer.off, capabilities: options.focusTracking === undefined ? null : { focus_tracking: options.focusTracking }, keyInput, stdin },
    client: { dispatch: recordedDispatch((command) => reports.push(command), runtimeDispatch({ "chat.presence": async () => ({ ok: true }) })), onLane: lanes.onLane },
    frontChat: front,
    multiplexed: options.multiplexed ?? false,
    now: () => time,
    schedule: (run, ms) => {
      const scheduled = { run, at: time + ms }
      timer = scheduled
      return () => { if (timer === scheduled) timer = undefined }
    },
  })
  return {
    reports, lanes, setFront,
    focus: () => renderer.emit("focus", undefined),
    blur: () => renderer.emit("blur", undefined),
    key: () => keyInput.emit("keypress", undefined),
    /** Sends raw input, as the terminal writes it. */
    input: (sequence: string) => stdin.emit("data", Buffer.from(sequence)),
    /** Moves the clock and runs the timer that is due. */
    advance(ms: number) {
      time += ms
      const due = timer
      if (due && due.at <= time) { timer = undefined; due.run() }
    },
  }
}

const at = (sessionId: string): FrontendMutation => ({ type: "chat.presence", sessionId })
const away: FrontendMutation = { type: "chat.presence" }

describe("createTerminalPresence", () => {
  it("reports on focus, on blur, and on a change of the chat in front, and nothing per key press", () => {
    const terminal = fixture({ focusTracking: true })
    expect(terminal.reports).toEqual([])
    terminal.focus()
    expect(terminal.reports).toEqual([at("chat-a")])
    for (let press = 0; press < 20; press += 1) terminal.key()
    expect(terminal.reports).toHaveLength(1)
    terminal.setFront("chat-b")
    terminal.blur()
    // A chat that comes in front while the terminal has no focus is not read.
    terminal.setFront("chat-c")
    terminal.focus()
    terminal.setFront(undefined)
    expect(terminal.reports).toEqual([at("chat-a"), at("chat-b"), away, at("chat-c"), away])
    terminal.dispose()
  })

  it("in a terminal that reports focus, counts input before the first focus report as focus", () => {
    const terminal = fixture({ focusTracking: true })
    terminal.key()
    terminal.advance(INPUT_PRESENCE_MS * 2)
    expect(terminal.reports).toEqual([at("chat-a")])
    terminal.blur()
    terminal.key()
    expect(terminal.reports).toEqual([at("chat-a"), away])
    terminal.dispose()
  })

  it("inside a multiplexer, applies the input rule despite the focus capability until a real focus report", () => {
    // A multiplexer can claim focus tracking and still forward no focus report.
    const terminal = fixture({ focusTracking: true, multiplexed: true })
    terminal.key()
    expect(terminal.reports).toEqual([at("chat-a")])
    terminal.advance(INPUT_PRESENCE_MS)
    expect(terminal.reports).toEqual([at("chat-a"), away])
    terminal.focus()
    terminal.blur()
    expect(terminal.reports).toEqual([at("chat-a"), away, at("chat-a"), away])
    terminal.dispose()
  })

  it("in a terminal of unknown focus, counts the person present from input until the window after the last input passes", () => {
    const terminal = fixture()
    terminal.advance(1_000)
    expect(terminal.reports).toEqual([])
    terminal.key()
    expect(terminal.reports).toEqual([at("chat-a")])
    // Input inside the window keeps the person present and sends nothing.
    terminal.advance(INPUT_PRESENCE_MS - 10)
    terminal.input("\x1b[<0;4;2M")
    for (let press = 0; press < 20; press += 1) terminal.key()
    terminal.advance(10)
    expect(terminal.reports).toEqual([at("chat-a")])
    terminal.advance(INPUT_PRESENCE_MS)
    expect(terminal.reports).toEqual([at("chat-a"), away])
    // A real focus report replaces the input rule.
    terminal.focus()
    terminal.advance(INPUT_PRESENCE_MS * 2)
    expect(terminal.reports).toEqual([at("chat-a"), away, at("chat-a")])
    terminal.dispose()
  })

  it("counts a click and a scroll as input, and not a move, a drag, or a release", () => {
    const terminal = fixture()
    // A move, a left drag, a release, and a terminal reply.
    terminal.input("\x1b[<35;4;2M\x1b[<32;5;2M\x1b[<0;5;2m\x1b[?1;2c")
    expect(terminal.reports).toEqual([])
    terminal.input("\x1b[<64;4;2M")
    expect(terminal.reports).toEqual([at("chat-a")])
    terminal.advance(INPUT_PRESENCE_MS)
    terminal.input("\x1b[<0;4;2M")
    expect(terminal.reports).toEqual([at("chat-a"), away, at("chat-a")])
    terminal.dispose()
  })

  it("counts a press on a tab that the tab bar keeps from its ancestors", async () => {
    const activated: string[] = []
    const [front, setFront] = createSignal("chat-a")
    const tabs = [{ id: "chat-a", title: "Alpha", isForeground: true, isBusy: false }, { id: "chat-b", title: "Beta", isForeground: false, isBusy: false }]
    const result = await testRender(
      () => createComponent(TickPoolProvider, {
        get children() {
          return createComponent(TabsBar, {
            tabs: () => tabs, availableWidth: () => 80, theme: resolveTheme(flywheelTheme, "dark"),
            onActivate: (id) => { activated.push(id); setFront(id) }, onNewTab: () => {}, onReorder: () => {},
          })
        },
      }),
      { width: 80, height: 3 },
    )
    const reports: FrontendMutation[] = []
    const lanes = fakeLanes()
    const dispose = createRoot((disposeRoot) => {
      createTerminalPresence({
        renderer: result.renderer,
        client: { dispatch: recordedDispatch((command) => reports.push(command), runtimeDispatch({ "chat.presence": async () => ({ ok: true }) })), onLane: lanes.onLane },
        frontChat: front,
        multiplexed: false,
      })
      return disposeRoot
    })
    try {
      expect(result.renderer.capabilities?.focus_tracking).not.toBe(true)
      await result.renderOnce()
      const row = result.captureCharFrame().split("\n")[1] ?? ""
      await result.mockMouse.pressDown(row.indexOf("Beta"), 1)
      expect(activated).toEqual(["chat-b"])
      expect(reports).toEqual([at("chat-b")])
    } finally {
      dispose()
      result.renderer.destroy()
    }
  })

  it("names the chat again on a new lane, and says nothing on a lane while the person is away", () => {
    const terminal = fixture({ focusTracking: true })
    terminal.lanes.open()
    expect(terminal.reports).toEqual([])
    terminal.focus()
    terminal.lanes.open()
    expect(terminal.reports).toEqual([at("chat-a"), at("chat-a")])
    terminal.dispose()
    terminal.lanes.open()
    expect(terminal.reports).toHaveLength(2)
  })
})
