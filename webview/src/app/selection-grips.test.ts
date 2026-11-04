import assert from "node:assert/strict"
import { test } from "node:test"

import { bindSelectionGrips } from "./selection-grips.js"

class GripElement extends EventTarget {
  readonly style = { left: "", top: "", pointerEvents: "", clipPath: "" }
  readonly dataset = { endpoint: "" }
  readonly attributes = new Map<string, string>()
  readonly children: GripElement[] = []
  readonly captures = new Set<number>()
  readonly classes = new Set<string>()
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force: boolean) => { if (force) this.classes.add(name); else this.classes.delete(name) },
    remove: (name: string) => { this.classes.delete(name) },
  }
  className = ""
  hidden = false
  tabIndex = 0
  parent: GripElement | undefined

  constructor(readonly ownerDocument: GripDocument) { super() }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  append(...elements: GripElement[]) {
    for (const element of elements) { this.children.push(element); element.parent = this }
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }
  contains(node: unknown): boolean {
    return node === this || (node instanceof GripText && node.parentElement === this) || this.children.some(child => child.contains(node))
  }
  setPointerCapture(id: number) { this.captures.add(id) }
  hasPointerCapture(id: number) { return this.captures.has(id) }
  releasePointerCapture(id: number) { this.captures.delete(id) }
  getBoundingClientRect() {
    if (this === this.ownerDocument.scroller) return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 }
    const x = Number(this.style.left.replace("px", ""))
    const y = Number(this.style.top.replace("px", ""))
    return { x: x - 32, y: y - 32, left: x - 32, top: y - 32, right: x + 32, bottom: y + 32, width: 64, height: 64 }
  }
  closest(): GripElement | null { return null }
}

class GripText {
  readonly nodeType = 3
  constructor(readonly parentElement: GripElement) {}
}

class GripRange {
  startContainer: GripText
  endContainer: GripText
  startOffset = 0
  endOffset = 5
  private collapsedAt: "start" | "end" | undefined

  constructor(readonly document: GripDocument) {
    this.startContainer = document.text
    this.endContainer = document.text
  }
  cloneRange() {
    const clone = new GripRange(this.document)
    clone.collapsedAt = this.collapsedAt
    return clone
  }
  collapse(start: boolean) { this.collapsedAt = start ? "start" : "end" }
  getBoundingClientRect() { return this.document.rects[this.collapsedAt ?? "start"] }
  getClientRects() { return this.document.selectedRects }
}

class GripSelection {
  rangeCount = 1
  isCollapsed = false
  anchorNode: GripText
  anchorOffset = 0
  focusNode: GripText
  focusOffset = 5
  readonly changes: { anchor: GripText; anchorOffset: number; focus: GripText; focusOffset: number }[] = []
  clears = 0

  constructor(readonly document: GripDocument) {
    this.anchorNode = document.text
    this.focusNode = document.text
  }
  getRangeAt() { return this.document.range }
  setBaseAndExtent(anchor: GripText, anchorOffset: number, focus: GripText, focusOffset: number) {
    this.anchorNode = anchor
    this.anchorOffset = anchorOffset
    this.focusNode = focus
    this.focusOffset = focusOffset
    this.changes.push({ anchor, anchorOffset, focus, focusOffset })
  }
  removeAllRanges() { this.rangeCount = 0; this.isCollapsed = true; this.clears += 1 }
}

class GripDocument extends EventTarget {
  readonly body = new GripElement(this)
  readonly scroller = new GripElement(this)
  readonly textParent = new GripElement(this)
  readonly text = new GripText(this.textParent)
  readonly range = new GripRange(this)
  readonly selection = new GripSelection(this)
  readonly viewport = new EventTarget()
  readonly window = Object.assign(new EventTarget(), {
    matchMedia: () => ({ matches: this.coarse }),
    visualViewport: this.viewport,
    Node: GripElement,
  })
  readonly defaultView = this.window
  coarse = true
  rects = {
    start: { x: 100, y: 100, height: 20, bottom: 120 },
    end: { x: 125, y: 100, height: 20, bottom: 120 },
  }
  selectedRects = [{ left: 100, right: 125, top: 100, bottom: 120 }]
  caret: { startContainer: GripText; startOffset: number } | null = { startContainer: this.text, startOffset: 16 }
  readonly queries: { x: number; y: number; transparent: boolean }[] = []
  occludedBelow = Infinity

