import { batch, createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { ModuleRowAction } from "../../../src/protocol/protocol-module.js"
import type { SessionLink } from "../client/session-navigation.js"

import { scrollerKeepsTouch, swipeAbandoned, swipeCommits, swipeDirectionOf, swipeProgress, swipeRecognized, type ScrollerState, type SwipeDirection } from "./screen-swipe.js"

/** Browser history holds the list and one chat entry that this stack owns,
 *  not a trail of visited chats. Over the chat entry sit only the entries
 *  that a level of the shown chat writes, such as a workflow's agent view,
 *  and a child that a link opens from inside such a level. Back resolves the
 *  shown session's parent at the shared popstate boundary: a chat's catalog
 *  row has none, and a child's held detail row names it, because a child is
 *  never a catalog row. A parent replaces the departed child; a root returns
 *  to the list. */

type Screen = "sessions" | "chat"

/** The machine and project the phone is attached to, as the two screens name
 *  them: the chat header's subtitle, and the list header's title. */
export interface PlacementLabels {
  readonly project: string
  readonly machine: string
  readonly action?: ModuleRowAction
}

export interface ScreenStack {
  readonly screen: Accessor<Screen>
  /** True while the chat the person just left is one step forward in history,
   *  so a leftward swipe on the list can bring it back. */
  readonly canForward: Accessor<boolean>
  /** The chat pane's offset from its resting place while a finger drags it,
   *  in pixels from the left of the container; undefined when nothing drags. */
  readonly dragX: Accessor<number | undefined>
  readonly placement: Accessor<PlacementLabels | undefined>
  /** Selects and records one chat. With no id, waits for a newly opened chat.
   *  `link` is what the tap knew, the name and the parent, for the pane to
   *  show until the chat's own row says them. */
  openChat(sessionId?: string, link?: SessionLink): void
  showSessions(): void
  back(): void
  forward(): void
  /** Binds the swipe gesture to the element the screens fill. Returns the
   *  unbind, which the caller runs on cleanup. */
  bindSwipe(root: SwipeRoot): () => void
}

/** The members of the element the screens fill that the swipe gesture reads. */
export interface SwipeRoot extends Pick<HTMLElement, "clientWidth" | "addEventListener" | "removeEventListener"> {
  readonly ownerDocument: Pick<Document, "addEventListener" | "removeEventListener"> & {
    getSelection(): Pick<Selection, "isCollapsed"> | null
  }
}

const STATE_KEY = "flywheelScreen"
/** The session a history entry shows. Every writer of an entry states it,
 *  so a host that follows the selection with the page address can tell an
 *  entry the client wrote for the new selection from one it must push. */
export const SESSION_KEY = "flywheelSession"
/** The level inside the shown chat that a history entry shows, such as a
 *  workflow's agent view. The level's owner writes and reads the value. The
 *  stack's own chat entry never carries one, so the stack can tell the entry
 *  of a level from its chat entry without knowing what the level is. */
export const LEVEL_KEY = "flywheelPlace"

function holdsLevel(state: unknown): boolean {
  return state instanceof Object && LEVEL_KEY in state && state[LEVEL_KEY] !== undefined
}

export interface ScreenStackSelection {
  /** The session the address the page loaded on names, such as a tapped
   *  notification's. The session owner opens it; a fresh page shows it on
   *  the chat screen over the list. */
  readonly addressed?: string | undefined
  readonly selectedSessionId: Accessor<string | undefined>
  /** Moves the selection in the tap. The owner decides what a repeat means:
   *  nothing for an open chat, another try for one whose open failed. */
  readonly selectSession: (sessionId: string, link?: SessionLink) => void
  readonly parentSessionId: (sessionId: string) => string | undefined
}

export interface ScreenStackNavigation {
  readonly state: unknown
  replaceState(state: unknown): void
  pushState(state: unknown): void
  back(): void
  forward(): void
  addPopStateListener(listener: (event: { readonly state: unknown }) => void): void
  removePopStateListener(listener: (event: { readonly state: unknown }) => void): void
}

function browserNavigation(): ScreenStackNavigation {
  return {
    get state() { return history.state },
    replaceState: (state) => history.replaceState(state, ""),
    pushState: (state) => history.pushState(state, ""),
    back: () => history.back(),
    forward: () => history.forward(),
    addPopStateListener: (listener) => window.addEventListener("popstate", listener),
    removePopStateListener: (listener) => window.removeEventListener("popstate", listener),
  }
}

function screenOf(state: unknown): Screen {
  return state instanceof Object && STATE_KEY in state && state[STATE_KEY] === "chat" ? "chat" : "sessions"
}

export function sessionOf(state: unknown): string | undefined {
  if (!(state instanceof Object) || !(SESSION_KEY in state)) return undefined
  return typeof state[SESSION_KEY] === "string" ? state[SESSION_KEY] : undefined
}

export function createScreenStack(
  placement: Accessor<PlacementLabels | undefined>,
  selection?: ScreenStackSelection,
  navigation: ScreenStackNavigation = browserNavigation(),
): ScreenStack {
  // The base entry is the list. A fresh load claims the current entry for it,
  // and a load on an address pushes that session's entry over it, so Back
  // leaves it as it leaves any chat. A reload mid-stack finds the chat entry
  // it pushed earlier and keeps it.
  if (screenOf(navigation.state) === "sessions") {
    navigation.replaceState({ [STATE_KEY]: "sessions" })
    if (selection?.addressed !== undefined) navigation.pushState({ [STATE_KEY]: "chat", [SESSION_KEY]: selection.addressed })
  }
  const [screen, setScreen] = createSignal<Screen>(screenOf(navigation.state))
  const [canForward, setCanForward] = createSignal(false)
  const [dragX, setDragX] = createSignal<number | undefined>(undefined)
  let requestedList = false

  const onPop = (event: { readonly state: unknown }) => batch(() => {
    if (screen() === "chat") {
      const current = selection?.selectedSessionId()
      // History holds one chat entry, so a pop from the chat screen that
      // lands on a chat entry comes from a level inside the shown chat, such
      // as a workflow's agent view. That entry stays, unless the person asked
      // for the list, which is one entry further. The level's own listener
      // may already have moved the selection, as an agent that the chat's
      // inline card opened returns to that chat, so the selection does not
      // decide this.
      if (screenOf(event.state) === "chat") {
        if (requestedList) navigation.back()
        return
      }
      const parent = !requestedList && current !== undefined ? selection?.parentSessionId(current) : undefined
      requestedList = false
      navigation.replaceState({ [STATE_KEY]: "sessions" })
      setScreen("sessions")
      setCanForward(true)
      if (parent !== undefined) openChat(parent)
      return
    }
    const next = screenOf(event.state)
    setCanForward(false)
    setScreen(next)
    const sessionId = sessionOf(event.state)
    if (next !== "chat" || sessionId === undefined || sessionId === selection?.selectedSessionId()) return
    selection?.selectSession(sessionId)
  })
  navigation.addPopStateListener(onPop)
  onCleanup(() => navigation.removePopStateListener(onPop))

  const openChat = (sessionId?: string, link?: SessionLink) => {
    if (screen() === "chat" && sessionOf(navigation.state) === sessionId) {
      // The entry already names this chat, but its open may have failed, so
      // the tap still reaches the selection owner, which can try again.
      if (sessionId !== undefined) selection?.selectSession(sessionId, link)
      return
    }
    const entry = {
      [STATE_KEY]: "chat",
      ...(sessionId === undefined ? {} : { [SESSION_KEY]: sessionId }),
    }
    // Another chat takes the one chat entry, and Back resolves its parent at
    // the list. A level owns the entry it is at, so a child that a link opens
    // from inside a level goes over the level's entry, and Back returns to it.
    const fromLevel = link !== undefined && link.parentSessionId === selection?.selectedSessionId() && holdsLevel(navigation.state)
    if (screen() === "chat" && !fromLevel) navigation.replaceState(entry)
    else navigation.pushState(entry)
    setCanForward(false)
    setScreen("chat")
    if (sessionId !== undefined) selection?.selectSession(sessionId, link)
  }
  if (selection !== undefined) {
    createEffect(on(selection.selectedSessionId, (sessionId) => {
      if (screen() !== "chat" || sessionId === undefined || sessionOf(navigation.state) === sessionId) return
      // The selection left any level the entry showed, so the stack writes
      // its own chat entry with no level's key.
      navigation.replaceState({ [STATE_KEY]: "chat", [SESSION_KEY]: sessionId })
      setCanForward(false)
    }))
  }
  const back = () => { if (screen() === "chat") navigation.back() }
  const forward = () => { if (screen() === "sessions" && canForward()) navigation.forward() }

  interface Gesture {
    readonly startX: number
    readonly startY: number
    /** What the finger landed on. The sideways scroller above it, if any, is
     *  looked up only once a swipe is recognised: the lookup reads layout, and
     *  reading layout on every touch start while a turn streams pays for a
     *  relayout the scroll would otherwise never wait for. */
    readonly target: EventTarget | null
    direction: SwipeDirection | undefined
    lastX: number
    lastTime: number
    velocity: number
  }

  /** The closest ancestor that scrolls sideways, or nothing. */
  const scrollerUnder = (target: EventTarget | null, root: SwipeRoot): ScrollerState | undefined => {
    for (let element = target instanceof Element ? target : null; element !== null && element !== root; element = element.parentElement) {
      if (element.scrollWidth <= element.clientWidth) continue
      const overflow = getComputedStyle(element).overflowX
      if (overflow === "auto" || overflow === "scroll") return element
    }
    return undefined
  }

  const bindSwipe = (root: SwipeRoot) => {
    let gesture: Gesture | undefined
    const width = () => root.clientWidth
    const selectionOwnsTouch = () => root.ownerDocument.getSelection()?.isCollapsed === false
    const touchCancel = () => {
      gesture = undefined
      setDragX(undefined)
    }
    const selectionChanged = () => {
      if (selectionOwnsTouch()) touchCancel()
    }
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || gesture !== undefined || selectionOwnsTouch()) return
      const touch = event.touches[0]!
      gesture = { startX: touch.clientX, startY: touch.clientY, target: event.target, direction: undefined, lastX: touch.clientX, lastTime: event.timeStamp, velocity: 0 }
    }
    const touchMove = (event: TouchEvent) => {
      if (gesture === undefined) return
      if (selectionOwnsTouch()) { touchCancel(); return }
      const touch = event.touches[0]!
      const dx = touch.clientX - gesture.startX
      const dy = touch.clientY - gesture.startY
      if (gesture.direction === undefined) {
        if (swipeAbandoned(dx, dy)) { gesture = undefined; return }
        if (!swipeRecognized(dx, dy)) return
        const direction = swipeDirectionOf(dx)
        // A swipe is only the one this screen can take: back from a chat,
        // forward from the list while a chat is one step ahead. Anything else
        // is the scroller's, or nothing.
        const armed = direction === "back" ? screen() === "chat" : screen() === "sessions" && canForward()
        if (!armed || scrollerKeepsTouch(scrollerUnder(gesture.target, root), direction)) { gesture = undefined; return }
        gesture.direction = direction
      }
      const elapsed = event.timeStamp - gesture.lastTime
      if (elapsed > 0) gesture.velocity = (gesture.direction === "back" ? 1 : -1) * (touch.clientX - gesture.lastX) / elapsed
      gesture.lastX = touch.clientX
      gesture.lastTime = event.timeStamp
      const travel = swipeProgress(gesture.direction, dx, width()) * width()
      // Back drags the chat right from rest; forward pulls it in from the right.
      setDragX(gesture.direction === "back" ? travel : width() - travel)
    }
    const touchEnd = () => {
      if (gesture === undefined) return
      if (selectionOwnsTouch()) { touchCancel(); return }
      const done = gesture
      gesture = undefined
      if (done.direction === undefined) return
      const progress = swipeProgress(done.direction, done.lastX - done.startX, width())
      setDragX(undefined)
      if (!swipeCommits(progress, done.velocity)) return
      if (done.direction === "back") back()
      else forward()
    }
    // Passive throughout. A touchmove listener that may cancel makes the
    // browser wait for the main thread before it can move the transcript on
    // every frame of every scroll, and while a turn streams the main thread
    // is often busy, so the finger stalls. Native text selection keeps its
    // touches; otherwise the swipe reads
    // the moves and drives the screen without taking them from the browser.
    root.addEventListener("touchstart", touchStart, { passive: true })
    root.addEventListener("touchmove", touchMove, { passive: true })
    root.addEventListener("touchend", touchEnd)
    root.addEventListener("touchcancel", touchCancel)
    root.ownerDocument.addEventListener("selectionchange", selectionChanged)
    return () => {
      root.removeEventListener("touchstart", touchStart)
      root.removeEventListener("touchmove", touchMove)
      root.removeEventListener("touchend", touchEnd)
      root.removeEventListener("touchcancel", touchCancel)
      root.ownerDocument.removeEventListener("selectionchange", selectionChanged)
    }
  }

  return {
    screen,
    canForward,
    dragX,
    placement,
    openChat,
    showSessions: () => {
      if (screen() !== "chat") return
      requestedList = true
      back()
    },
    back,
    forward,
    bindSwipe,
  }
}
