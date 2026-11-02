import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot } from "solid-js"
import { scrollEdges, updateScrollEdges } from "./scroll-edges.js"

function memoryViewport(value: unknown): HTMLElement {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: scrollEdges passes the element and its children to ResizeObserver.observe, which requires a full Element, and bun test has no DOM to build one.
  return value as HTMLElement
}

test("scroll edges mark only content beyond the viewport", () => {
  for (const [scrollTop, scrollHeight, clientHeight, above, below] of [
    [0, 400, 100, false, true],
    [150, 400, 100, true, true],
    [300, 400, 100, true, false],
    [0, 100, 100, false, false],
    [299.6, 400, 100, true, false],
  ] as const) {
    const classes = new Set<string>()
    updateScrollEdges({
      scrollTop, scrollHeight, clientHeight,
      classList: { toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name) } },
    })
    assert.equal(classes.has("scroll-above"), above)
    assert.equal(classes.has("scroll-below"), below)
  }
})

test("owned scroll edges coalesce, observe content, share resources, and remount after teardown", async () => {
  const frames = new Map<number, FrameRequestCallback>()
  const listeners = new Set<EventListener>()
  const observers: ControlledObserver[] = []
  const removed: unknown[] = []
  const cancelled: number[] = []
  let nextFrame = 0
  class ControlledObserver {
    readonly targets = new Set<Element>()
    disconnected = false
    constructor(readonly deliver: (entries: readonly { target: Element }[]) => void) { observers.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.disconnected = true; this.targets.clear() }
    resize(target: Element) { this.deliver([{ target }]) }
  }
  const document = {
    addEventListener(type: string, listener: EventListener, options: unknown) {
      assert.equal(type, "scroll")
      assert.deepEqual(options, { capture: true, passive: true })
      listeners.add(listener)
    },
    removeEventListener(type: string, listener: EventListener, capture: unknown) {
      removed.push([type, capture])
      assert.ok(listeners.delete(listener))
    },
    defaultView: {
      ResizeObserver: ControlledObserver,
      requestAnimationFrame(callback: FrameRequestCallback) { const id = ++nextFrame; frames.set(id, callback); return id },
      cancelAnimationFrame(id: number) { cancelled.push(id); frames.delete(id) },
    },
  }
  const viewport = () => {
    const classes = new Set<string>()
    let updates = 0
    const element = memoryViewport({
      ownerDocument: document, children: [{}], scrollTop: 0, scrollHeight: 400, clientHeight: 100,
      classList: { toggle(name: string, enabled: boolean) { updates++; if (enabled) classes.add(name); else classes.delete(name) } },
    })
    return { element, classes, updates: () => updates }
  }
  const mount = async (element: HTMLElement) => {
    const dispose = createRoot(disposeRoot => { scrollEdges(element); return disposeRoot })
    await Promise.resolve()
    return dispose
  }
  const flush = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const deliver of callbacks) deliver(0)
  }
  const scroll = (target: HTMLElement) => {
    const event = new Event("scroll")
    Object.defineProperty(event, "target", { value: target })
    for (const listener of listeners) listener(event)
  }
  const first = viewport()
  const second = viewport()
  const disposeFirst = await mount(first.element)
  const disposeSecond = await mount(second.element)
  let disposeRemount: (() => void) | undefined
  try {
    assert.equal(observers.length, 1)
    assert.equal(listeners.size, 1)
    assert.equal(observers[0]!.targets.size, 4)
    flush()
    assert.equal(first.updates(), 2)
    first.element.scrollTop = 150
    scroll(first.element); scroll(first.element); scroll(first.element)
    assert.equal(frames.size, 1)
    assert.equal(first.updates(), 2)
    flush()
    assert.equal(first.updates(), 4)
    assert.deepEqual([...first.classes], ["scroll-below", "scroll-above"])
    first.element.scrollTop = 0
    Object.defineProperty(first.element, "scrollHeight", { value: 100, writable: true })
    observers[0]!.resize(first.element.children[0]!)
    flush()
    assert.equal(first.updates(), 6)
    assert.equal(first.classes.size, 0)
    disposeFirst()
    assert.equal(listeners.size, 1)
    assert.equal(observers[0]!.targets.size, 2)
    assert.equal(observers[0]!.disconnected, false)
    second.element.scrollTop = 20
    scroll(second.element)
    flush()
    assert.ok(second.classes.has("scroll-above"))
    scroll(second.element)
    const pendingFrame = [...frames.keys()][0]!
    disposeSecond()
    assert.deepEqual(removed, [["scroll", true]])
    assert.equal(observers[0]!.disconnected, true)
    assert.equal(observers[0]!.targets.size, 0)
    assert.deepEqual(cancelled, [pendingFrame])
    assert.equal(frames.size, 0)
    assert.equal(listeners.size, 0)
    disposeRemount = await mount(first.element)
    assert.equal(observers.length, 2)
    assert.equal(listeners.size, 1)
    Object.defineProperty(first.element, "scrollHeight", { value: 400 })
    flush()
    assert.ok(first.classes.has("scroll-below"))
  } finally {
    disposeFirst(); disposeSecond(); disposeRemount?.()
  }
  assert.equal(listeners.size, 0)
  assert.equal(observers[1]!.disconnected, true)
})
