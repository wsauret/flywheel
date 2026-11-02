import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { InputResponsivenessDiagnosticSchema, type InputResponsivenessDiagnostic } from "../../../src/protocol/runtime-client-diagnostics.js"
import { observeInputDiagnostics } from "./input-diagnostics.js"

class Node {
  isConnected = true
  hidden = false
  attributes = new Set<string>()
  constructor(readonly tag = "div", readonly classes: string[] = [], readonly parent?: Node) {}
  classList = { contains: (value: string) => this.classes.includes(value) }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const value = part.trim()
      return value.startsWith(".") ? this.classes.includes(value.slice(1))
        : value === this.tag || this.attributes.has(value)
    })
  }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null }
  contains(node: unknown): boolean { return node === this || node instanceof Node && node.parent !== undefined && this.contains(node.parent) }
  hasAttribute(name: string) { return this.attributes.has(name) }
  querySelector(selector: string): Node | null {
    return nodes.find(node => this.contains(node) && node.matches(selector)) ?? null
  }
}
class Pointer extends Event {
  pointerId = 1
  isPrimary = true
  pointerType = "touch"
  button = 0
  clientX = 0
  clientY = 0
}
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible"
  activeElement: Node | null = null
  constructor(readonly elementFromPoint: () => Node | null) { super() }
  getSelection() { return null }
}
let nodes: Node[] = []
const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element")
const originalPointer = Object.getOwnPropertyDescriptor(globalThis, "PointerEvent")
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  if (originalElement) Object.defineProperty(globalThis, "Element", originalElement)
  else Reflect.deleteProperty(globalThis, "Element")
  if (originalPointer) Object.defineProperty(globalThis, "PointerEvent", originalPointer)
  else Reflect.deleteProperty(globalThis, "PointerEvent")
  nodes = []
})

function fixture() {
  Object.defineProperty(globalThis, "Element", { value: Node, configurable: true })
  Object.defineProperty(globalThis, "PointerEvent", { value: Pointer, configurable: true })
  const document = new FakeDocument(() => hit)
  const root = Object.assign(new Node(), { ownerDocument: document })
  const client = new Node("div", ["client", "stack"], root)
  const pane = new Node("div", ["pane"], client)
  pane.attributes.add("inert")
  const sessions = new Node("div", ["rail-list"], client)
  const button = new Node("button", ["session-row"], sessions)
  const editable = new Node("textarea", [], pane)
  let hit: Node | null = button
  nodes.push(client, pane, sessions, button, editable)
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const frames = new Map<number, () => void>()
  const reports: InputResponsivenessDiagnostic[] = []
  let sessionId = "session-a"
  const dispose = observeInputDiagnostics(root, {
    sessionId: () => sessionId, connection: () => "connected", report: report => reports.push(report),
    clock: {
      now: () => now,
      frame: callback => { frames.set(++id, callback); return id },
      cancelFrame: key => { frames.delete(key) },
      timer: (callback, ms) => { timers.set(++id, { callback, at: now + ms }); return id },
      cancelTimer: key => { timers.delete(key) },
    },
  })
  disposers.push(dispose)
  const send = async (type: string, target: Node = button, delay = 0, x = 0, prevent = false, touches = 1, pointer?: { pointerId: number; isPrimary: boolean }) => {
    const event = type.startsWith("pointer") ? new Pointer(type, { cancelable: true }) : new Event(type, { cancelable: true })
    if (event instanceof Pointer) { event.clientX = x; Object.assign(event, pointer) }
    if (type.startsWith("touch")) Object.defineProperty(event, "touches", { value: { length: touches } })
    Object.defineProperty(event, "timeStamp", { value: now - delay })
    Object.defineProperty(event, "target", { value: target })
    document.dispatchEvent(event)
    if (prevent) event.preventDefault()
    advance(0)
    await Promise.resolve()
  }
  const advance = (ms: number) => {
    now += ms
    const due = Array.from(timers).filter(([, value]) => value.at <= now)
    for (const [key, value] of due) {
      timers.delete(key)
      value.callback()
    }
  }
  const draw = (ms = 16) => {
    now += ms
    const callbacks = [...frames.values()]
    frames.clear()
    for (const drawFrame of callbacks) drawFrame()
  }
  return { root, document, button, editable, reports, send, advance, draw, dispose, timers, frames, hit: (node: Node | null) => { hit = node }, select: (nextSessionId: string) => { sessionId = nextSessionId } }
}

