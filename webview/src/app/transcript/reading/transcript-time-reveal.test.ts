import assert from "node:assert/strict"
import { test } from "node:test"

import { bindTranscriptTimeReveal } from "./transcript-time-reveal.js"

class TranscriptElement extends EventTarget {
  readonly styles = new Map<string, string>()
  readonly style = {
    setProperty: (name: string, value: string) => { this.styles.set(name, value) },
    removeProperty: (name: string) => { const value = this.styles.get(name); this.styles.delete(name); return value ?? "" },
  }
  readonly classes = new Set<string>()
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => { if (force) this.classes.add(name); else this.classes.delete(name); return force === true },
    remove: (name: string) => this.classes.delete(name),
  }
  closest() { return null }
}

class TestTouchEvent extends Event {
  readonly touches: readonly { clientX: number; clientY: number }[]
  constructor(type: string, x: number, y: number) {
    super(type, { cancelable: true })
    this.touches = [{ clientX: x, clientY: y }]
  }
}
class TestPointerEvent extends Event {
  constructor(readonly pointerType: string) { super("click", { cancelable: true }) }
}
function touch(element: TranscriptElement, type: string, x: number, y: number) {
  const event = new TestTouchEvent(type, x, y)
  element.dispatchEvent(event)
  return event
}

test("a transcript drag reveals and latches times until a reverse drag or tap, without taking vertical scroll", () => {
  const element = new TranscriptElement()
  const originalElement = globalThis.HTMLElement
  const originalTouchEvent = globalThis.TouchEvent
  const originalPointerEvent = globalThis.PointerEvent
  Reflect.set(globalThis, "HTMLElement", TranscriptElement)
  Reflect.set(globalThis, "TouchEvent", TestTouchEvent)
  Reflect.set(globalThis, "PointerEvent", TestPointerEvent)
  const dispose = bindTranscriptTimeReveal(element)
  try {
    touch(element, "touchstart", 100, 100)
    assert.equal(touch(element, "touchmove", 60, 102).defaultPrevented, true)
    const displacement = Number(element.styles.get("--time-drag"))
    assert.ok(displacement > 0 && displacement < 1)
    touch(element, "touchend", 60, 102)
    assert.equal(element.classes.has("times-revealed"), true)
    assert.equal(element.styles.has("--time-drag"), false)
    touch(element, "touchstart", 60, 100)
    touch(element, "touchmove", 100, 102)
    touch(element, "touchend", 100, 102)
    assert.equal(element.classes.has("times-revealed"), false)
    touch(element, "touchstart", 100, 100)
    assert.equal(touch(element, "touchmove", 95, 160).defaultPrevented, false)
    assert.equal(element.classes.has("times-revealed"), false)
    touch(element, "touchstart", 100, 100)
    touch(element, "touchmove", 60, 100)
    touch(element, "touchend", 60, 100)
    // Browsers may synthesize a click after a drag; that click must not clear the latch.
    element.dispatchEvent(new TestPointerEvent("touch"))
    assert.equal(element.classes.has("times-revealed"), true)
    touch(element, "touchstart", 60, 100)
    touch(element, "touchend", 60, 100)
    element.dispatchEvent(new TestPointerEvent("touch"))
    assert.equal(element.classes.has("times-revealed"), false)
    touch(element, "touchstart", 100, 100)
    touch(element, "touchmove", 60, 100)
    touch(element, "touchend", 60, 100)
    const mouse = new TestPointerEvent("mouse")
    element.dispatchEvent(mouse)
    assert.equal(mouse.defaultPrevented, false)
    assert.equal(element.classes.has("times-revealed"), false)
  } finally {
    dispose()
    if (originalElement === undefined) Reflect.deleteProperty(globalThis, "HTMLElement")
    else Reflect.set(globalThis, "HTMLElement", originalElement)
    if (originalTouchEvent === undefined) Reflect.deleteProperty(globalThis, "TouchEvent")
    else Reflect.set(globalThis, "TouchEvent", originalTouchEvent)
    if (originalPointerEvent === undefined) Reflect.deleteProperty(globalThis, "PointerEvent")
    else Reflect.set(globalThis, "PointerEvent", originalPointerEvent)
  }
})
