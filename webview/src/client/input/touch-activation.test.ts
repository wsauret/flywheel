import { afterEach, expect, test } from "bun:test"
import { installTouchActivation } from "./touch-activation.js"

class Control extends EventTarget {
  isConnected = true
  hidden = false
  attributes = new Set<string>()
  control: Control | null = null
  clicks = 0
  constructor(readonly tagName: string, readonly ownerDocument: DocumentFixture, readonly parentElement?: Control) { super() }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const value = part.trim()
      if (value.startsWith("input:not(")) return this.tagName === "input" && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].some(type => this.attributes.has(`[type="${type}"]`))
      const input = /^input(\[type="[^"]+"\])$/.exec(value)
      if (input) return this.tagName === "input" && this.attributes.has(input[1]!)
      if (value === "a[href]") return this.tagName === "a" && this.attributes.has("[href]")
      if (value === "[hidden]") return this.hidden || this.attributes.has(value)
      return value === this.tagName || this.attributes.has(value)
    })
  }
  closest(selector: string): Control | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  contains(node: Element | Control): boolean { return node === this || node.parentElement != null && this.contains(node.parentElement) }
  click() { this.clicks += 1; this.dispatchEvent(new Event("click")) }
}
class Label extends Control {}

class DocumentFixture extends EventTarget {
  private readonly capture = new EventTarget()
  visibilityState: DocumentVisibilityState = "visible"
  hit: Control | null = null
  selected = false
  elementFromPoint() { return this.hit }
  getSelection() { return { isCollapsed: !this.selected } }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    const capture = typeof options === "boolean" ? options : options?.capture
    if (capture) this.capture.addEventListener(type, listener, options)
    else super.addEventListener(type, listener, options)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    const capture = typeof options === "boolean" ? options : options?.capture
    if (capture) this.capture.removeEventListener(type, listener, options)
    else super.removeEventListener(type, listener, options)
  }
  /** EventTarget has no ancestors. Route the document phases around the descendant's real listeners. */
  dispatchFrom(target: Control, event: Event) {
    let stopped = false
    const stopPropagation = event.stopPropagation.bind(event)
    event.stopPropagation = () => { stopped = true; stopPropagation() }
    this.capture.dispatchEvent(event)
    if (!stopped) target.dispatchEvent(event)
    if (!stopped) super.dispatchEvent(event)
  }
}

/** Mounts touch activation on a fixture root. Bun has no DOM, so the fixture classes stand in for the
 *  root surface the controller reads and are installed as the DOM globals it checks with instanceof. */
function mount(root: Control): () => void {
  return installTouchActivation(root)
}

const originals = ["Element", "HTMLElement", "HTMLLabelElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original)
    else Reflect.deleteProperty(globalThis, key)
  }
})

function fixture(tag = "button", attributes: string[] = []) {
  for (const key of ["Element", "HTMLElement"]) Object.defineProperty(globalThis, key, { value: Control, configurable: true })
  Object.defineProperty(globalThis, "HTMLLabelElement", { value: Label, configurable: true })
  const document = new DocumentFixture()
  const root = new Control("div", document)
  const control = tag === "label" ? new Label(tag, document, root) : new Control(tag, document, root)
  if (tag === "label") {
    control.control = new Control("input", document, control)
    control.control.attributes.add('[type="checkbox"]')
  }
  const child = new Control("span", document, control)
  control.attributes = new Set(attributes)
  document.hit = child
  const dispose = mount(root)
  disposers.push(dispose)
  const send = (type: string, options: { x?: number; y?: number; fingers?: number; target?: Control; prevented?: boolean; id?: number } = {}) => {
    const event = new Event(type, { cancelable: true })
    const touch = { identifier: options.id ?? 1, clientX: options.x ?? 20, clientY: options.y ?? 20 }
    Object.defineProperties(event, {
      target: { value: options.target ?? child },
      touches: { value: Array.from({ length: options.fingers ?? (type === "touchend" ? 0 : 1) }, () => touch) },
      changedTouches: { value: [touch] },
    })
    if (options.prevented) event.preventDefault()
    document.dispatchFrom(options.target ?? child, event)
    return event
  }
  return { document, root, control, child, send, dispose }
}

test("a stationary control tap calls its normal click action once and cancels compatibility activation", () => {
  for (const selected of [false, true]) {
    const f = fixture()
    f.document.selected = selected
    let action = 0
    f.control.addEventListener("click", () => { action += 1 })
    f.send("touchstart")
    const end = f.send("touchend")
    expect(end.defaultPrevented).toBe(true)
    expect(action).toBe(1)
    f.send("touchend")
    expect(action).toBe(1)
  }
})