  constructor() {
    super()
    this.scroller.append(this.textParent)
    this.body.append(this.scroller)
  }
  getSelection() { return this.selection }
  createElement() { return new GripElement(this) }
  elementFromPoint(_x: number, y: number) { return y >= this.occludedBelow ? this.body : this.textParent }
  caretRangeFromPoint(x: number, y: number) {
    this.queries.push({ x, y, transparent: this.grips().every(grip => grip.style.pointerEvents === "none") })
    return this.caret
  }
  grips() { return this.body.children.find(child => child.className === "selection-grips")?.children ?? [] }
  changed() { this.dispatchEvent(new Event("selectionchange")) }
  bind() { return bindSelectionGrips(this.scroller) }
}

function pointer(target: EventTarget, type: string, x: number, y: number, id = 1, pointerType = "touch") {
  const event = new Event(type, { cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: x }, clientY: { value: y }, pointerId: { value: id },
    pointerType: { value: pointerType }, isPrimary: { value: true }, button: { value: 0 },
  })
  target.dispatchEvent(event)
  return event
}

function touchMove(target: EventTarget, fingers: number) {
  const event = new Event("touchmove", { cancelable: true })
  Object.defineProperty(event, "touches", { value: Array.from({ length: fingers }, () => ({})) })
  target.dispatchEvent(event)
  return event
}

test("selection grips follow short and wrapped native endpoints without changing the selected content", () => {
  const document = new GripDocument()
  const dispose = document.bind()
  try {
    const [start, end] = document.grips()
    assert.ok(start && end)
    assert.equal(start.style.left, "100px")
    assert.equal(start.style.top, "90px")
    assert.equal(end.style.left, "125px")
    assert.equal(end.style.top, "130px")
    assert.equal(document.scroller.classList.contains("selecting-text"), true)
    assert.equal(document.body.children.at(-1)?.attributes.get("aria-hidden"), "true")
    assert.equal(document.selection.changes.length, 0)
    document.rects.end = { x: 45, y: 160, height: 20, bottom: 180 }
    document.changed()
    assert.equal(end.style.left, "45px")
    assert.equal(end.style.top, "190px")
    document.rects.start = { x: 100, y: 70, height: 20, bottom: 90 }
    document.scroller.dispatchEvent(new Event("scroll"))
    assert.equal(start.style.top, "60px")
    document.rects.end = { x: 50, y: 170, height: 20, bottom: 190 }
    document.window.dispatchEvent(new Event("resize"))
    assert.equal(end.style.top, "200px")
    document.rects.end = { x: 60, y: 160, height: 20, bottom: 180 }
    document.viewport.dispatchEvent(new Event("scroll"))
    assert.equal(end.style.left, "60px")
  } finally { dispose() }
})

test("selection grips yield their touch targets to surfaces above the transcript", () => {
  const document = new GripDocument()
  const dispose = document.bind()
  try {
    const [start, end] = document.grips()
    assert.ok(start && end)
    document.occludedBelow = 150
    document.changed()
    assert.equal(start.hidden, false)
    assert.equal(end.hidden, true)
    document.occludedBelow = Infinity
    document.changed()
    assert.equal(end.hidden, false)
  } finally { dispose() }
})

for (const end of ["start", "end"] as const) {
  test(`selection grips preserve off-center ${end} grabs and remain transparent through release`, () => {
    const document = new GripDocument()
    // Separate the targets to test a grab away from either visible cue.
    document.rects.end = { x: 200, y: 100, height: 20, bottom: 120 }
    const dispose = document.bind()
    try {
      const grips = document.grips()
      const pad = grips[end === "start" ? 0 : 1]
      assert.ok(pad)
      const x = end === "start" ? 120 : 220
      const y = end === "start" ? 80 : 140
      assert.equal(pointer(pad, "pointerdown", x, y).defaultPrevented, true)
      assert.equal(pad.hasPointerCapture(1), true)
      assert.ok(grips.every(grip => grip.style.pointerEvents === "none"))
      assert.equal(document.selection.anchorOffset, end === "start" ? 5 : 0)
      document.caret = { startContainer: document.text, startOffset: end === "start" ? 1 : 16 }
      pointer(pad, "pointermove", x + 40, y + 30)
      assert.deepEqual(document.queries[0], { x: x - 20 + 40, y: 140, transparent: true })
      assert.equal(document.selection.focusOffset, end === "start" ? 1 : 16)
      // Safari can reverse anchor/focus while preserving the ordered native range.
      document.range[end === "start" ? "endOffset" : "startOffset"] = 3
      document.selection.anchorOffset = end === "start" ? 1 : 3
      document.caret = { startContainer: document.text, startOffset: end === "start" ? 0 : 21 }
      document.changed()
      assert.ok(grips.every(grip => grip.style.pointerEvents === "none"))
      pointer(pad, "pointermove", x + 50, y + 30)
      assert.equal(document.selection.changes.at(-1)?.anchorOffset, 3)
      assert.ok(document.queries.every(query => query.transparent))
      pointer(pad, "pointerup", x + 50, y + 30)
      assert.equal(document.selection.focusOffset, end === "start" ? 0 : 21)
      assert.equal(pad.hasPointerCapture(1), false)
      assert.ok(grips.every(grip => grip.style.pointerEvents === ""))
      const copy = new Event("copy", { cancelable: true })
      document.dispatchEvent(copy)
      assert.equal(copy.defaultPrevented, false)
      assert.equal(document.selection.focusOffset, end === "start" ? 0 : 21)
    } finally { dispose() }
  })
}

