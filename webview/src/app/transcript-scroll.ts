import type { ReadingState } from "../../../src/protocol/client/reading-state.js"
import { rowHolding, rowIdentity, type TranscriptViewRow } from "../client/tool-runs.js"

export interface ReaderExpansionState {
  readonly pending: boolean
  readonly following: boolean
}

/** Keeps the live tail clear when the viewport or transcript content resizes,
 * and otherwise calls `holdReader` to keep the reader's row in place. A resize
 * can reflow the rows above the reader with no DOM mutation, such as a pane
 * width change or a rotation, and the browser's own anchoring is off. The
 * caller owns following intent and the reader's anchor. Disposing stops all
 * layout observation. */
export function followTranscriptLayout(viewport: HTMLElement, content: HTMLElement, following: () => boolean, holdReader: () => void): () => void {
  const observer = new ResizeObserver(() => {
    if (following()) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" })
    else holdReader()
  })
  observer.observe(viewport)
  observer.observe(content)
  return () => observer.disconnect()
}

/** Publishes the rendered height of an element inside a resident pane
 *  to that shared pane as the CSS length `property`, and follows it as the
 *  element resizes. The transcript reads the length to keep its newest output
 *  and the row a landing centers clear of the element. Measured, not
 *  declared, because the element grows with its content. Disposing stops the
 *  observation and removes the length. */
export function publishPaneHeight(element: HTMLElement, property: string): () => void {
  // SAFETY: Composer and FindBar mount inside PersistentPane before their onMount callbacks run.
  const pane = element.closest<HTMLElement>(".pane-resident")!
  const measure = (): void => pane.style.setProperty(property, `${element.offsetHeight}px`)
  const observer = new ResizeObserver(measure)
  // The border box, because the height read is offsetHeight: a padding change
  // alone, such as the home-indicator inset returning as the keyboard closes,
  // leaves the content box as it was.
  observer.observe(element, { box: "border-box" })
  measure()
  return () => {
    observer.disconnect()
    pane.style.removeProperty(property)
  }
}

export type ReaderDisclosureIntent =
  | { readonly action: "open"; readonly pending: boolean }
  | { readonly action: "close" }

export interface ReaderExpansionMutation extends ReaderExpansionState {
  readonly consumed: boolean
}

export interface ReaderAnchorRect {
  readonly id: string
  readonly top: number
  readonly bottom: number
}

/** Selects the first transcript row that reaches into the visible viewport.
 *  It reads `rows` only up to that row. */
export function firstVisibleReaderAnchor<Row extends ReaderAnchorRect>(rows: Iterable<Row>, viewportTop: number): Row | undefined {
  for (const row of rows) {
    if (row.bottom > viewportTop) return row
  }
  return undefined
}

/** Distinguishes history inserted before the resident rows from live output appended after them. */
function hasPrependedReaderRows(previousIds: readonly string[], currentIds: readonly string[]): boolean {
  const previousFirst = previousIds[0]
  return previousFirst !== undefined && currentIds.indexOf(previousFirst) > 0
}

interface ReaderViewport {
  readonly scrollTop: number
  top(): number
  rows(): Iterable<ReaderAnchorRect>
  scrollTo(top: number): void
}

interface OlderPageScrollOptions {
  readonly viewport: ReaderViewport
  readonly sessionId: () => string | undefined
  readonly blockIds: () => readonly string[]
  readonly loadOlder: () => Promise<boolean>
}

interface OlderPageScroll {
  /** Starts a page unless one is pending. */
  load(): void
  /** Refreshes a pending page's reading position from `reader`, the row the
   *  scroll measured the reader on, or starts a page if the scroll requests
   *  one. It reads no rows itself. */
  onScroll(loadOlder: boolean, reader: () => Pick<ReaderAnchorRect, "id" | "top"> | undefined): void
  /** Returns whether this mutation consumed an older-page landing. */
  reconcile(): boolean
}

/** Owns one older-page request and keeps the reader's rendered row in place when it lands. */
export function createOlderPageScroll(options: OlderPageScrollOptions): OlderPageScroll {
  let pending: {
    readonly sessionId: string | undefined
    readonly blockIds: readonly string[]
    readonly rows: readonly ReaderAnchorRect[]
    readonly scrollTop: number
    anchor: Pick<ReaderAnchorRect, "id" | "top">
  } | undefined

  const load = () => {
    if (pending !== undefined) return
    const rows = [...options.viewport.rows()]
    const anchor = firstVisibleReaderAnchor(rows, options.viewport.top())
    if (anchor === undefined) return
    const operation = {
      sessionId: options.sessionId(),
      blockIds: options.blockIds(),
      rows,
      scrollTop: options.viewport.scrollTop,
      anchor: { id: anchor.id, top: anchor.top },
    }
    pending = operation
    void options.loadOlder().then((loaded) => {
      if (pending === operation && !loaded) pending = undefined
    })
  }

  return {
    load,
    onScroll(loadOlder, reader) {
      if (pending === undefined) {
        if (loadOlder) load()
        return
      }
      const anchor = reader()
      if (anchor !== undefined) pending.anchor = { id: anchor.id, top: anchor.top }
    },
    reconcile() {
      const operation = pending
      if (operation === undefined) return false
      if (options.sessionId() !== operation.sessionId) {
        pending = undefined
        return false
      }
      if (!hasPrependedReaderRows(operation.blockIds, options.blockIds())) return false
      const rows = [...options.viewport.rows()]
      const currentIds = rows.map(row => row.id)
      const anchorId = survivingReaderAnchor(operation.rows.map(row => row.id), currentIds, operation.anchor.id)
      const currentAnchor = rows.find(row => row.id === anchorId)
      const previousAnchor = operation.rows.find(row => row.id === anchorId)
      const previousTop = anchorId === operation.anchor.id
        ? operation.anchor.top
        : previousAnchor === undefined ? undefined : previousAnchor.top + operation.scrollTop - options.viewport.scrollTop
      if (currentAnchor !== undefined && previousTop !== undefined) {
        options.viewport.scrollTo(preserveReaderAnchor(options.viewport.scrollTop, currentAnchor.top, previousTop))
      }
      pending = undefined
      return true
    },
  }
}