test("semantic controls, options, disclosures, links, labels and review headers share activation", () => {
  for (const [tag, attributes] of [
    ["button", []], ["a", ["[href]"]], ["summary", []], ["label", []],
    ["input", ['[type="checkbox"]']], ["input", ['[type="radio"]']],
    ["input", ['[type="file"]']], ["div", ['[role="button"]']],
    ["div", ['[role="option"]']], ["div", ['[role="menuitem"]']],
    ["header", [".changes-file-header"]], ["div", [".scrim"]],
  ] as const) {
    const f = fixture(tag, [...attributes])
    if (attributes.some(value => value === ".scrim")) f.document.hit = f.control
    f.send("touchstart", { target: f.control })
    expect(f.send("touchend").defaultPrevented).toBe(true)
    expect(f.control.clicks).toBe(1)
  }
})

test("editing and native range/select controls keep their touch events", () => {
  for (const [tag, attributes] of [
    ["textarea", []], ["input", []], ["input", ['[type="range"]']],
    ["select", []], ["div", ["[contenteditable]"]], ["div", ['[role="slider"]']],
    ["div", [".selection-grip"]], ["div", ['[tabindex="0"]']],
  ] as const) {
    const f = fixture(tag, [...attributes])
    if (!attributes.some(value => value === '[tabindex="0"]')) f.root.attributes.add('[role="button"]')
    f.send("touchstart")
    expect(f.send("touchend").defaultPrevented).toBe(false)
    expect(f.control.clicks).toBe(0)
  }
})

test("movement, multiple fingers, cancellation, scrolling, selection and consumed touches stay native", () => {
  for (const interrupt of [
    (f: ReturnType<typeof fixture>) => f.send("touchmove", { x: 30 }),
    (f: ReturnType<typeof fixture>) => f.send("touchmove", { y: 30 }),
    (f: ReturnType<typeof fixture>) => f.send("touchmove", { x: 28, y: 28 }),
    (f: ReturnType<typeof fixture>) => f.send("touchstart", { fingers: 2 }),
    (f: ReturnType<typeof fixture>) => f.send("touchcancel"),
    (f: ReturnType<typeof fixture>) => f.send("pointercancel"),
    (f: ReturnType<typeof fixture>) => f.send("contextmenu"),
    (f: ReturnType<typeof fixture>) => f.send("scroll", { target: f.root }),
    (f: ReturnType<typeof fixture>) => { f.document.selected = true; f.send("selectionchange") },
    (f: ReturnType<typeof fixture>) => f.send("touchmove", { prevented: true }),
  ]) {
    const f = fixture()
    f.send("touchstart")
    interrupt(f)
    expect(f.send("touchend").defaultPrevented).toBe(false)
    expect(f.control.clicks).toBe(0)
  }
  const f = fixture()
  f.send("touchstart")
  f.send("touchend", { prevented: true })
  expect(f.control.clicks).toBe(0)
})

test("release must retain the same enabled control in an active mounted root", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.document.hit = new Control("button", f.document, f.root) },
    (f: ReturnType<typeof fixture>) => { f.document.hit = null },
    (f: ReturnType<typeof fixture>) => { f.root.isConnected = false },
    (f: ReturnType<typeof fixture>) => { f.root.hidden = true },
    (f: ReturnType<typeof fixture>) => { f.root.attributes.add("[inert]") },
    (f: ReturnType<typeof fixture>) => { f.control.attributes.add(":disabled") },
    (f: ReturnType<typeof fixture>) => { f.control.attributes.add('[aria-disabled="true"]') },
    (f: ReturnType<typeof fixture>) => { f.document.visibilityState = "hidden" },
    (f: ReturnType<typeof fixture>) => f.dispose(),
  ]) {
    const f = fixture()
    f.send("touchstart")
    change(f)
    expect(f.send("touchend").defaultPrevented).toBe(false)
    expect(f.control.clicks).toBe(0)
  }
  const f = fixture()
  const otherRoot = new Control("div", f.document)
  const other = new Control("button", f.document, otherRoot)
  f.document.hit = other
  f.send("touchstart", { target: other })
  f.send("touchend", { target: other })
  expect(other.clicks).toBe(0)
})

test("descendant-consumed swipe movement cannot become a tap after returning to its start", () => {
  const f = fixture("div", ['[role="button"]'])
  let consumedMoves = 0
  f.child.addEventListener("touchmove", event => {
    consumedMoves += 1
    event.stopPropagation()
  })
  f.send("touchstart")
  f.send("touchmove", { x: 60 })
  f.send("touchmove", { x: 21 })
  expect(consumedMoves).toBe(2)
  expect(f.send("touchend", { x: 21 }).defaultPrevented).toBe(false)
  expect(f.control.clicks).toBe(0)
})

test("mounted clients only activate their own root, including after another root detaches", () => {
  const f = fixture()
  const otherRoot = new Control("div", f.document)
  const other = new Control("button", f.document, otherRoot)
  disposers.push(mount(otherRoot))
  f.send("touchstart")
  f.send("touchend")
  expect(f.control.clicks).toBe(1)
  expect(other.clicks).toBe(0)
  f.root.isConnected = false
  f.document.hit = other
  f.send("touchstart", { target: other })
  f.send("touchend", { target: other })
  expect(f.control.clicks).toBe(1)
  expect(other.clicks).toBe(1)
})