test("healthy taps, scrolling, cancelled gestures and deliberate focus write nothing", async () => {
  const f = fixture()
  await f.send("pointerdown")
  await f.send("touchstart")
  await f.send("pointerup")
  await f.send("touchend")
  for (const stage of ["mouseover", "mousemove", "mousedown", "mouseup"]) await f.send(stage)
  await f.send("click")
  f.draw()
  await f.send("pointerdown")
  await f.send("pointermove", f.button, 0, 20)
  await f.send("pointerup")
  f.draw()
  await f.send("pointerdown")
  await f.send("scroll")
  await f.send("pointerup")
  f.draw()
  await f.send("pointerdown")
  await f.send("pointercancel")
  await f.send("pointerup")
  f.draw()
  await f.send("pointerdown", f.editable)
  await f.send("pointerup", f.editable)
  f.document.activeElement = f.editable
  f.draw()
  f.advance(1000)
  expect(f.reports).toEqual([])
  const timers = f.timers.size
  await f.send("mousemove")
  expect(f.timers.size).toBe(timers)
})

test("late dispatch and next-frame wait report bounded metadata without key or DOM content", async () => {
  const f = fixture()
  f.advance(200)
  await f.send("keydown", f.editable, 100, 0, true)
  expect(f.reports).toHaveLength(1)
  expect(f.reports[0]).toMatchObject({ phase: "first", dispatchDelayed: 1, frameDelayed: 0, sessionId: "session-a", screen: "sessions" })
  expect(f.reports[0]?.recent[0]).toEqual({ event: "keydown", input: "keyboard", control: "editable", area: "other", atMs: 200, dispatchDelayMs: 100, defaultPrevented: true })
  f.draw(100)
  f.advance(60_000)
  expect(f.reports[1]).toMatchObject({ phase: "summary", dispatchDelayed: 0, frameDelayed: 1, unmatchedTap: 0 })
  expect(f.reports[1]?.recent[0]?.frameWaitMs).toBe(100)
  for (const report of f.reports) expect(() => Schema.decodeUnknownSync(InputResponsivenessDiagnosticSchema)(report)).not.toThrow()
})

test("a stationary actionable release without click is unmatched_tap, not a diagnosed cause", async () => {
  const f = fixture()
  await f.send("pointerdown")
  await f.send("pointerup")
  f.draw()
  f.advance(983)
  expect(f.reports).toEqual([])
  f.advance(1)
  expect(f.reports[0]).toMatchObject({ anomaly: "unmatched_tap", unmatchedTap: 1, dispatchDelayed: 0, frameDelayed: 0, recent: [{ control: "session" }, { control: "session" }] })

  const retry = fixture()
  await retry.send("pointerdown")
  await retry.send("pointerup")
  retry.draw(0)
  retry.advance(200)
  await retry.send("pointerdown")
  await retry.send("pointerup")
  await retry.send("click")
  retry.draw(0)
  retry.advance(800)
  expect(retry.reports[0]).toMatchObject({ anomaly: "unmatched_tap", unmatchedTap: 1 })

  for (let i = 0; i < 3; i++) {
    await retry.send("pointerdown")
    await retry.send("pointerup")
    retry.draw(0)
    retry.advance(200)
  }
  retry.advance(1000)
  retry.advance(60_000)
  expect(retry.reports.at(-1)).toMatchObject({ phase: "summary", unmatchedTap: 3 })
})

test("changed release targets and prevented release are not unmatched taps", async () => {
  const f = fixture()
  await f.send("pointerdown")
  await f.send("pointerup", f.editable)
  f.draw()
  f.advance(1000)
  await f.send("pointerdown")
  await f.send("pointerup", f.button, 0, 0, true)
  f.draw()
  f.advance(1000)
  expect(f.reports).toEqual([])
})