interface RestoreWindow {
  readonly start: number | null
  readonly hasBefore: boolean
}

interface ReadingRestoreOptions<Window extends RestoreWindow> {
  /** How many older pages the restore reads back before it settles for the tail. */
  readonly pages: number
  /** The rendered window: its first absolute block index and whether older
   *  history exists. Undefined while no window has rendered. */
  readonly window: () => Window | undefined
  /** Scrolls the saved row back to its offset inside the same rendered
   *  window the attempt read. Answers `landed` when it did, `pending` while
   *  the saved index lies inside the window but its row is not in the
   *  document yet, and `before` while it lies before the window. */
  readonly land: (window: Window) => "landed" | "pending" | "before"
  readonly loadOlder: () => Promise<boolean>
  /** Asks for another attempt after a page request ends without a page. */
  readonly retry: () => void
  /** The saved place cannot become resident. Called once. */
  readonly settleAtTail: () => void
}

interface ReadingRestore {
  /** Lands the saved place if it is rendered, or reads one more older page
   *  back once the previous page has rendered. */
  attempt(): void
}

/** Owns reading older pages back until a saved reading place is rendered.
 *  Each attempt reads the rendered window, never a request's settlement. */
export function createReadingRestore<Window extends RestoreWindow>(options: ReadingRestoreOptions<Window>): ReadingRestore {
  let pagesLeft = options.pages
  // The window start a requested page has to move. The client paints a
  // committed page after the request settles, so until the rendered start
  // moves, the page is still on its way even though the request is done.
  let requestedFrom: { readonly start: number | null } | undefined
  return {
    attempt() {
      const window = options.window()
      if (window === undefined || options.land(window) !== "before" || window.start === requestedFrom?.start) return
      if (!window.hasBefore || pagesLeft === 0) {
        options.settleAtTail()
        return
      }
      pagesLeft -= 1
      const request = { start: window.start }
      requestedFrom = request
      void options.loadOlder().then((loaded) => {
        if (loaded || requestedFrom !== request) return
        requestedFrom = undefined
        options.retry()
      })
    },
  }
}

/** A saved reading place that waits to land, and the pager that reads older
 *  pages back to it. `seenMessages` is how many messages the reader had seen
 *  there, which a reload does not know. */
export interface PendingRestore {
  readonly place: ReadingState
  readonly seenMessages?: number
  readonly pager: ReadingRestore
}

/** The one owner of the transcript's scroll position: the tail pin, the
 *  reader, or a saved place that waits for its row. A restore never follows
 *  the tail, because they are different variants of one value. */
export type ReaderMode =
  | { readonly kind: "following" }
  | { readonly kind: "reading" }
  | { readonly kind: "restoring"; readonly restore: PendingRestore }

export type ReaderEvent =
  | { readonly kind: "scrolled"; readonly expansionPending: boolean; readonly nearTail: boolean; readonly upward: boolean }
  | { readonly kind: "expansionSettled"; readonly following: boolean }
  | { readonly kind: "restoreStarted"; readonly restore: PendingRestore }
  | { readonly kind: "restoreLanded" }
  | { readonly kind: "restoreSettledAtTail" }
  | { readonly kind: "blockLanded" }
  | { readonly kind: "jumpedToLatest" }
  | { readonly kind: "sessionOpened" }

const FOLLOWING: ReaderMode = { kind: "following" }
const READING: ReaderMode = { kind: "reading" }

/** The reader mode after one event. While a restore owns the position, a
 *  scroll event, whether the reader's or a clamp's, changes nothing: only the
 *  restore's landing, its settling at the tail, a block landing, Return to
 *  latest, or another session ends it. */
export function nextReaderMode(mode: ReaderMode, event: ReaderEvent): ReaderMode {
  switch (event.kind) {
    case "scrolled":
      if (mode.kind === "restoring") return mode
      if (event.expansionPending) return READING
      if (event.nearTail) return FOLLOWING
      return event.upward ? READING : mode
    case "expansionSettled": return event.following ? FOLLOWING : READING
    case "restoreStarted": return { kind: "restoring", restore: event.restore }
    case "restoreLanded":
    case "blockLanded": return READING
    case "restoreSettledAtTail":
    case "jumpedToLatest":
    case "sessionOpened": return FOLLOWING
  }
}

