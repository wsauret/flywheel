import type { InputDiagnosticSample, InputResponsivenessDiagnostic } from "../../../src/protocol/runtime-client-diagnostics.js"

type TapTrace = { -readonly [K in keyof NonNullable<InputDiagnosticSample["tap"]>]: NonNullable<InputDiagnosticSample["tap"]>[K] }
type MutableSample = { -readonly [K in keyof Omit<InputDiagnosticSample, "tap">]: InputDiagnosticSample[K] } & { tap?: TapTrace }
const controlSelector = 'button, a, input, textarea, [contenteditable="true"], [role="button"], [role="option"], .selection-grip'
interface Observation {
  sample: MutableSample
  sessionId: string | undefined
  event: Event
}
interface PendingTap {
  control: Element
  observation: Observation
  timer: number
}
type InputContext = Pick<InputResponsivenessDiagnostic, "sessionId" | "connection" | "screen" | "paneInert" | "dragging">

interface InputClock {
  now(): number
  frame(callback: () => void): number
  cancelFrame(id: number): void
  timer(callback: () => void, ms: number): number
  cancelTimer(id: number): void
}

/** The members of a layout element that the observer reads after a lookup on the mount. */
interface QueriedElement {
  hasAttribute(name: string): boolean
  readonly classList: Pick<DOMTokenList, "contains">
}

/** activeElement is compared by identity only, and the observer tests only whether a hit has a control ancestor. */
interface ObservedDocument extends Pick<EventTarget, "addEventListener" | "removeEventListener">, Pick<Document, "visibilityState"> {
  readonly activeElement: unknown
  getSelection(): Pick<Selection, "anchorNode"> | null
  elementFromPoint(x: number, y: number): { closest(selectors: string): object | null } | null
}

/** The members of the mount that the observer reads. */
interface ObservedRoot extends Pick<HTMLElement, "isConnected" | "hidden"> {
  readonly ownerDocument: ObservedDocument
  querySelector(selectors: string): QueriedElement | null
  contains(other: Node | null): boolean
}

interface InputDiagnosticsOptions {
  readonly sessionId: () => string | undefined
  readonly connection: () => InputResponsivenessDiagnostic["connection"]
  readonly report: (diagnostic: InputResponsivenessDiagnostic) => void
  readonly clock?: InputClock
}

function describeTarget(target: Element) {
  const control = target.closest(controlSelector)
  const hit = control ?? target
  const editable = hit.matches('input, textarea, [contenteditable="true"]')
  const kind: InputDiagnosticSample["control"] = hit.closest(".toolbar-back") ? "back"
    : hit.closest(".rail-list") ? "session"
    : editable ? "editable"
    : hit.closest(".question-panel") ? "question"
    : hit.closest(".disclosure") ? "disclosure"
    : hit.closest(".selection-grip") ? "selection"
    : hit.matches("button, [role='button']") ? "button"
    : hit.matches("a") ? "link" : "other"
  const area: InputDiagnosticSample["area"] = target.closest(".question-panel") ? "question"
    : target.closest(".rail, .screen-sessions, .rail-list") ? "sessions"
    : target.closest(".composer") ? "composer"
    : target.closest(".toolbar") ? "toolbar"
    : target.closest('[role="dialog"]') ? "dialog"
    : target.closest(".transcript, .selection-grip") ? "transcript" : "other"
  return { control, editable, kind, area }
}

/** Observes a connected, visible mount without changing event behavior.
 * Dispose before unmount. Body-mounted selection grips are observed only while
 * this mount owns the native selection. No content or key values are read. */