test("gesture evidence records touch prevention, movement, multitouch and compatibility progression without changing qualification", async () => {
  const f = fixture()
  await f.send("pointerdown")
  await f.send("touchstart", f.button, 0, 0, true, 2)
  await f.send("pointermove", f.button, 0, 6)
  await f.send("touchmove", f.button, 0, 0, true)
  f.advance(40)
  await f.send("pointerup", f.button, 0, 3)
  await f.send("touchend", f.button, 0, 0, true, 0)
  for (const stage of ["mouseover", "mousemove", "mousedown", "mouseup"]) await f.send(stage)
  f.draw(0)
  f.advance(1000)
  expect(f.reports[0]?.recent.at(-1)?.tap).toMatchObject({
    gestureId: 1, controlId: 1, maxTouches: 2, durationMs: 40, maxDisplacementPx: 6,
    touchStartPrevented: true, touchMovePrevented: true, touchEndPrevented: true,
    mouseStages: ["mouseover", "mousemove", "mousedown", "mouseup"], controlConnected: true, releaseOnOriginalControl: true,
  })
  expect(() => Schema.decodeUnknownSync(InputResponsivenessDiagnosticSchema)(f.reports[0])).not.toThrow()
  const moved = fixture()
  await moved.send("pointerdown")
  await moved.send("pointermove", moved.button, 0, 20)
  await moved.send("pointermove", moved.button, 0, 30)
  moved.advance(140)
  await moved.send("pointerup", moved.button, 100)
  expect(moved.reports[0]?.recent.at(-1)?.tap?.maxDisplacementPx).toBe(30)
  moved.draw(0)
  moved.advance(1000)
  expect(moved.reports[0]?.unmatchedTap).toBe(0)

  const multi = fixture()
  await multi.send("pointerdown")
  await multi.send("pointerdown", multi.button, 0, 0, false, 1, { pointerId: 2, isPrimary: false })
  await multi.send("touchstart", multi.button, 0, 0, false, 2)
  await multi.send("pointermove", multi.button, 0, 6)
  multi.advance(140)
  await multi.send("pointerup", multi.button, 100, 6)
  expect(multi.reports[0]?.recent.at(-1)?.tap).toMatchObject({ maxTouches: 2, maxDisplacementPx: 6, durationMs: 40, releaseOnOriginalControl: true })
  multi.draw(0)
  multi.advance(1000)
  expect(multi.reports[0]?.unmatchedTap).toBe(0)
})

test("retargeted outside clicks and replaced controls stay visible while reports are immutable", async () => {
  const f = fixture()
  await f.send("pointerdown")
  f.button.isConnected = false
  const replacement = new Node("button")
  f.hit(replacement)
  await f.send("pointerup")
  await f.send("click", replacement)
  f.draw(0)
  f.advance(1000)
  expect(f.reports[0]?.recent.at(-1)?.tap).toMatchObject({
    controlConnected: false, releaseOnOriginalControl: false, clickOnOtherControl: true, mouseStages: ["click"],
  })
  const snapshot = JSON.stringify(f.reports[0])
  await f.send("mouseover")
  expect(JSON.stringify(f.reports[0])).toBe(snapshot)

  const outside = fixture()
  await outside.send("pointerdown")
  await outside.send("touchstart")
  await outside.send("pointerup")
  await outside.send("touchend", outside.button, 0, 0, false, 0)
  const otherRoot = new Node("button")
  await outside.send("pointerdown", otherRoot)
  await outside.send("touchstart", otherRoot, 0, 0, true, 2)
  await outside.send("pointerup", otherRoot)
  await outside.send("click", otherRoot)
  outside.draw(0)
  outside.advance(1000)
  expect(outside.reports[0]?.recent.at(-1)?.tap).toMatchObject({ maxTouches: 1, touchStartPrevented: false, mouseStages: [] })
  expect(outside.reports[0]?.recent.at(-1)?.tap?.clickOnOtherControl).toBeUndefined()

  const retarget = fixture()
  await retarget.send("pointerdown")
  await retarget.send("pointerup")
  const next = new Node("button", [], retarget.root)
  await retarget.send("pointerdown", next)
  retarget.hit(next)
  await retarget.send("pointerup", next)
  await retarget.send("mouseover", next)
  await retarget.send("mousemove", next)
  await retarget.send("click", retarget.button)
  retarget.draw(0)
  retarget.advance(1000)
  const traces = retarget.reports[0]?.recent
  expect(traces?.[0]?.tap?.mouseStages).toEqual([])
  expect(traces?.at(-1)?.tap).toMatchObject({ gestureId: 2, mouseStages: ["mouseover", "mousemove", "click"], clickOnOtherControl: true })
})