/** Returns the scroll offset that keeps one row at its pre-mutation viewport position. */
export function preserveReaderAnchor(scrollTop: number, currentTop: number, anchorTop: number): number {
  return scrollTop + currentTop - anchorTop
}

interface ReaderAnchor {
  reconcile(): void
  /** Accepts a position already restored by another scroll owner. */
  rebase(): void
}

/** Captures a row's scroll-content position and reconciles only layout movement.
 * Each correction is consumed once. A detached row no longer owns a reading position.
 * Content that shrinks under the viewport makes the browser clamp the scroll
 * offset to its new maximum before the correction runs, so a clamped offset
 * is corrected from the reader's last known offset instead. */
export function captureReaderAnchor(
  viewport: {
    readonly scrollTop: number
    readonly scrollHeight: number
    readonly clientHeight: number
    getBoundingClientRect(): Pick<DOMRect, "top">
    scrollTo(options: ScrollToOptions): void
  },
  row: { readonly isConnected: boolean; getBoundingClientRect(): Pick<DOMRect, "top"> },
): ReaderAnchor {
  const contentTop = () => row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
  let previousTop = contentTop()
  let previousScrollTop = viewport.scrollTop
  // Below the maximum the offset was not clamped and still carries the
  // reader's own scrolling since capture, which a correction must keep. At
  // the maximum the browser can have clamped it. The reader's offset can also
  // have moved past the captured one, and then been clamped before the next
  // scroll event captured again, so the larger of the two is the reader's.
  const readerScrollTop = () => {
    const current = viewport.scrollTop
    return current >= viewport.scrollHeight - viewport.clientHeight ? Math.max(current, previousScrollTop) : current
  }
  return {
    reconcile() {
      if (!row.isConnected) return
      const top = contentTop()
      const delta = top - previousTop
      previousTop = top
      if (delta === 0) return
      previousScrollTop = readerScrollTop() + delta
      viewport.scrollTo({ top: previousScrollTop, behavior: "instant" })
    },
    rebase() {
      previousTop = contentTop()
      previousScrollTop = viewport.scrollTop
    },
  }
}

/** Keeps an identity anchor, falling forward and then backward through its prior order. */
export function survivingReaderAnchor(previousIds: readonly string[], currentIds: readonly string[], anchorId: string): string | undefined {
  if (currentIds.includes(anchorId)) return anchorId
  const oldIndex = previousIds.indexOf(anchorId)
  return previousIds.slice(oldIndex + 1).find(id => currentIds.includes(id))
    ?? previousIds.slice(0, oldIndex).toReversed().find(id => currentIds.includes(id))
}

/** Decides whether one transcript mutation belongs to a reader-started expansion. */
export function settleReaderExpansionMutation(
  state: ReaderExpansionState,
  disclosure: ReaderDisclosureIntent | undefined,
  stillPending: boolean,
  nearTail: boolean,
): ReaderExpansionMutation {
  if (disclosure?.action === "close") {
    return { pending: stillPending, following: nearTail, consumed: true }
  }
  if (disclosure?.action === "open") {
    return {
      pending: stillPending,
      following: disclosure.pending ? false : nearTail,
      consumed: true,
    }
  }
  if (state.pending) {
    return { pending: stillPending, following: false, consumed: true }
  }
  return { ...state, consumed: false }
}

interface BlockLandingOptions {
  /** The rows the transcript renders now. */
  readonly rows: () => readonly TranscriptViewRow[]
  /** Reveals a collapsed row only while this landing is pending. */
  readonly reveal?: (row: TranscriptViewRow) => void
  /** Brings the rendered row with this key to the middle of the view. It
   *  answers false while no such row is in the document. */
  readonly center: (rowId: string) => boolean
}

export interface BlockLanding {
  /** Asks the view to land on the row that holds a block, as a search hit or
   *  a background row names it. An undefined block cancels a landing that
   *  still waits. */
  land(blockId: string | undefined): void
  /** Lands the waiting request once a transcript mutation has rendered its
   *  row. Answers true when this call moved the view. */
  reconcile(): boolean
}

/** Owns one landing request. The block a landing names usually arrives with
 *  a window the client paints after the request resolves, so the landing
 *  waits for the render that brings its row into the document, then lands
 *  once and leaves the reader there. */
export function createBlockLanding(options: BlockLandingOptions): BlockLanding {
  let pending: string | undefined
  const attempt = (): boolean => {
    if (pending === undefined) return false
    const rows = options.rows()
    const holding = rowHolding(rows, pending)
    const row = rows.find(candidate => rowIdentity(candidate) === holding)
    if (row !== undefined) options.reveal?.(row)
    const rowId = rowHolding(options.rows(), pending)
    if (rowId === undefined || !options.center(rowId)) return false
    pending = undefined
    return true
  }
  return {
    land(blockId) {
      pending = blockId
      attempt()
    },
    reconcile: attempt,
  }
}
