import { Key } from "@solid-primitives/keyed"
import { type Accessor, batch, createComponent, createComputed, createEffect, createMemo, createSignal, mergeProps, on, onCleanup, onMount, Show, untrack } from "solid-js"

import { isActiveActivity, type FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import { DEFAULT_WRITE_SYNTAX_THEME_ID } from "../../../src/protocol/write-syntax-theme.js"
import { unseenMessageCount } from "../../../src/protocol/client/return-to-latest.js"
import { restoredScrollTop, type ReadingState } from "../../../src/protocol/client/reading-state.js"
import { blockEndTimes, createWebTranscript, rowAtIndex, rowBlockIdentities, rowHolding, rowIdentity, rowIndex, runningTimeIds, type PresentedWebBlock } from "../client/tool-runs.js"
import { createTurnFolds, turnCalls } from "../client/turn-folds.js"
import { createTurnMutationMetadata, TurnChanges } from "./turn-changes.js"
import type { ClientViewState } from "../client/view-state.js"
import { Block, type BlockProps, createToolPresentation, TurnFoldBlock } from "./blocks.js"
import { LocalUserMessage } from "./message.js"
import { actionKey } from "../client/action-key.js"
import { useClientExtensions } from "./client-extensions.js"
import { useClient } from "./client-context.js"
import { ToolGroupBlock } from "./tool-group.js"
import { IntroCard } from "./intro-card.js"
import { OpeningStage } from "./stages.js"
import { ReturnToLatest } from "./return-to-latest.js"
import { createBlockDisclosure } from "./block-disclosure.js"
import { captureReaderAnchor, createBlockLanding, createOlderPageScroll, createReadingRestore, firstVisibleReaderAnchor, followTranscriptLayout, nextReaderMode, settleReaderExpansionMutation, type PendingRestore, type ReaderAnchorRect, type ReaderDisclosureIntent, type ReaderEvent, type ReaderMode } from "./transcript-scroll.js"
import { bindSelectionGrips } from "./selection-grips.js"
import "../styles/transcript.css"
import "../styles/selection-grips.css"
import { createTranscriptTiming, TranscriptClock } from "./row-time.js"
import { bindTranscriptTimeReveal } from "./transcript-time-reveal.js"
import { ActivityStatus } from "./activity-status.js"

/** How many older pages a restore reads back to find the row the reader was
 *  on before it settles for the tail. */
const RESTORE_PAGE_LIMIT = 10

/** The window the transcript shows: its blocks, the absolute index of the
 *  first, and whether older history exists before it. */
interface PresentedWindow {
  readonly blocks: ClientViewState["blocks"]
  readonly start: number | null
  readonly hasBefore: boolean
}

/** A rendered row with its measured place in the viewport. */
interface RenderedRow extends ReaderAnchorRect {
  readonly element: HTMLElement
}

/** The id a body query takes, which is the block id rather than its identity. */
const blockBodyId = (block: FrontendOutputBlock): string => block.kind === "question" ? block.toolUseId : block.id

/** The transcript: a resident window over the session's blocks, following the
 *  live tail until the reader scrolls away from it.
 *
 *  It renders what the reconciler settled and sends back what the reader does.
 *  Ordering, recovery, and paging live in the transcript store; this owns only
 *  the scroll position and the disclosure state of its rows. */

/** `onOpenWorkflowAgent` opens the agent view of the workflow `sessionId`
 *  that a card's agent line names, over this chat. */
export function Transcript(props: { readonly phoneSelection?: boolean } = {}) {
  const client = useClient()
  const state = client.state
  const roleAssignments = untrack(() => ({
    get: state().roleAssignments,
    subscribe: state().subscribeRoleAssignments,
  }))
  // The workflow cards of this transcript follow their workflows through
  // the session, and a person's choices on each card outlive its rows as
  // the transcript scrolls.
  const extensions = useClientExtensions()
  /** An older page is on its way, so a tap on the control answers at once. */
  const loadingOlder = () => client.actions.working(actionKey("load-older", state().sessionId))
  // A card's child status arrives through its subscription, which answers
  // the known reading at once.
  const statuses = untrack(() => ({
    get: () => undefined,
    subscribe: state().subscribeStatus,
  }))
  const disclosure = createBlockDisclosure()
  // One shared fold decides the rows, the dividers, and which blocks render
  // nowhere; this client only presents each stretch of tool work as a counted
  // group. Thinking is a transcript setting the runtime holds: the durable
  // record keeps the blocks, the fold shows them only when asked to.
  // The window this transcript shows. Restoring, anchoring, paging, and the
  // saved reading place all read this one snapshot, never a newer store frame
  // that has not reached the screen.
  const [shown, setShown] = createSignal<PresentedWindow>({ blocks: [], start: null, hasBefore: false }, {
    equals: (a, b) => a.blocks === b.blocks && a.start === b.start && a.hasBefore === b.hasBefore,
  })
  const blocks = createMemo(() => shown().blocks)
  const hasBefore = createMemo(() => shown().hasBefore)
  const [showThinking, setShowThinking] = createSignal(false)
  const [sessionId, setSessionId] = createSignal("")
  const [location, setLocation] = createSignal({ projectRoot: "", executionCwd: "" }, { equals: (a, b) => a.projectRoot === b.projectRoot && a.executionCwd === b.executionCwd })
  const [atRest, setAtRest] = createSignal(false)
  const [tailCanGrow, setTailCanGrow] = createSignal(false)
  const [clockRunning, setClockRunning] = createSignal(false)
  const [processStatus, setProcessStatus] = createSignal<ClientViewState["processStatus"]>()
  const timing = createTranscriptTiming(clockRunning)
  const presentation = createMemo(() => {
    const memory = client.residents.memory(sessionId())
    if (memory === undefined) return undefined
    memory.presentation ??= { transcript: createWebTranscript(), turnFolds: createTurnFolds() }
    return memory.presentation
  })
  const unfoldedView = createMemo(() => presentation()?.transcript(blocks(), showThinking()) ?? { rows: [], boundaryBefore: [] })
  const view = createMemo(() => {
    const session = sessionId()
    return presentation()?.turnFolds(unfoldedView(), atRest(), (id) => {
      const fold = disclosure.state(session, id)()
      return fold.chosen ? fold.open : undefined
    }) ?? unfoldedView()
  })
  const rows = () => view().rows
  const answerTurns = createMemo(() => new Map(rows().flatMap(row => row.kind === "turnFold" ? [[row.answerId, row] as const] : [])))
  // The rows read their inputs from these signals, not from the frame. The
  // frame is one signal rebuilt on every publish, and a turn publishes many
  // times a second, so every row that read it re-ran on every token of a block
  // it does not render. A memo over the frame would not do either: Solid marks
  // everything downstream of a memo on each publish of its source and then
  // walks it all back to find nothing changed, which with hundreds of rows is
  // a frame's worth of bookkeeping. A signal written with an equal value
  // notifies nobody, so a publish reaches only the rows whose input changed.
  const [bodies, setBodies] = createSignal<ClientViewState["bodies"]>({})
  const turnMetadata = createTurnMutationMetadata(
    () => [...answerTurns().values()].flatMap(turnCalls),
    () => client.actions.mutationEvidence,
    bodies,
  )
  const [groups, setGroups] = createSignal<ClientViewState["groups"]>({})
  const [streamingToolText, setStreamingToolText] = createSignal<ClientViewState["streamingToolText"]>({})
  const [visibleMessageCount, setVisibleMessageCount] = createSignal(0)
  const presentFrame = (frame: ClientViewState, window: PresentedWindow) => batch(() => {
    setShown(window)
    setShowThinking(frame.settings?.showThinking === true)
    setSessionId(frame.sessionId ?? "")
    setLocation({ projectRoot: frame.projectRoot ?? "", executionCwd: frame.executionCwd ?? "" })
    setBodies(frame.bodies)
    setGroups(frame.groups)
    setStreamingToolText(frame.streamingToolText)
    setProcessStatus(frame.processStatus)
    setVisibleMessageCount(frame.visibleMessageCount)
    const settled = frame.settledOutputPosition
    const settlementPending = frame.atTail && settled !== null
      && (typeof settled === "object" || frame.appliedOutputPosition === null || frame.appliedOutputPosition < settled)
    const rest = frame.activity !== undefined && !isActiveActivity(frame.activity) && !frame.interruptible && !settlementPending
    setAtRest(rest)
    setTailCanGrow(frame.atTail && !rest)
    const runningIds = runningTimeIds(window.blocks, frame.groups, frame.processStatus, frame.atTail && isActiveActivity(frame.activity))
    timing.publish(blockEndTimes(window.blocks), runningIds)
    setClockRunning(runningIds.size > 0 || isActiveActivity(frame.activity) || frame.interruptible)
  })
  // An older page that lands while iOS scrolls the transcript, by a finger,
  // by momentum, or by the bounce past its top, cannot be held in place: the
  // scrolling owns the position and paints its next frame over the
  // compensating scroll, so the reader sees the oldest rows for a frame. The
  // rows such a page prepends wait for an animation frame that no scroll event
  // and no touch preceded, and land inside it, so the rows and the
  // compensation paint together. The rows already on screen keep updating
  // while they wait.
  let scroller: HTMLDivElement | undefined
  let touching = false
  let scrolled = false
  let settling: number | undefined
  const wholeWindow = (frame: ClientViewState): PresentedWindow => ({ blocks: frame.blocks, start: frame.startBlockIndex, hasBefore: frame.hasBefore })
  const landWhenStill = () => {
    scrolled = false
    settling = requestAnimationFrame(() => {
      settling = undefined
      if (touching || scrolled || (scroller?.scrollTop ?? 0) < 0) landWhenStill()
      else {
        const frame = untrack(state)
        presentFrame(frame, wholeWindow(frame))
      }
    })
  }
  /** The window a store frame shows now: all of it, or without the rows an
   *  older page prepends while those wait for a still frame. */
  const admit = (frame: ClientViewState): PresentedWindow => {
    const whole = wholeWindow(frame)
    const current = untrack(shown)
    // A rebase changes coordinates, not the identity of the held edge.
    const first = current.blocks[0]
    const offset = first === undefined ? -1 : frame.blocks.findIndex(block => blockIdentity(block) === blockIdentity(first))
    if (frame.sessionId !== untrack(sessionId) || scroller === undefined || whole.start === null || offset <= 0) {
      if (settling !== undefined) cancelAnimationFrame(settling)
      settling = undefined
      return whole
    }
    if (settling === undefined) landWhenStill()
    return { blocks: frame.blocks.slice(offset), start: whole.start + offset, hasBefore: true }
  }
  createComputed(on(state, (frame) => presentFrame(frame, admit(frame))))
  onCleanup(() => { if (settling !== undefined) cancelAnimationFrame(settling) })
  createEffect(() => {
    if (props.phoneSelection && scroller) onCleanup(bindSelectionGrips(scroller))
  })
  onMount(() => {
    if (!scroller) return
    const target = scroller
    onCleanup(bindTranscriptTimeReveal(target))
    const touch = (event: TouchEvent) => { touching = event.touches.length > 0 }
    for (const type of ["touchstart", "touchend", "touchcancel"] as const) {
      target.addEventListener(type, touch, { passive: true })
      onCleanup(() => target.removeEventListener(type, touch))
    }
  })
  let content!: HTMLDivElement
  const [messageBaseline, setMessageBaseline] = createSignal(0)
  const unseenMessages = createMemo(() => unseenMessageCount(messageBaseline(), visibleMessageCount()).unseen)
  // Within a few lines of the bottom counts as on the tail, so a settling
  // layout does not read as the reader having left.
  const nearTail = () => scroller !== undefined && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40

  // The place a reload onto a new client build left, restored once when its
  // session opens and dropped the moment another session opens instead, and
  // the place a return to a resident session restores the same way. A reader
  // who was following the tail needs nothing restored. A return also knows
  // how many messages the reader had seen, so only what arrived since counts
  // as new; a reload counts nothing as new.
  /** Scrolls the row that holds the saved index back to its saved offset once
   *  it is in the document and the fonts have landed, reading older pages back
   *  while the index lies before the resident window. A place that never
   *  becomes resident leaves the reader at the tail. */
  const restoreTo = (place: ReadingState, top: NonNullable<ReadingState["top"]>, seenMessages?: number): PendingRestore => {
    const pending: PendingRestore = {
      place,
      ...(seenMessages === undefined ? {} : { seenMessages }),
      pager: createReadingRestore({
        pages: RESTORE_PAGE_LIMIT,
        window: () => {
          const window = untrack(shown)
          return window.blocks.length === 0 ? undefined : window
        },
        land: (window) => {
          const rowId = rowAtIndex(untrack(rows), window.blocks, window.start, top.index)
          if (rowId === undefined) return "before"
          const row = scroller?.querySelector<HTMLElement>(`.row[data-block="${CSS.escape(rowId)}"]`)
          if (!scroller || !row) return "pending"
          dispatch({ kind: "restoreLanded" })
          // Everything resident was on screen before a reload; none of it is
          // new to the reader.
          setMessageBaseline(pending.seenMessages ?? untrack(visibleMessageCount))
          scroller.scrollTo({ top: restoredScrollTop({ scrollTop: scroller.scrollTop, rowTop: row.getBoundingClientRect().top, viewportTop: scroller.getBoundingClientRect().top, offset: top.offset }), behavior: "instant" })
          // A frame can change the layout before the landing's scroll event
          // arrives, such as a turn folding as the session reaches rest.
          rememberReaderAnchor()
          return "landed"
        },
        loadOlder: client.actions.loadOlder,
        retry: () => { void fontsReady.then(attemptRestore) },
        settleAtTail: () => {
          dispatch({ kind: "restoreSettledAtTail" })
          scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "instant" })
        },
      }),
    }
    return pending
  }
  // Following the tail is the default, but only until the reader scrolls away
  // from it. Yanking someone back to the bottom mid-read is the thing that
  // makes a streaming transcript unusable. It is a signal because the view
  // shows a way back whenever it is off: a button that appears only away from
  // the tail, and whose tap both scrolls there and re-arms following, so the
  // reader never has to find the exact bottom by feel to make new output
  // scroll the page again.
  const [mode, setMode] = createSignal<ReaderMode>((() => {
    const place = client.readingPlace.restored
    return place === undefined || place.following || place.top === undefined ? { kind: "following" } : { kind: "restoring", restore: restoreTo(place, place.top) }
  })())
  const following = createMemo(() => mode().kind === "following")
  /** The one writer of the reader mode. Entering or leaving following counts
   *  every message on screen as seen. */
  const dispatch = (event: ReaderEvent): void => {
    const previous = untrack(mode)
    const next = nextReaderMode(previous, event)
    if (next.kind === "following" || previous.kind === "following") setMessageBaseline(untrack(visibleMessageCount))
    if (next !== previous) setMode(next)
  }
  const restoredOpen = client.readingPlace.restored
  if (restoredOpen !== undefined) {
    for (const key of restoredOpen.open) disclosure.setOpen(restoredOpen.sessionId, key, true)
    for (const key of restoredOpen.closed ?? []) disclosure.setOpen(restoredOpen.sessionId, key, false)
  }
  const fontsReady = typeof document === "undefined" || document.fonts === undefined ? Promise.resolve() : document.fonts.ready.then(() => {})
  const attemptRestore = (): void => {
    const current = untrack(mode)
    if (current.kind !== "restoring" || !scroller || untrack(sessionId) !== current.restore.place.sessionId) return
    current.restore.pager.attempt()
  }
  /** Where the reader is now: the top visible row by the absolute index of
   *  its first block, whether they follow the tail, and the rows they opened.
   *  A reload saves it, and so does a move to another session. */
  const readPlace = (): ReadingState | undefined => {
    const current = untrack(sessionId)
    if (!scroller || current === "") return undefined
    const viewportTop = scroller.getBoundingClientRect().top
    const anchor = firstVisibleReaderAnchor(renderedRows(), viewportTop)
    const window = untrack(shown)
    const index = anchor === undefined ? undefined : rowIndex(untrack(rows), window.blocks, window.start, anchor.id)
    const { open, closed } = disclosure.choices(current)
    return {
      sessionId: current,
      following: untrack(following),
      ...(anchor === undefined || index === undefined ? {} : { top: { index, offset: anchor.top - viewportTop } }),
      open,
      ...(closed.length === 0 ? {} : { closed }),
    }
  }
  onMount(() => {
    onCleanup(client.readingPlace.track(readPlace))
    // The session tells the pane just before it moves, while the rows on
    // screen are still the ones being left.
    onCleanup(client.residents.onLeave((left, memory) => {
      const reading = readPlace()
      if (reading?.sessionId !== left) return
      memory.place = { reading, seenMessages: untrack(following) ? untrack(visibleMessageCount) : untrack(messageBaseline) }
    }))
  })

  // A different transcript starts at its own tail, following again.
  let renderedSession: string | undefined
  createEffect(() => {
    const current = sessionId()
    const currentBlocks = blocks()
    const count = visibleMessageCount()
    if (current !== renderedSession) {
      renderedSession = current
      readerAnchor = undefined
      setMessageBaseline(count)
      const previous = untrack(mode)
      // A reload's restore waits for its own session; an unknown session is not yet another one.
      const waiting = previous.kind === "restoring" && (current === "" || current === previous.restore.place.sessionId)
      if (!waiting) {
        const kept = current === "" ? undefined : untrack(() => client.residents.memory(current))
        const place = kept?.place
        if (kept !== undefined) kept.place = undefined
        if (place !== undefined && !place.reading.following && place.reading.top !== undefined) {
          dispatch({ kind: "restoreStarted", restore: restoreTo(place.reading, place.reading.top, place.seenMessages) })
          setMessageBaseline(place.seenMessages)
        } else dispatch({ kind: "sessionOpened" })
      }
      if (untrack(mode).kind === "restoring") {
        // The saved row, not the tail, is where this transcript opens.
        void fontsReady.then(attemptRestore)
        return
      }
      // Growth after this is the observer's to pin; only the switch itself
      // scrolls here, so a publish can never yank a reader who has just
      // begun to scroll away.
      if (currentBlocks.length > 0) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "instant" }))
    } else if (untrack(following)) {
      setMessageBaseline(count)
    } else {
      const baseline = untrack(messageBaseline)
      const rebased = unseenMessageCount(baseline, count).baseline
      if (rebased !== baseline) setMessageBaseline(rebased)
    }
  })

  // A tail pin computed after paint lands one frame late: content growing at
  // the pinned bottom (a row auto-opening as its result lands) paints pushed
  // down, then pops back when the next scroll lands. The observer runs after
  // the DOM change and before paint, and pins instantly so the smooth
  // behaviour cannot turn the correction into a visible slide.
  //
  // Growth the reader asked for is different. Opening a row is a reading
  // gesture: the tapped row must stay under the finger and the transcript
  // below it makes room. An incomplete row keeps following off while its
  // requested content lands, rather than pinning that later mutation as live
  // output. A complete disclosure reads following from its settled position.
  // The capture listener runs before the row toggles and so before the observer
  // sees the change.
  let readerDisclosure: ReaderDisclosureIntent | undefined
  let expansionPending = false
  let readerAnchor: ReturnType<typeof captureReaderAnchor> | undefined
  /** The rendered rows in document order.
   *  @yields {RenderedRow} Each row, measured only as it is read. */
  function* renderedRows(): Generator<RenderedRow> {
    for (const element of scroller?.querySelectorAll<HTMLElement>(".row[data-block]") ?? []) {
      const id = element.dataset.block
      if (id === undefined) continue
      const rect = element.getBoundingClientRect()
      yield { id, top: rect.top, bottom: rect.bottom, element }
    }
  }
  /** The first row that reaches into the viewport, the row the reader is on. */
  const readerRow = (): RenderedRow | undefined => scroller === undefined ? undefined : firstVisibleReaderAnchor(renderedRows(), scroller.getBoundingClientRect().top)
  const publishReader = () => {
    const id = untrack(sessionId)
    const memory = client.residents.memory(id)
    if (!memory || !scroller) return
    const viewport = scroller.getBoundingClientRect()
    const visible = new Set<string>()
    for (const row of renderedRows()) {
      if (row.top >= viewport.bottom) break
      if (row.bottom > viewport.top) visible.add(row.id)
    }
    memory.reader = {
      following: untrack(following),
      blockIds: untrack(rows).filter((row) => visible.has(rowIdentity(row))).flatMap(rowBlockIdentities),
    }
  }
  createEffect(() => { following(); shown(); untrack(publishReader) })
  /** Keeps the reader's row in place through the next layout change. `reader`
   *  answers that row, so a scroll event measures it once for every owner. */
  const rememberReaderAnchor = (reader: () => RenderedRow | undefined = readerRow) => {
    if (expansionPending || !scroller) return
    readerAnchor = undefined
    if (untrack(following)) return
    const control = reader()
    if (control === undefined) return
    const window = untrack(shown)
    const index = rowIndex(untrack(rows), window.blocks, window.start, control.id)
    const block = index === undefined || window.start === null ? undefined : window.blocks[index - window.start]
    const blockId = block === undefined ? undefined : blockIdentity(block)
    // Settling replaces hidden work with its fold line. Keep the same
    // block's new holder at the reader's previous position.
    const holder = () => {
      if (control.element.isConnected || blockId === undefined) return control.element
      const id = rowHolding(untrack(rows), blockId)
      return id === undefined ? undefined : scroller?.querySelector<HTMLElement>(`.row[data-block="${CSS.escape(id)}"]`)
    }
    readerAnchor = captureReaderAnchor(scroller, {
      get isConnected() { return holder()?.isConnected ?? false },
      getBoundingClientRect: () => holder()?.getBoundingClientRect() ?? control,
    })
  }
  const olderPageScroll = createOlderPageScroll({
    viewport: {
      get scrollTop() { return scroller?.scrollTop ?? 0 },
      top: () => scroller?.getBoundingClientRect().top ?? 0,
      rows: renderedRows,
      scrollTo: (top) => scroller?.scrollTo({ top, behavior: "instant" }),
    },
    sessionId: () => untrack(sessionId),
    // The blocks on screen, which a held page has not reached yet.
    blockIds: () => untrack(blocks).map(blockIdentity),
    loadOlder: client.actions.loadOlder,
  })
  onMount(() => {
    if (!scroller) return
    const target = scroller
    const observer = new MutationObserver(() => {
      if (landing.reconcile()) return
      if (untrack(mode).kind === "restoring") {
        void fontsReady.then(attemptRestore)
        return
      }
      if (olderPageScroll.reconcile()) readerAnchor?.rebase()
      else readerAnchor?.reconcile()
      const mutation = settleReaderExpansionMutation(
        { pending: expansionPending, following: untrack(following) },
        readerDisclosure,
        target.querySelector('[aria-expanded="true"][data-expansion-pending]') !== null,
        nearTail(),
      )
      expansionPending = mutation.pending
      readerDisclosure = undefined
      if (mutation.consumed) {
        dispatch({ kind: "expansionSettled", following: mutation.following })
        rememberReaderAnchor()
        return
      }
      if (untrack(following)) target.scrollTo({ top: target.scrollHeight, behavior: "instant" })
      rememberReaderAnchor()
    })
    observer.observe(target, { attributes: true, attributeFilter: ["aria-expanded", "data-expansion-pending"], childList: true, subtree: true, characterData: true })
    onCleanup(followTranscriptLayout(target, content, () => !expansionPending && untrack(following), () => readerAnchor?.reconcile()))
    const noteDisclosure = (event: Event) => {
      if (!(event.target instanceof Element)) return
      const control = event.target.closest<HTMLElement>("[aria-expanded]")
      if (control === null) return
      if (control.getAttribute("aria-expanded") === "true") {
        readerDisclosure = { action: "close" }
        readerAnchor = undefined
        return
      }
      const pending = Object.hasOwn(control.dataset, "expansionPending")
      readerDisclosure = { action: "open", pending }
      if (pending) readerAnchor = captureReaderAnchor(target, control)
    }
    target.addEventListener("click", noteDisclosure, { capture: true })
    onCleanup(() => {
      observer.disconnect()
      target.removeEventListener("click", noteDisclosure, { capture: true })
    })
  })

  // Only the reader moving up releases following. A gap that opened without
  // the position moving up is growth the pin has not caught yet: on iOS a
  // programmatic scroll is applied only once the finger lifts, so a thumb
  // resting on the screen while a reply streams leaves the view behind the
  // tail and then reports that position; reading that as the reader having
  // left would strand them at the top of the reply. A shrink that clamped
  // the position lands on the tail and counts as being there.
  let lastScrollTop = 0
  const onScroll = () => {
    if (!scroller) return
    scrolled = true
    const top = scroller.scrollTop
    dispatch({ kind: "scrolled", expansionPending, nearTail: nearTail(), upward: top < lastScrollTop - 2 })
    lastScrollTop = top
    publishReader()
    let measured: { readonly row: RenderedRow | undefined } | undefined
    const reader = () => (measured ??= { row: readerRow() }).row
    rememberReaderAnchor(reader)
    // Paging back is a reading gesture, so it needs the reader to have left the
    // tail: a pin's own scroll event near the top of a short window must not
    // page history in until the window drops the live end.
    olderPageScroll.onScroll(!untrack(following) && top < 80 && untrack(hasBefore), reader)
  }

  /** The one way back to the tail. It re-arms following first, so the pin
   *  holds through whatever lands next, then asks the transcript owner for
   *  its latest window. The local scroll makes the response immediate while
   *  that read brings a detached window back to the live end. */
  const jumpToLatest = () => {
    expansionPending = false
    readerAnchor = undefined
    dispatch({ kind: "jumpedToLatest" })
    client.actions.jumpToLatest()
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "instant" })
  }
  let handledAttention = 0
  createEffect(on(() => [client.attention?.(), sessionId()] as const, ([attention, selected]) => {
    if (attention?.sessionId !== selected || attention.sequence === handledAttention) return
    handledAttention = attention.sequence
    jumpToLatest()
  }))

  /** A message image took its size: the tail stays pinned, or the reader's
   *  place stays where it was. */
  const followImage = (): void => {
    if (untrack(following)) scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "instant" })
    else readerAnchor?.reconcile()
    rememberReaderAnchor()
  }

  /** One block with its fetched body, live text, and fetched children. Runs
   *  render their calls through this too, so a call inside a run is the same
   *  row it would be on its own. */
  const blockProps = (block: Accessor<FrontendOutputBlock>, inlineTime = false): Omit<BlockProps, "block"> => {
    const body = createMemo(() => bodies()[blockBodyId(block())])
    const group = createMemo(() => groups()[blockBodyId(block())])
    const streaming = createMemo(() => streamingToolText()[blockBodyId(block())])
    const initialMessageLabel = () => {
      const current = block()
      const first = blocks()[0]
      if (current.kind !== "userMessage" || first?.kind !== "userMessage" || shown().start !== 0 || first.id !== current.id) return undefined
      return extensions.map(extension => extension.initialMessageLabel?.(current)).find(label => label !== undefined)
    }
    return {
        inlineTime,
        get processStatus() { return processStatus() },
        get sessionId() { return sessionId() },
        disclosure,
        get initialMessageLabel() { return initialMessageLabel() },
        get body() { return body() },
        get mutationEvidence() { return state().sessionId === sessionId() ? client.actions.mutationEvidence : undefined },
        canOpenFiles: client.actions.canOpenFiles,
        onOpenFile: (path, asDiff) => client.actions.openFile(path, asDiff),
        onHydrate: (blockId) => client.actions.hydrateBody(blockId),
        onImageLoad: followImage,
        onTerminateBackground: (toolUseId) => client.actions.terminateBackground(toolUseId),
        onDetachBash: (toolUseId) => client.actions.detachBash(toolUseId),
        working: client.actions.working,
        onHydrateGroup: (groupBlockId) => client.actions.hydrateGroup(groupBlockId),
        onSelectSession: (target, label) => {
          // The link sits in this transcript, so this session is the parent
          // Back returns to while the child loads.
          const link = { label, parentSessionId: state().sessionId }
          if (client.stack) client.stack.openChat(target, link)
          else client.actions.selectSession(target, link)
        },
        roleAssignments,
        statuses,
        get group() { return group() },
        get streaming() { return streaming() },
        get writeSyntaxTheme() { return state().settings?.writeSyntaxTheme ?? DEFAULT_WRITE_SYNTAX_THEME_ID },
    }
  }
  const blockRow = (block: Accessor<PresentedWebBlock>, inlineTime = false) => createComponent(Block, mergeProps(blockProps(block, inlineTime), { get block() { return block() } }))
  const toolPresentation: Parameters<typeof ToolGroupBlock>[0]["presentation"] = (entry, key) => {
    const inputs = blockProps(entry)
    return createToolPresentation(mergeProps(inputs, {
      get entry() { return entry() },
      get disclosureId() { return key() },
    }))
  }

  /** Try again on a failed destination: the same tap that led there. */
  const retryOpening = () => {
    const destination = state().sessionId
    if (destination === undefined) client.actions.newSession()
    else client.actions.selectSession(destination, { label: state().destinationName, parentSessionId: state().parentSessionId })
  }

  // The block a search hit or a background row landed on: the row that holds
  // it scrolls to the middle of the pane once it is in the document, and the
  // mark stays until the next landing. The window that brings the block paints
  // after the landing resolves, so the observer lands it after that render.
  const landing = createBlockLanding({
    rows: () => untrack(rows),
    reveal: row => {
      if (row.kind === "turnFold" && !row.open) disclosure.setOpen(untrack(sessionId), row.id, true)
    },
    center: (rowId) => {
      const row = scroller?.querySelector<HTMLElement>(`.row[data-block="${CSS.escape(rowId)}"]`)
      if (!row) return false
      // The reader asked for this place, so neither a pending restore nor the
      // tail pin may move them off it.
      dispatch({ kind: "blockLanded" })
      row.scrollIntoView({ block: "center", behavior: "instant" })
      rememberReaderAnchor()
      return true
    },
  })
  createEffect(on(client.markedBlock, blockId => landing.land(blockId), { defer: true }))
  const markedRow = createMemo(() => {
    const blockId = client.markedBlock()
    return blockId === undefined ? undefined : rowHolding(rows(), blockId)
  })

  return (
    <TranscriptClock.Provider value={{ now: timing.now, end: timing.end, running: timing.running }}>
    <div class="transcript-shell">
      <div class="transcript" ref={(el) => (scroller = el)} onScroll={onScroll} inert={state().opening !== undefined}>
        <div class="transcript-content" ref={(el) => (content = el)}>
          <Show when={hasBefore() && blocks().length > 0}>
            <button class="load-older" aria-busy={loadingOlder() || undefined} onClick={olderPageScroll.load}>{loadingOlder() ? "Loading earlier messages…" : "Load earlier messages"}</button>
          </Show>

          <Show when={state().status === "unavailable"}>
            <div class="block system error">{state().unavailable}</div>
          </Show>

          <Show when={state().blocks.length === 0 && state().localSubmissions.length === 0 && state().opening === undefined && state().status !== "loading"}>
            <IntroCard />
          </Show>

          {/* Keyed by the block's own identity, not by reference. A block object
              can be replaced by an equal one on any delta, so a reference-keyed
              list would dispose and rebuild every row: an expanded tool would
              collapse itself on the next token, and dragging to select text
              would be impossible while a turn streams. */}
          <Key each={rows()} by={rowIdentity}>
            {(row, index) => {
              // A row's kind is fixed by its key, so each branch below mounts
              // once for the row's life and never flips.
              const run = () => {
                const current = row()
                return current.kind === "toolGroup" ? current : undefined
              }
              const block = () => {
                const current = row()
                return current.kind === "toolGroup" || current.kind === "turnFold" ? undefined : current
              }
              const turn = () => {
                const current = row()
                return current.kind === "turnFold" ? current : undefined
              }
              const identity = () => rowIdentity(row())
              return (
                <>
                  <Show when={view().boundaryBefore[index()] === true}>
                    <div class="work-divider" />
                  </Show>
                  <div class="row" data-block={identity()} classList={{ found: markedRow() === identity() }}>
                    <Show when={turn()}>{(fold) => (
                      <TurnFoldBlock fold={fold()} metadata={turnMetadata()} onToggle={() => disclosure.setOpen(sessionId(), fold().id, !fold().open)} />
                    )}</Show>
                    <Show when={run()} fallback={<Show when={block()}>{(settled) => blockRow(settled)}</Show>}>
                      {(settled) => <ToolGroupBlock group={settled()} tailCanGrow={tailCanGrow()} sessionId={sessionId()} disclosure={disclosure} processStatus={processStatus()} row={blockRow} presentation={toolPresentation} onOpenFile={client.actions.canOpenFiles ? (path) => client.actions.openFile(path) : undefined} />}
                    </Show>
                  </div>
                  <Show when={answerTurns().get(identity())}>{fold => <TurnChanges fold={fold()} sessionId={sessionId()} disclosure={disclosure} bodies={bodies()} onHydrate={client.actions.hydrateBody} projectRoot={location().projectRoot} executionCwd={location().executionCwd} evidenceReader={client.actions.mutationEvidence} metadata={turnMetadata()} />}</Show>
                </>
              )
            }}
          </Key>

          {/* What this client sent and the runtime has not shown back yet, in
              place at the end. The runtime's own message replaces each one.
              Keyed by identity, so a change of delivery redraws the row in
              place rather than building it again. */}
          <Key each={state().localSubmissions} by={(entry) => entry.id}>
            {(entry) => (
              <div class="row">
                <LocalUserMessage entry={entry()} onEdit={() => client.recallLocal(entry().id)} onImageLoad={followImage} sessionId={sessionId()} disclosure={disclosure} />
              </div>
            )}
          </Key>

          <Show when={state().sessionId} keyed>
            {(_selectedSessionId) => (
              <ActivityStatus
                activity={state().activity}
                transcriptAvailable={state().transcriptAvailable}
                atTail={state().atTail}
                settledOutputPosition={state().settledOutputPosition}
                appliedOutputPosition={state().appliedOutputPosition}
                waitingOn={state().waitingOn}
                startedAt={state().activityStartedAt}
              />
            )}
          </Show>
          <div class="transcript-clearance" aria-hidden="true" />
        </div>
      </div>

      {/* The destination a tap moved to, over whatever this pane still holds,
          until the destination can show: the previous session never stays on
          screen after a tap that left it. */}
      <Show when={state().opening}>
        {(opening) => (
          <div class="transcript-opening">
            <OpeningStage name={state().destinationName} failure={opening().failure} onRetry={retryOpening} />
          </div>
        )}
      </Show>

      {/* Away from the tail, whether the reader scrolled up or paged far
          enough back to detach the window from the live end, one control
          shows the way back. Its absence is the reading that the transcript
          is following. */}
      <Show when={(!following() || !state().atTail) && state().blocks.length > 0 && state().opening === undefined}>
        <ReturnToLatest unseen={unseenMessages()} onClick={jumpToLatest} />
      </Show>
    </div>
    </TranscriptClock.Provider>
  )
}
