import { Key } from "@solid-primitives/keyed"
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"

import type { SessionCatalogError } from "../../../src/protocol/app-service-types.js"
import { formatTimeAgo } from "../client/format-time.js"
import type { SessionSummary } from "../client/view-state.js"
import { Icon, ICONS } from "./icons.js"
import { rowReveal, rowSettlesOpen, rowSwipeOwns } from "./row-swipe.js"
import { swipeAbandoned, swipeRecognized } from "./screen-swipe.js"
import { layoutSessionRows, type SessionRow as Row } from "./session-rows.js"
import "../styles/session-list.css"

/** The session list, as the rail, the phone's own screen, and the sessions
 *  sheet all draw it. One row shape everywhere, so a chat looks the same
 *  whichever surface a person finds it in: the live dot,
 *  the short title with the longer description under it, what needs them, the
 *  lines it changed, and how long ago it moved.
 *
 *  A row is a face over a tray. The face carries everything a person reads;
 *  the tray behind it holds the row's actions. A pointer that can hover sees
 *  the tray laid over the row's end on hover, as before. A finger slides the
 *  face aside to reveal it, the way a mail row opens, and one row is open at a
 *  time: the next touch anywhere else closes it. */

export interface SessionListActions {
  readonly onSelect: (sessionId: string) => void
  readonly onCopy?: (sessionId: string) => void
  readonly onClose?: (sessionId: string) => void
  readonly onDelete?: (sessionId: string) => void
  readonly onRename?: (sessionId: string) => void
  /** True while an action on the session runs, such as Close or Delete. */
  readonly working: (sessionId: string) => boolean
}

/** The one row whose tray is showing, and by how much. `dragging` while a
 *  finger holds it, so the face follows without easing. */
interface Tray {
  readonly id: string
  readonly reveal: number
  readonly dragging: boolean
}

function matches(session: SessionSummary, query: string): boolean {
  return session.title.toLowerCase().includes(query) || (session.subtitle?.toLowerCase().includes(query) ?? false) || session.id.startsWith(query)
}

const NEED_TITLES = {
  question: "A question waits for your answer",
  error: "The session reports an error",
} as const

export function SessionList(props: {
  readonly sessions: readonly SessionSummary[]
  readonly errors: readonly SessionCatalogError[]
  readonly selected: string | undefined
  /** False while the phone's list is behind its chat screen. */
  readonly shown?: boolean
  /** Highlighted row for keyboard navigation, by index into the visible rows. */
  readonly active?: number
  readonly onActive?: (index: number) => void
  /** Group headings for the long-form list. */
  readonly grouped?: boolean
  readonly filter?: string
  readonly actions: SessionListActions
}) {
  const rows = createMemo((previous: readonly Row[]) => {
    const query = props.filter?.trim().toLowerCase() ?? ""
    const visible = query.length === 0 ? props.sessions : props.sessions.filter((session) => matches(session, query))
    return layoutSessionRows(visible, props.grouped === true, previous)
  }, [])

  const [tray, setTray] = createSignal<Tray | undefined>(undefined)
  let revealedSelected = false
  const revealSelected = (row: HTMLElement) => {
    if (revealedSelected) return
    revealedSelected = true
    row.scrollIntoView({ block: "nearest", behavior: "instant" })
  }
  const revealOf = (id: string): number => (tray()?.id === id ? tray()?.reveal ?? 0 : 0)
  const draggingOf = (id: string): boolean => tray()?.id === id && tray()?.dragging === true

  // Every action closes the tray it was chosen from, and choosing an open
  // row's face closes the tray instead of opening the chat: the tap that
  // dismisses is not also a tap that navigates.
  const settled = (run: ((sessionId: string) => void) | undefined) =>
    run === undefined ? undefined : (sessionId: string) => { setTray(undefined); run(sessionId) }
  const actions = createMemo((): SessionListActions => {
    const copy = settled(props.actions.onCopy)
    const close = settled(props.actions.onClose)
    const remove = settled(props.actions.onDelete)
    const rename = settled(props.actions.onRename)
    return {
      onSelect: (sessionId) => {
        if (tray()?.id === sessionId) { setTray(undefined); return }
        props.actions.onSelect(sessionId)
      },
      working: props.actions.working,
      ...(copy === undefined ? {} : { onCopy: copy }),
      ...(close === undefined ? {} : { onClose: close }),
      ...(remove === undefined ? {} : { onDelete: remove }),
      ...(rename === undefined ? {} : { onRename: rename }),
    }
  })

  return (
    <div class="session-list" ref={(root) => onCleanup(bindRowSwipe(root, tray, setTray))}>
      <Show when={rows().length === 0 && props.errors.length === 0}>
        <div class="session-list-empty">{(props.filter?.trim().length ?? 0) > 0 ? "No chats match." : "No chats yet."}</div>
      </Show>
      {/* Keyed by the session's id, not by row reference: a row object is
          minted whenever the tree is laid out again, and a reference-keyed
          list would rebuild every row's markup for a change to one of them. */}
      <Key each={rows()} by={(row) => row.session.id}>
        {(row, index) => (
          <>
            <Show when={row().heading}>{(label) => <div class="session-group-label">{label()}</div>}</Show>
            <SessionRow
              row={row()}
              selected={row().session.id === props.selected}
              shown={props.shown !== false}
              revealSelected={revealSelected}
              active={props.active === index()}
              reveal={revealOf(row().session.id)}
              dragging={draggingOf(row().session.id)}
              onActive={() => props.onActive?.(index())}
              actions={actions()}
            />
          </>
        )}
      </Key>
      <Show when={props.errors.length > 0}>
        <div class="session-group-label">Unreadable</div>
        <Key each={props.errors} by="sessionId">
          {(error) => (
            <div
              class="session-row session-row-unreadable"
              data-session={error().sessionId}
              classList={{ dragging: draggingOf(error().sessionId), revealed: revealOf(error().sessionId) > 0 }}
              style={{ "--session-reveal": `${revealOf(error().sessionId)}px` }}
            >
              <div class="session-row-body">
                <span class="session-lead"><span class="session-dot" /></span>
                <span class="session-title">{error().sessionId}</span>
              </div>
              <Show when={actions().onDelete}>
                <span class="session-row-actions">
                  <button class="row-action danger-action" title="Delete permanently" aria-label={`Delete ${error().sessionId}`} aria-busy={actions().working(error().sessionId) || undefined} onClick={() => actions().onDelete?.(error().sessionId)}>
                    <Icon path={ICONS.trash} size={13} />
                  </button>
                </span>
              </Show>
            </div>
          )}
        </Key>
      </Show>
    </div>
  )
}