export function observeInputDiagnostics(root: ObservedRoot, options: InputDiagnosticsOptions): () => void {
  const document = root.ownerDocument
  const clock: InputClock = options.clock ?? {
    now: () => performance.now(),
    frame: callback => requestAnimationFrame(callback),
    cancelFrame: id => cancelAnimationFrame(id),
    timer: (callback, ms) => window.setTimeout(callback, ms),
    cancelTimer: id => window.clearTimeout(id),
  }
  const clientInstanceId = crypto.randomUUID()
  let disposed = false
  const active = () => !disposed && root.isConnected && !root.hidden && document.visibilityState === "visible"
  const recent: Observation[] = []
  let counts = { dispatchDelayed: 0, frameDelayed: 0, unmatchedTap: 0 }
  let context: InputContext | undefined
  let lastAnomaly: InputResponsivenessDiagnostic["anomaly"] = "dispatch_delay"
  let summary: number | undefined
  let frame: number | undefined
  let dispatchTimer: number | undefined
  let afterDispatch: Observation[] = []
  let awaitingFrame: Observation[] = []
  let pointer: { id: number; x: number; y: number; control: Element | null; observation: Observation; ineligible: boolean } | undefined
  let gesture: Observation | undefined
  const unmatched = new Set<PendingTap>()
  const controlIds = new WeakMap<Element, number>()
  let controlId = 0
  let gestureId = 0
  let touchDispatch: Array<{ event: Event; trace: TapTrace }> = []
  let touchTimer: number | undefined

  const cancelGesture = () => { if (pointer) pointer.ineligible = true }
  const clearTaps = () => {
    pointer = undefined
    gesture = undefined
    for (const tap of unmatched) clock.cancelTimer(tap.timer)
    unmatched.clear()
  }
  const report = (phase: InputResponsivenessDiagnostic["phase"]) => {
    if (!active() || context === undefined) return
    const sessionId = context.sessionId
    options.report({
      kind: "input_responsiveness", clientInstanceId, ...context,
      phase, anomaly: lastAnomaly, ...counts,
      recent: recent.filter(item => item.sessionId === sessionId).map(item => ({
        ...item.sample,
        ...(item.sample.tap ? { tap: { ...item.sample.tap, mouseStages: [...item.sample.tap.mouseStages] } } : {}),
      })),
    })
  }
  const anomaly = (kind: keyof typeof counts, observation: Observation) => {
    if (!active()) return
    if (context !== undefined && context.sessionId !== observation.sessionId) {
      if (summary !== undefined) clock.cancelTimer(summary)
      if (counts.dispatchDelayed + counts.frameDelayed + counts.unmatchedTap > 0) report("summary")
      summary = undefined
      counts = { dispatchDelayed: 0, frameDelayed: 0, unmatchedTap: 0 }
    }
    const paneInert = root.querySelector(".pane")?.hasAttribute("inert") === true
    const client = root.querySelector(".client")
    context = {
      ...(observation.sessionId === undefined ? {} : { sessionId: observation.sessionId }),
      connection: options.connection(),
      screen: root.querySelector('[role="dialog"]') ? "dialog" : client && !client.classList.contains("stack") ? "wide" : paneInert ? "sessions" : "chat",
      paneInert, dragging: client?.classList.contains("dragging") === true,
    }
    lastAnomaly = kind === "dispatchDelayed" ? "dispatch_delay" : kind === "frameDelayed" ? "frame_delay" : "unmatched_tap"
    counts[kind] += 1
    if (summary !== undefined) return
    report("first")
    counts = { dispatchDelayed: 0, frameDelayed: 0, unmatchedTap: 0 }
    const flush = () => {
      summary = undefined
      if (counts.dispatchDelayed + counts.frameDelayed + counts.unmatchedTap === 0) return
      report("summary")
      counts = { dispatchDelayed: 0, frameDelayed: 0, unmatchedTap: 0 }
      if (active()) summary = clock.timer(flush, 60_000)
    }
    summary = clock.timer(flush, 60_000)
  }
  const inScope = (target: Element) => {
    if (root.contains(target)) return true
    if (!target.closest(".selection-grip")) return false
    const selection = document.getSelection()
    return selection?.anchorNode !== null && selection?.anchorNode !== undefined && root.contains(selection.anchorNode)
  }
  const latestGesture = () => {
    if (pointer) return pointer.observation
    return gesture && clock.now() - gesture.sample.atMs <= 1000 ? gesture : undefined
  }
  const observeMouse = (event: Event) => {
    if (!active() || !(event.target instanceof Element)) return
    const observation = latestGesture()
    if (!observation) return
    const hit = event.type === "click" ? event.target.closest(controlSelector) : null
    const trace = observation?.sample.tap
    if (!trace) return
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: only the five compatibility mouse listener names enter this path.
    const stage = event.type as TapTrace["mouseStages"][number]
    if (!trace.mouseStages.includes(stage)) trace.mouseStages = [...trace.mouseStages, stage]
    if (stage === "click") {
      trace.clickOnOtherControl ||= hit === null || controlIds.get(hit) !== trace.controlId
    }
  }
  const onAncillary = (event: Event) => {
    if (!active()) return
    if (!event.type.startsWith("touch")) { observeMouse(event); return }
    const trace = latestGesture()?.sample.tap
    if (!trace) return
    if ("touches" in event && typeof event.touches === "object" && event.touches !== null
      && "length" in event.touches && typeof event.touches.length === "number") {
      trace.maxTouches = Math.min(1e9, Math.max(trace.maxTouches ?? 0, event.touches.length))
    }
    if (event.type === "touchcancel") trace.touchCancelled = true
    touchDispatch.push({ event, trace })
    if (touchDispatch.length > 16) touchDispatch.shift()
    if (touchTimer !== undefined) return
    touchTimer = clock.timer(() => {
      touchTimer = undefined
      const pending = touchDispatch
      touchDispatch = []
      if (!active()) return
      for (const { event: touch, trace: evidence } of pending) {
        if (touch.type === "touchstart") evidence.touchStartPrevented = (evidence.touchStartPrevented ?? false) || touch.defaultPrevented
        if (touch.type === "touchmove") evidence.touchMovePrevented = (evidence.touchMovePrevented ?? false) || touch.defaultPrevented
        if (touch.type === "touchend") evidence.touchEndPrevented = (evidence.touchEndPrevented ?? false) || touch.defaultPrevented
      }
    }, 0)
  }
  const onInput = (event: Event) => {
    if (event.type === "pointerdown" && event instanceof PointerEvent && event.isPrimary) {
      pointer = undefined
      gesture = undefined
    }
    if (event.type === "click") observeMouse(event)
    if (!active() || !(event.target instanceof Element) || !inScope(event.target)) {
      cancelGesture()
      return
    }
    const { control, editable, kind: controlKind, area } = describeTarget(event.target)
    // DOM event names are closed by the installed listener list.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: only the six named DOM event listeners call this handler.
    const eventKind = event.type as InputDiagnosticSample["event"]
    const input: InputDiagnosticSample["input"] = event.type === "keydown" || event.type === "input" ? "keyboard"
      : "pointerType" in event && (event.pointerType === "touch" || event.pointerType === "mouse" || event.pointerType === "pen") ? event.pointerType : "other"
    const at = clock.now()
    const sample: MutableSample = { event: eventKind, input, control: controlKind, area, atMs: at, dispatchDelayMs: Math.max(0, at - event.timeStamp), defaultPrevented: false }
    const observation = { sample, sessionId: options.sessionId(), event }
    recent.push(observation)
    if (recent.length > 16) recent.shift()
    afterDispatch.push(observation)
    if (afterDispatch.length > 16) afterDispatch.shift()
    dispatchTimer ??= clock.timer(() => {
      dispatchTimer = undefined
      const pending = afterDispatch
      afterDispatch = []
      if (!active()) return
      for (const item of pending) {
        item.sample.defaultPrevented = item.event.defaultPrevented
        if (item.sample.dispatchDelayMs >= 100) anomaly("dispatchDelayed", item)
      }
    }, 0)
    awaitingFrame.push(observation)
    if (awaitingFrame.length > 16) awaitingFrame.shift()
    frame ??= clock.frame(() => {
      frame = undefined
      const pending = awaitingFrame
      awaitingFrame = []
      if (!active()) return
      for (const item of pending) {
        item.sample.defaultPrevented = item.event.defaultPrevented
        item.sample.frameWaitMs = Math.max(0, clock.now() - item.sample.atMs)
        if (item.sample.frameWaitMs >= 100) anomaly("frameDelayed", item)
      }
    })
    if (event.type === "click") {
      const trace = latestGesture()?.sample.tap
      if (trace) sample.tap = trace
      let matched: PendingTap | undefined
      for (const tap of unmatched) if (tap.control === control) matched = tap
      if (matched !== undefined) {
        clock.cancelTimer(matched.timer)
        unmatched.delete(matched)
      }
      return
    }
    if (!(event instanceof PointerEvent)) return
    if (event.type === "pointercancel") {
      if (pointer?.id !== event.pointerId) return
      if (pointer.observation.sample.tap) {
        sample.tap = pointer.observation.sample.tap
        sample.tap.durationMs = Math.min(1e12, Math.max(0, event.timeStamp - pointer.observation.event.timeStamp))
        sample.tap.controlConnected = pointer.control?.isConnected === true
      }
      gesture = observation
      pointer = undefined
      return
    }
    if (event.type === "pointerdown") {
      cancelGesture()
      if (event.isPrimary && event.button === 0) {
        if (control) {
          let identity = controlIds.get(control)
          if (identity === undefined) { identity = ++controlId; controlIds.set(control, identity) }
          sample.tap = { gestureId: ++gestureId, controlId: identity, maxDisplacementPx: 0, mouseStages: [] }
        }
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, control, observation, ineligible: false }
        gesture = observation
      } else if (pointer?.observation.sample.tap) {
        sample.tap = pointer.observation.sample.tap
      }
    } else if (event.type === "pointerup") {
      if (pointer?.id !== event.pointerId) return
      const down = pointer
      pointer = undefined
      gesture = observation
      if (down.observation.sample.tap) {
        const trace = down.observation.sample.tap
        sample.tap = trace
        trace.durationMs = Math.min(1e12, Math.max(0, event.timeStamp - down.observation.event.timeStamp))
        trace.maxDisplacementPx = Math.min(1e12, Math.max(trace.maxDisplacementPx, Math.hypot(event.clientX - down.x, event.clientY - down.y)))
        trace.controlConnected = down.control?.isConnected === true
        trace.releaseOnOriginalControl = document.elementFromPoint(event.clientX, event.clientY)?.closest(controlSelector) === down.control
      }
      if (down.ineligible || down.control !== control || !control
        || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10
        || control.matches(':disabled, [aria-disabled="true"]') || controlKind === "selection") return
      // Diagnostics retain a bounded sample, not an unbounded input ledger.
      if (unmatched.size >= 16) return
      const tap: PendingTap = { control, observation, timer: clock.timer(() => {
        unmatched.delete(tap)
        if (tap.observation.sample.tap) tap.observation.sample.tap.controlConnected = tap.control.isConnected
        if (!active() || tap.observation.sample.defaultPrevented
          || (editable && document.activeElement === tap.control)) return
        anomaly("unmatchedTap", tap.observation)
      }, 1000) }
      unmatched.add(tap)
    }
  }
  const onMove = (event: Event) => {
    if (event instanceof PointerEvent && pointer?.id === event.pointerId) {
      const displacement = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y)
      const trace = pointer.observation.sample.tap
      if (trace) trace.maxDisplacementPx = Math.min(1e12, Math.max(trace.maxDisplacementPx, displacement))
      if (displacement > 10) pointer.ineligible = true
    }
  }
  const onHidden = () => {
    if (!active()) {
      clearTaps()
      if (frame !== undefined) clock.cancelFrame(frame)
      frame = undefined
      awaitingFrame = []
      if (dispatchTimer !== undefined) clock.cancelTimer(dispatchTimer)
      dispatchTimer = undefined
      afterDispatch = []
      touchDispatch = []
      if (touchTimer !== undefined) clock.cancelTimer(touchTimer)
      touchTimer = undefined
    }
  }
  const events = ["pointerdown", "pointerup", "pointercancel", "click", "keydown", "input"] as const
  const ancillary = ["touchstart", "touchmove", "touchend", "touchcancel", "mouseover", "mousemove", "mousedown", "mouseup"] as const
  for (const event of ancillary) document.addEventListener(event, onAncillary, { capture: true, passive: true })
  for (const event of events) document.addEventListener(event, onInput, { capture: true, passive: true })
  document.addEventListener("pointermove", onMove, { capture: true, passive: true })
  document.addEventListener("scroll", cancelGesture, { capture: true, passive: true })
  document.addEventListener("visibilitychange", onHidden)
  return () => {
    disposed = true
    clearTaps()
    if (frame !== undefined) clock.cancelFrame(frame)
    if (dispatchTimer !== undefined) clock.cancelTimer(dispatchTimer)
    if (touchTimer !== undefined) clock.cancelTimer(touchTimer)
    if (summary !== undefined) clock.cancelTimer(summary)
    awaitingFrame = []
    afterDispatch = []
    touchDispatch = []
    for (const event of events) document.removeEventListener(event, onInput, true)
    for (const event of ancillary) document.removeEventListener(event, onAncillary, true)
    document.removeEventListener("pointermove", onMove, true)
    document.removeEventListener("scroll", cancelGesture, true)
    document.removeEventListener("visibilitychange", onHidden)
  }
}