test("selection grips choose the nearer endpoint when short-selection targets overlap", () => {
  for (const [x, y, anchor] of [[105, 102, 5], [120, 116, 0]] as const) {
    const document = new GripDocument()
    const dispose = document.bind()
    try {
      const pad = document.grips()[1]
      assert.ok(pad)
      pointer(pad, "pointerdown", x, y)
      assert.equal(document.selection.anchorOffset, anchor)
    } finally { dispose() }
  }
})

test("selection grips ignore unrelated pointers and caret hits outside transcript text or in controls", () => {
  const document = new GripDocument()
  const dispose = document.bind()
  try {
    const pad = document.grips()[1]
    assert.ok(pad)
    pointer(pad, "pointerdown", 125, 130, 1, "mouse")
    assert.equal(pad.hasPointerCapture(1), false)
    pointer(pad, "pointerdown", 125, 130)
    pointer(pad, "pointermove", 160, 130, 2)
    assert.equal(document.queries.length, 0)
    const changes = document.selection.changes.length
    document.caret = null
    pointer(pad, "pointermove", 160, 130)
    document.caret = { startContainer: new GripText(new GripElement(document)), startOffset: 1 }
    pointer(pad, "pointermove", 170, 130)
    document.textParent.closest = () => document.textParent
    document.caret = { startContainer: document.text, startOffset: 1 }
    pointer(pad, "pointermove", 180, 130)
    assert.equal(document.selection.changes.length, changes)
  } finally { dispose() }
})

test("selection grips expose the selected touch policy and release it when the browser clears selection", () => {
  const document = new GripDocument()
  document.selection.rangeCount = 0
  document.selection.isCollapsed = true
  const dispose = document.bind()
  try {
    assert.equal(document.scroller.classList.contains("selecting-text"), false)
    assert.equal(touchMove(document.scroller, 1).defaultPrevented, false)
    assert.ok(document.grips().every(grip => grip.hidden))
    document.selection.rangeCount = 1
    document.selection.isCollapsed = false
    document.changed()
    assert.equal(document.scroller.classList.contains("selecting-text"), true)
    assert.equal(touchMove(document.scroller, 1).defaultPrevented, true)
    assert.equal(touchMove(document.scroller, 2).defaultPrevented, false)
    document.selection.removeAllRanges()
    document.changed()
    assert.equal(document.scroller.classList.contains("selecting-text"), false)
    assert.ok(document.grips().every(grip => grip.hidden))
    assert.equal(touchMove(document.scroller, 1).defaultPrevented, false)
  } finally { dispose() }
})

for (const ending of ["pointercancel", "lostpointercapture", "clear", "outside", "dispose"] as const) {
  test(`selection grips release capture and owned policy on ${ending}`, () => {
    const document = new GripDocument()
    const dispose = document.bind()
    const pad = document.grips()[1]
    assert.ok(pad)
    pointer(pad, "pointerdown", 125, 130)
    if (ending === "clear") {
      document.selection.removeAllRanges()
      document.changed()
    } else if (ending === "outside") {
      document.range.endContainer = new GripText(new GripElement(document))
      document.changed()
    } else if (ending === "dispose") dispose()
    else pointer(pad, ending, 125, 130)
    assert.equal(pad.hasPointerCapture(1), false)
    assert.equal(pad.style.pointerEvents, "")
    const changes = document.selection.changes.length
    pointer(pad, "pointermove", 200, 130)
    assert.equal(document.selection.changes.length, changes)
    if (ending === "clear" || ending === "outside" || ending === "dispose") {
      assert.equal(document.scroller.classList.contains("selecting-text"), false)
    }
    if (ending !== "dispose") dispose()
    assert.equal(document.grips().length, 0)
    assert.equal(touchMove(document.scroller, 1).defaultPrevented, false)
    if (ending === "dispose") assert.equal(document.selection.isCollapsed, false)
    document.changed()
    assert.equal(document.scroller.classList.contains("selecting-text"), false)
  })
}

test("selection grips leave desktop selection and touch policy unchanged", () => {
  const document = new GripDocument()
  document.coarse = false
  const dispose = document.bind()
  try {
    assert.equal(document.grips().length, 0)
    assert.equal(document.scroller.classList.contains("selecting-text"), false)
  } finally { dispose() }
})