function SessionRow(props: {
  readonly row: Row
  readonly selected: boolean
  readonly shown: boolean
  readonly revealSelected: (row: HTMLElement) => void
  readonly active: boolean
  readonly reveal: number
  readonly dragging: boolean
  readonly onActive: () => void
  readonly actions: SessionListActions
}) {
  const session = () => props.row.session
  const diff = () => session().diffStats
  const hasDiff = () => { const stats = diff(); return stats !== undefined && (stats.added > 0 || stats.removed > 0 || stats.modified > 0) }
  let element: HTMLDivElement | undefined
  createEffect(() => {
    const row = element
    if (props.selected && props.shown && row) untrack(() => props.revealSelected(row))
  })
  return (
    <div
      class="session-row"
      ref={(el) => { element = el }}
      role="option"
      aria-selected={props.selected}
      aria-busy={props.actions.working(session().id) || undefined}
      data-active={props.active}
      data-session={session().id}
      classList={{ dragging: props.dragging, revealed: props.reveal > 0 }}
      style={{ "--session-reveal": `${props.reveal}px` }}
      onMouseEnter={props.onActive}
      onClick={() => props.actions.onSelect(session().id)}
    >
      <div class="session-row-body">
        <span class="session-lead">
          <span class="session-dot" classList={{ open: session().active, live: session().working, waiting: session().awaitingAnswer === true }} />
        </span>
        <span class="session-title">
          {session().title}
        </span>
        <span class="session-when">{formatTimeAgo(session().lastUpdated)}</span>
        <Show when={session().subtitle}>{(subtitle) => <span class="session-subtitle">{subtitle()}</span>}</Show>
        <span class="session-meta" aria-busy={session().totalsLoading || undefined}>
          <Show when={session().totalsLoading}><span class="session-totals-loading">totals loading</span></Show>
          <Show when={props.row.need}>
            {(need) => <span class="session-badge" classList={{ waiting: need() === "question", error: need() === "error" }} title={NEED_TITLES[need()]}>{need()}</span>}
          </Show>
          <Show when={hasDiff()}>
            <span class="session-diff" title="Lines added, changed, and removed this session">
              <Show when={(diff()?.added ?? 0) > 0}><span class="session-diff-add">+{diff()?.added}</span></Show>
              <Show when={(diff()?.modified ?? 0) > 0}><span class="session-diff-mod">~{diff()?.modified}</span></Show>
              <Show when={(diff()?.removed ?? 0) > 0}><span class="session-diff-del">-{diff()?.removed}</span></Show>
            </span>
          </Show>
        </span>
      </div>
      <span class="session-row-actions">
        <Show when={props.actions.onCopy}>
          <button class="row-action" title="Copy session ID" aria-label={`Copy session ID for ${session().title}`} onClick={(event) => { event.stopPropagation(); props.actions.onCopy?.(session().id) }}>
            <Icon path={ICONS.copy} size={13} />
          </button>
        </Show>
        <Show when={props.actions.onRename}>
          <button class="row-action" title="Rename" aria-label={`Rename ${session().title}`} onClick={(event) => { event.stopPropagation(); props.actions.onRename?.(session().id) }}>
            <Icon path={ICONS.pencil} size={13} />
          </button>
        </Show>
        <Show when={session().active && props.actions.onClose}>
          <button class="row-action" title="Close session" aria-label={`Close ${session().title}`} onClick={(event) => { event.stopPropagation(); props.actions.onClose?.(session().id) }}>
            <Icon path={ICONS.close} size={13} />
          </button>
        </Show>
        <Show when={props.actions.onDelete}>
          <button class="row-action danger-action" title="Delete permanently" aria-label={`Delete ${session().title}`} onClick={(event) => { event.stopPropagation(); props.actions.onDelete?.(session().id) }}>
            <Icon path={ICONS.trash} size={13} />
          </button>
        </Show>
      </span>
    </div>
  )
}