test("successful neighboring gestures and touch cancellation remain in bounded recent evidence", async () => {
  const f = fixture()
  await f.send("pointerdown")
  await f.send("pointerup")
  await f.send("click")
  await f.send("pointerdown")
  await f.send("pointercancel")
  await f.send("touchcancel")
  await f.send("pointerdown")
  await f.send("pointerup")
  f.draw(0)
  f.advance(1000)
  expect(f.reports[0]?.recent[0]?.tap?.mouseStages).toEqual(["click"])
  expect(f.reports[0]?.recent[3]?.tap?.touchCancelled).toBe(true)
})

test("repeats emit one summary per minute with exact counts and a 16-event sample", async () => {
  const f = fixture()
  f.advance(100)
  for (let i = 0; i < 30; i++) { await f.send("click", f.button, 100); f.draw(0) }
  expect(f.reports).toHaveLength(1)
  f.advance(60_000)
  expect(f.reports).toHaveLength(2)
  expect(f.reports[1]).toMatchObject({ phase: "summary", dispatchDelayed: 29, frameDelayed: 0, unmatchedTap: 0 })
  expect(f.reports[1]?.recent).toHaveLength(16)
  await f.send("click", f.button, 100)
  f.draw(0)
  expect(f.reports).toHaveLength(2)
  f.advance(60_000)
  expect(f.reports[2]?.dispatchDelayed).toBe(1)

  const changing = fixture()
  changing.advance(100)
  await changing.send("click", changing.button, 100)
  changing.draw(0)
  await changing.send("click", changing.button, 100)
  changing.draw(0)
  changing.select("session-b")
  changing.advance(60_000)
  expect(changing.reports[1]).toMatchObject({ phase: "summary", sessionId: "session-a", dispatchDelayed: 1 })
  await changing.send("click", changing.button, 100)
  changing.draw(0)
  expect(changing.reports.at(-1)).toMatchObject({ phase: "first", sessionId: "session-b", dispatchDelayed: 1 })
})

test("hidden, cached disconnected and disposed roots cannot emit or retain callbacks", async () => {
  const f = fixture()
  await f.send("pointerdown")
  await f.send("pointerup")
  f.document.visibilityState = "hidden"
  f.document.dispatchEvent(new Event("visibilitychange"))
  f.advance(1000)
  f.draw(200)
  f.document.visibilityState = "visible"
  f.root.isConnected = false
  await f.send("click", f.button, 200)
  f.draw(200)
  f.advance(60_000)
  expect(f.reports).toEqual([])
  f.root.isConnected = true
  await f.send("pointerdown")
  await f.send("pointerup")
  f.dispose()
  f.advance(60_000)
  f.draw(200)
  await f.send("click", f.button, 200)
  expect(f.reports).toEqual([])
  expect(f.timers.size + f.frames.size).toBe(0)
})

test("the wire boundary rejects unbounded samples, content-shaped ids and nonfinite timings", () => {
  const decode = Schema.decodeUnknownSync(InputResponsivenessDiagnosticSchema)
  const report = { kind: "input_responsiveness", clientInstanceId: "client-a", connection: "connected", screen: "chat", paneInert: false, dragging: false, phase: "first", anomaly: "dispatch_delay", dispatchDelayed: 1, frameDelayed: 0, unmatchedTap: 0, recent: [] }
  expect(() => decode(report)).not.toThrow()
  expect(() => decode({ ...report, sessionId: "user answer with spaces" })).toThrow()
  const sample = { event: "click", input: "touch", control: "button", area: "toolbar", atMs: 0, dispatchDelayMs: 100, defaultPrevented: false }
  expect(() => decode({ ...report, recent: Array.from({ length: 17 }, () => sample) })).toThrow()
  expect(() => decode({ ...report, recent: [{ ...sample, frameWaitMs: Infinity }] })).toThrow()
  const tap = { gestureId: 1, controlId: 1, maxDisplacementPx: 0, mouseStages: ["click"] }
  expect(() => decode({ ...report, recent: [{ ...sample, tap }] })).not.toThrow()
  for (const invalid of [
    { ...tap, gestureId: "button-label" },
    { ...tap, maxTouches: 1.5 },
    { ...tap, maxDisplacementPx: Infinity },
    { ...tap, durationMs: -1 },
    { ...tap, mouseStages: ["wheel"] },
    { ...tap, mouseStages: Array.from({ length: 6 }, () => "click") },
  ]) expect(() => decode({ ...report, recent: [{ ...sample, tap: invalid }] })).toThrow()
})