/** Binds the row swipe to the list. One listener set for every row, found
 *  from the touch's target, so a list of hundreds of rows pays for none. */
function bindRowSwipe(root: HTMLElement, tray: () => Tray | undefined, setTray: (next: Tray | undefined) => void): () => void {
  interface Gesture {
    readonly id: string
    readonly row: HTMLElement
    readonly startX: number
    readonly startY: number
    /** How far the row was already revealed when the finger landed. */
    readonly rest: number
    trayWidth: number
    /** True once the swipe has been recognised as this row's. */
    owned: boolean
    lastX: number
    lastTime: number
    velocity: number
  }
  let gesture: Gesture | undefined

  const rowUnder = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(".session-row[data-session]") : null

  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) { gesture = undefined; return }
    const touch = event.touches[0]!
    const row = rowUnder(event.target)
    const id = row?.dataset.session
    const open = tray()
    // A touch anywhere but the open row closes it. A tap that follows on
    // another row still selects that row.
    if (open !== undefined && open.id !== id) setTray(undefined)
    if (row === null || id === undefined) return
    gesture = { id, row, startX: touch.clientX, startY: touch.clientY, rest: open?.id === id ? open.reveal : 0, trayWidth: 0, owned: false, lastX: touch.clientX, lastTime: event.timeStamp, velocity: 0 }
  }
  const touchMove = (event: TouchEvent) => {
    if (gesture === undefined) return
    const touch = event.touches[0]!
    const dx = touch.clientX - gesture.startX
    const dy = touch.clientY - gesture.startY
    if (!gesture.owned) {
      if (swipeAbandoned(dx, dy)) { gesture = undefined; return }
      if (!swipeRecognized(dx, dy)) return
      if (!rowSwipeOwns(dx, gesture.rest)) { gesture = undefined; return }
      // Read once the swipe is the row's: the tray's width is a layout read,
      // and paying it on every touch start would make the list wait for
      // layout before it could scroll.
      gesture.trayWidth = gesture.row.querySelector<HTMLElement>(".session-row-actions")?.offsetWidth ?? 0
      if (gesture.trayWidth === 0) { gesture = undefined; return }
      gesture.owned = true
    }
    // The screen stack listens above this list for the swipe that brings a
    // chat forward. A row that owns the touch keeps the move from it, so the
    // row and the screen never slide together.
    event.stopPropagation()
    const elapsed = event.timeStamp - gesture.lastTime
    if (elapsed > 0) gesture.velocity = (gesture.lastX - touch.clientX) / elapsed
    gesture.lastX = touch.clientX
    gesture.lastTime = event.timeStamp
    setTray({ id: gesture.id, reveal: rowReveal(dx, gesture.rest, gesture.trayWidth), dragging: true })
  }
  const touchEnd = () => {
    if (gesture === undefined) return
    const done = gesture
    gesture = undefined
    if (!done.owned) return
    const reveal = rowReveal(done.lastX - done.startX, done.rest, done.trayWidth)
    setTray(rowSettlesOpen(reveal, done.trayWidth, done.velocity) ? { id: done.id, reveal: done.trayWidth, dragging: false } : undefined)
  }
  const touchCancel = () => {
    if (gesture === undefined) return
    const done = gesture
    gesture = undefined
    if (!done.owned) return
    // The browser took the touch: the row goes back to where it rested.
    setTray(done.rest > 0 ? { id: done.id, reveal: done.rest, dragging: false } : undefined)
  }
  // Passive throughout, for the same reason the screen swipe is: a sideways
  // drag has no native gesture to compete with, and a listener that may
  // cancel would make every scroll of the list wait for the main thread.
  root.addEventListener("touchstart", touchStart, { passive: true })
  root.addEventListener("touchmove", touchMove, { passive: true })
  root.addEventListener("touchend", touchEnd)
  root.addEventListener("touchcancel", touchCancel)
  return () => {
    root.removeEventListener("touchstart", touchStart)
    root.removeEventListener("touchmove", touchMove)
    root.removeEventListener("touchend", touchEnd)
    root.removeEventListener("touchcancel", touchCancel)
  }
}
