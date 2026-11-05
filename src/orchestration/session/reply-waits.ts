import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { BackgroundWorkRegistry, BackgroundWorkResult } from "../agent-runtime/background-work.js"
import type { WorkReference } from "../agent-runtime/background-work-progress.js"
import { escapeXml, formatRuntimeNotification } from "../agent-runtime/runtime-notifications.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "./conversation/queued-background-notifications.js"
import { readUnreadSessionMessages } from "./conversation/addressed-workflow-messages.js"
import { dropReplyWait, holdReplyWait, isReplyWaitNoticeKey, readReplyWaits, REPLY_WAIT_IN_FLIGHT_KIND, replyWaitCellsOf, replyWaitNoticeKey, type ReplyWaitCell } from "./conversation/reply-wait-cells.js"
import { liveSessionControl, liveWorkflowControl, onLiveSessionRemoved, onLiveWorkChanged, type RecipientState } from "./live-session-control.js"
import { sessionDisplayName, type ReplayedSession } from "./schemas.js"
import type { ReplyWaitView } from "../../protocol/status-protocol-types.js"
import type { PausedBy } from "../../infra/output-blocks.js"

const log = Log.create({ service: "reply-waits" })

/** An interrupted recipient also names the actor from its durable turn end. */
export type ReplyWaitRecipientState = RecipientState | { readonly state: "interrupted"; readonly by: PausedBy }

/** What the waits of one project read and write. */
export interface ReplyWaitDeps {
  /** The project's event reader, which also keys the live-session registry. */
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  /** The state a message to `sessionId` would meet now. */
  addresseeState(sessionId: string): Promise<ReplyWaitRecipientState>
  /** `sessionId` and the sessions above it, its parent first. */
  lineage(sessionId: string): Promise<readonly string[]>
}

/** The background work of a session's run. It holds each wait of the
 *  session as a task, and its live work tells what can wake a park of the
 *  session. */
export type ReplyWaitTasks = Pick<BackgroundWorkRegistry, "track" | "liveWorkReferences" | "observeWorkChanges">
type WorkTasks = Pick<ReplyWaitTasks, "liveWorkReferences" | "observeWorkChanges">

/** Why a wait ended. A reply, a stop by the waiter, an interrupt of the
 *  waiter's own child, the withdrawal of a wait whose message was not
 *  delivered, and a newer wait on the same addressee end it without a
 *  notice. A host that closes detaches it and keeps its cell for the next
 *  run. */
type WaitEnd =
  | { readonly kind: "reply" }
  | { readonly kind: "yielded"; readonly lastText?: string }
  | { readonly kind: "unavailable"; readonly state: UnavailableState }
  | { readonly kind: "stopped" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "withdrawn" }
  | { readonly kind: "replaced" }
  | { readonly kind: "detached" }

/** The ends whose cell no input retires: the wait itself drops it. A reply
 *  retires its cell where the reply is held (`endReplyWaitsByMessage`), and
 *  a notice retires it in its own commit. */
const SELF_RETIRING_ENDS: ReadonlySet<WaitEnd["kind"]> = new Set(["stopped", "interrupted", "withdrawn", "replaced"])

/** The states in which no addressee can answer a wait any more. */
const UNAVAILABLE_STATES = ["at_rest", "settled", "deleted", "not_found"] as const satisfies readonly RecipientState[]
type UnavailableState = (typeof UNAVAILABLE_STATES)[number]

/** How the addressee of a wait relates to the waiter. */
type WaitRelation = "parent" | "child" | "other"

/** How `state` ends a wait on an addressee in `relation` to the waiter, or
 *  nothing while the addressee can still answer it (PI-INTERACTION-136).
 *  The wait ends with a notice when nothing runs the addressee
 *  (`at_rest`) or it ended or is gone. It ends with no notice when the
 *  addressee is the waiter's own child and its parent or the runtime
 *  interrupted it. A crash that Resume continues reads the same way
 *  (PI-INTERACTION-137). The parent's own call
 *  says what it did, the parent's background work announces the runtime's
 *  interrupt, and a child that a person interrupted stays that background
 *  work, so its reply wait pauses until Resume (PI-AGENT-025), as an
 *  interrupt of any other addressee or a planned replacement does. Every
 *  wait reads this one rule: as it opens, at each change of its addressee,
 *  and when the next run of the waiter restores it. */
function endOf(recipient: ReplyWaitRecipientState, relation: WaitRelation): WaitEnd | undefined {
  if (typeof recipient !== "string" && recipient.by === "person") return undefined
  const state = typeof recipient === "string" ? recipient : recipient.state
  if (state === "interrupted") return relation === "child" ? { kind: "interrupted" } : undefined
  const unavailable = UNAVAILABLE_STATES.find((candidate) => candidate === state)
  return unavailable ? { kind: "unavailable", state: unavailable } : undefined
}

interface OpenWait {
  readonly waiterSessionId: string
  readonly tasks: ReplyWaitTasks
  readonly addressee: ReplyWaitView
  readonly relation: WaitRelation
  readonly toolUseId: string
  readonly readKey?: string
  /** True while the message of the wait is not yet durable in the
   *  addressee. A yield then is not an answer to it, since the addressee
   *  has not seen it. */
  sending: boolean
  end(end: WaitEnd): void
}

/** The process-local waits of one project. `deps` arrive with the first
 *  wait. */
interface WaitBook {
  deps?: ReplyWaitDeps
  /** Open waits by waiter, then by addressee. */
  readonly waits: Map<string, Map<string, OpenWait>>
  /** The calls whose waits ended in this process, which a restore skips,
   *  and the calls a reply answered while their cells were written. */
  readonly ended: Set<string>
  /** The store whose listeners hear each change of a waiter's open waits. */
  readonly store: AsyncEventStateReadSurface
  /** Set when the project's runtime stops: from then on no wait of this book
   *  ends by a rule, and the next runtime registers each held wait again in
   *  a new book. */
  suspended: boolean
  readonly parks: Map<string, ParkedYield>
  readonly unsubscribe: () => void
}

interface ParkedYield {
  readonly subscriptions: Map<WorkTasks, () => void>
  changed(): void
}

const books = new WeakMap<AsyncEventStateReadSurface, WaitBook>()

/** The listeners of each project, kept apart from its book: a book ends with
 *  its runtime, and a listener hears the waits of the next runtime too. */
const changeListeners = new WeakMap<AsyncEventStateReadSurface, Set<(waiterSessionId: string) => void>>()

function bookOf(store: AsyncEventStateReadSurface): WaitBook {
  const existing = books.get(store)
  if (existing) return existing
  // A session that leaves this process may no longer read: its run
  // settled, or its runner was released.
  const stopRemoval = onLiveSessionRemoved(store, (sessionId) => { observeSessionResumed(store, sessionId); void observeSessionChanged(store, sessionId) })
  const stopWork = onLiveWorkChanged(store, () => { for (const park of book.parks.values()) park.changed() })
  const unsubscribe = () => { stopRemoval(); stopWork() }
  const book: WaitBook = { waits: new Map(), ended: new Set(), parks: new Map(), store, suspended: false, unsubscribe }
  books.set(store, book)
  return book
}

function bookWith(deps: ReplyWaitDeps): WaitBook {
  const book = bookOf(deps.projectionReader)
  book.deps ??= deps
  return book
}

function waitsOn(book: WaitBook, addresseeSessionId: string): OpenWait[] {
  return [...book.waits.values()].flatMap((byAddressee) => {
    const wait = byAddressee.get(addresseeSessionId)
    return wait ? [wait] : []
  })
}

/** Tells the readers of the stored waits (`onReplyWaitsChanged`) that the
 *  stored open waits of `waiterSessionId` changed. */
function tellListeners(store: AsyncEventStateReadSurface, waiterSessionId: string): void {
  for (const listener of changeListeners.get(store) ?? []) listener(waiterSessionId)
}

function tellObservers(book: WaitBook, waiterSessionId: string): void {
  tellListeners(book.store, waiterSessionId)
  for (const park of book.parks.values()) park.changed()
}

const UNAVAILABLE_TEXT = {
  at_rest: "nothing runs it now, and it reads your message only when it runs again",
  settled: "it has ended",
  deleted: "it was deleted",
  not_found: "it was deleted",
} as const satisfies { readonly [State in UnavailableState]: string }

/** The addressee of a wait as its end notice and its end rules read it. */
interface WaitAddressee {
  readonly sessionId: string
  readonly name: string
  readonly relation: WaitRelation
}

/** What a waiter does after its addressee ended a turn without a reply. A
 *  child waits on its parent again when the parent said that it will reply,
 *  because an agent of a workflow has no other way to wait for the answer. A parent
 *  never waits on its child again: the child's message or its completion
 *  notice reaches the parent without a wait. */
function afterNoReply(addressee: WaitAddressee): string {
  return addressee.relation === "parent"
    ? `If it says that it will reply, wait again: call message_session with to "${addressee.sessionId}", wait true, and no text. Otherwise continue on your own judgment.`
    : "Do not wait on it again. If it sends more, its message or its completion notice reaches you without a wait. Continue on your own judgment."
}

function endNotice(addressee: WaitAddressee, end: Extract<WaitEnd, { kind: "yielded" | "unavailable" }>): string {
  const who = `${addressee.name} (session ${addressee.sessionId})`
  if (end.kind === "unavailable") {
    return formatRuntimeNotification({
      tag: "reply_wait_notification",
      handling: `Your wait on ${who} ended: ${UNAVAILABLE_TEXT[end.state]}. Continue on your own judgment, or message it again when it runs.`,
      fields: [["session_id", addressee.sessionId], ["status", "unavailable"]],
    })
  }
  const lastText = end.lastText?.trim()
  return formatRuntimeNotification({
    tag: "reply_wait_notification",
    handling: `${who} ended its turn without a reply to you, so your wait ended. ${lastText ? "Its last words follow." : "It wrote no words at its end."} ${afterNoReply(addressee)}`,
    fields: [["session_id", addressee.sessionId], ["status", "no_reply"]],
    ...(lastText ? { body: `<last_words>\n${escapeXml(lastText)}\n</last_words>` } : {}),
  })
}

interface TrackedWait {
  readonly waiter: { readonly sessionId: string; readonly tasks: ReplyWaitTasks }
  readonly addressee: WaitAddressee
  readonly cell: ReplyWaitCell
}

/** Registers one wait in the waiter's background work and in the book. The
 *  task settles when the wait ends. Its result is its own notice: empty for
 *  a reply, a stop, a withdrawal, or a detach, and otherwise held under the
 *  wait's key, whose commit retires the cell. */
function track(book: WaitBook, deps: ReplyWaitDeps, input: TrackedWait): OpenWait {
  const { waiter, addressee, cell } = input
  // One wait for each addressee: a new one takes the place of an older one.
  book.waits.get(waiter.sessionId)?.get(addressee.sessionId)?.end({ kind: "replaced" })
  const done = Promise.withResolvers<BackgroundWorkResult>()
  let ended = false
  const wait: OpenWait = {
    waiterSessionId: waiter.sessionId,
    tasks: waiter.tasks,
    addressee: { sessionId: addressee.sessionId, name: addressee.name },
    relation: addressee.relation,
    toolUseId: cell.toolUseId,
    ...(cell.readKey ? { readKey: cell.readKey } : {}),
    sending: false,
    end(end) {
      if (ended) return
      ended = true
      const byAddressee = book.waits.get(waiter.sessionId)
      if (byAddressee?.get(addressee.sessionId) === wait) byAddressee.delete(addressee.sessionId)
      if (byAddressee?.size === 0) book.waits.delete(waiter.sessionId)
      // A detached wait stays held, so a later run of the waiter restores it.
      if (end.kind !== "detached") book.ended.add(cell.toolUseId)
      log.info("reply wait ended", {
        waiterSessionId: waiter.sessionId,
        addresseeSessionId: addressee.sessionId,
        end: end.kind,
        ...(end.kind === "unavailable" ? { state: end.state } : {}),
        durationMs: Date.now() - cell.openedAtMs,
      })
      // Observers read the stored waits, so they hear of an end that
      // retires its own cell once the cell is gone. A reply retired the cell
      // before it ended the wait, and a detached wait stays stored. The
      // waiter's run holds the notice of any other end as it takes it, and
      // that hold tells them again (`noteBackgroundNotificationHeld`).
      if (SELF_RETIRING_ENDS.has(end.kind)) {
        void dropReplyWait(deps.eventWriter, waiter.sessionId, cell).catch((error: unknown) => {
          log.warn("an ended reply wait kept its cell; the next run of the waiter restores it and applies the end rules again", { waiterSessionId: waiter.sessionId, end: end.kind, error: errorMessage(error) })
        }).finally(() => { tellObservers(book, waiter.sessionId) })
      } else {
        tellObservers(book, waiter.sessionId)
      }
      const notice = end.kind === "yielded" || end.kind === "unavailable" ? endNotice(addressee, end) : ""
      done.resolve({ status: end.kind === "reply" || notice ? "completed" : "cancelled", content: notice, ...(end.kind === "yielded" ? { runtimeNotice: true as const } : {}) })
    },
  }
  const byAddressee = book.waits.get(waiter.sessionId) ?? new Map<string, OpenWait>()
  book.waits.set(waiter.sessionId, byAddressee)
  byAddressee.set(addressee.sessionId, wait)
  tellObservers(book, waiter.sessionId)
  waiter.tasks.track({
    done: done.promise,
    meta: {
      id: `reply-wait:${cell.toolUseId}`,
      type: "reply_wait",
      description: `Waiting on ${addressee.name}`,
      toolUseId: cell.toolUseId,
      notificationKey: replyWaitNoticeKey(cell),
    },
    // A host that closes ends its work with the runtime source; the wait
    // then stays held for the next run of the waiter. Any other stop is the
    // waiter's own decision.
    kill: { run: (source) => { wait.end(source === "runtime" ? { kind: "detached" } : { kind: "stopped" }) } },
    wait: true,
  })
  return wait
}

/** Applies rule 3 to one wait: it ends when its addressee can no longer
 *  answer it (`endOf`). */
async function endIfUnavailable(book: WaitBook, deps: ReplyWaitDeps, wait: OpenWait): Promise<RecipientState | undefined> {
  const recipient = await deps.addresseeState(wait.addressee.sessionId)
  if (book.suspended) return undefined
  const end = endOf(recipient, wait.relation)
  if (end) wait.end(end)
  return typeof recipient === "string" ? recipient : recipient.state
}

/** Opens a wait of `waiter` on `addressee` (D5). The wait is durable in the
 *  waiter's cell before it counts as background work. */
export async function openReplyWait(deps: ReplyWaitDeps, input: {
  readonly waiter: { readonly sessionId: string; readonly tasks: ReplyWaitTasks }
  readonly addressee: { readonly sessionId: string; readonly name: string }
  readonly toolUseId: string
  readonly readKey?: string
}): Promise<OpeningWait> {
  const book = bookWith(deps)
  const addressee = { ...input.addressee, relation: await relationOf(deps, input.waiter.sessionId, input.addressee.sessionId) }
  const cell: ReplyWaitCell = { addresseeSessionId: input.addressee.sessionId, toolUseId: input.toolUseId, openedAtMs: Date.now(), ...(input.readKey ? { readKey: input.readKey } : {}) }
  await holdReplyWait(deps.eventWriter, input.waiter.sessionId, cell)
  const wait = track(book, deps, { waiter: input.waiter, addressee, cell })
  wait.sending = input.readKey !== undefined
  log.info("reply wait opened", { waiterSessionId: input.waiter.sessionId, addresseeSessionId: input.addressee.sessionId, withText: input.readKey !== undefined })
  // A message from the addressee that came while the cell was written found
  // the cell and retired it, so that message is the reply.
  if (book.ended.has(cell.toolUseId)) wait.end({ kind: "reply" })
  return {
    async accepted() {
      wait.sending = false
      await endIfUnavailable(book, deps, wait)
      return !book.ended.has(cell.toolUseId)
    },
    withdraw: () => { wait.end({ kind: "withdrawn" }) },
  }
}

/** A wait whose message is on its way. The sender opens the wait first, so
 *  a reply that comes at once finds it, and then reports the outcome. */
export interface OpeningWait {
  /** The message, if the wait sends one, is durable in the addressee,
   *  delivered or held until its Resume: from now on a yield after the
   *  addressee read it ends the wait. The end rules then read the
   *  addressee at once (`endOf`), so a wait on the waiter's own
   *  interrupted child closes with no notice, and the sender's call says
   *  that it does not wait. True while the wait holds. */
  accepted(): Promise<boolean>
  /** The addressee will not read the message, so the wait closes with no notice. */
  withdraw(): void
}

/** Registers again each wait that `waiter` holds, before the first request
 *  of a run that starts after a planned replacement, a crash, or an
 *  interrupt. A wait whose reply or end notice already waits in the waiter
 *  stays ended. The end rules then apply at once. */
export async function restoreReplyWaits(deps: ReplyWaitDeps, waiter: { readonly sessionId: string; readonly tasks: ReplyWaitTasks }, nameOf: (sessionId: string) => Promise<string>): Promise<void> {
  const cells = await storedOpenWaits(deps.projectionReader, waiter.sessionId)
  if (cells.length === 0) return
  const book = bookWith(deps)
  const unread = await readUnreadSessionMessages(deps.projectionReader, waiter.sessionId)
  for (const cell of cells) {
    const addresseeSessionId = cell.addresseeSessionId
    if (book.waits.get(waiter.sessionId)?.has(addresseeSessionId) || book.ended.has(cell.toolUseId)) continue
    // A reply that waits ended the wait, and a crash cut the retirement of its cell.
    if (unread.some((message) => message.producer?.kind === "session" && message.producer.sessionId === addresseeSessionId)) {
      await dropReplyWait(deps.eventWriter, waiter.sessionId, cell)
      // Readers of the stored waits hear of the cell this restore retired.
      tellObservers(book, waiter.sessionId)
      continue
    }
    const addressee = { sessionId: addresseeSessionId, name: await nameOf(addresseeSessionId), relation: await relationOf(deps, waiter.sessionId, addresseeSessionId) }
    const wait = track(book, deps, { waiter, addressee, cell })
    log.info("reply wait restored", { waiterSessionId: waiter.sessionId, addresseeSessionId })
    const state = await endIfUnavailable(book, deps, wait)
    // An addressee that read the message and rests now yielded while the
    // waiter did not run, and its words are in its own transcript.
    if ((state === "idle" || state === "between_steps") && cell.readKey && !await holdsUnread(deps, addresseeSessionId, cell.readKey)) wait.end({ kind: "yielded" })
  }
}

async function relationOf(deps: ReplyWaitDeps, waiterSessionId: string, addresseeSessionId: string): Promise<WaitRelation> {
  if ((await deps.lineage(waiterSessionId))[1] === addresseeSessionId) return "parent"
  return (await deps.lineage(addresseeSessionId))[1] === waiterSessionId ? "child" : "other"
}

async function holdsUnread(deps: ReplyWaitDeps, sessionId: string, key: string): Promise<boolean> {
  return (await readUnreadSessionMessages(deps.projectionReader, sessionId)).some((cell) => cell.key === key)
}

/** The waits that `waiterSessionId` stores open, in the order they opened.
 *  A reply and the waiter's own ends retire a cell at the end, so a cell
 *  that stands is open unless the notice of its end waits in the waiter:
 *  that notice retires the cell when it commits. That commit retires the
 *  notice and the cell at once, so both kinds come from one snapshot: cells
 *  and notices read apart can list a wait that has already ended. */
async function storedOpenWaits(reader: AsyncEventStateReadSurface, waiterSessionId: string): Promise<ReplyWaitCell[]> {
  const rows = await reader.readInFlight(waiterSessionId, [REPLY_WAIT_IN_FLIGHT_KIND, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND])
  const notices = new Set(rows.filter((row) => row.kind === QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map((row) => row.key))
  return replyWaitCellsOf(waiterSessionId, rows).filter((cell) => !notices.has(replyWaitNoticeKey(cell))).sort((a, b) => a.openedAtMs - b.openedAtMs)
}

/** The name of `sessionId` as every surface shows it, or its id when its
 *  metadata is gone. */
export async function sessionNameOf(read: (sessionId: string) => Promise<ReplayedSession | null>, sessionId: string): Promise<string> {
  const session = await read(sessionId)
  return session ? sessionDisplayName({ id: sessionId, session }) : sessionId
}

/** The sessions that `waiterSessionId` waits on for a reply, in the order
 *  its waits opened. A status shows them as "Waiting on <name>". They come
 *  from the waits the session stores, the one record of a wait, so a wait
 *  lists from the moment it opens to its end, also while no run holds it,
 *  as between a planned replacement's cut and the successor's restore. */
export async function readReplyWaitViews(reader: AsyncEventStateReadSurface, read: (sessionId: string) => Promise<ReplayedSession | null>, waiterSessionId: string): Promise<OpenReplyWaitView[]> {
  const waits = await storedOpenWaits(reader, waiterSessionId)
  if (waits.length === 0) return []
  const parentSessionId = (await read(waiterSessionId))?.launchedFrom?.parentSessionId
  return await Promise.all(waits.map(async ({ addresseeSessionId, openedAtMs }) => ({ sessionId: addresseeSessionId, name: await sessionNameOf(read, addresseeSessionId), openedAtMs, isParent: addresseeSessionId === parentSessionId })))
}

export interface OpenReplyWaitView extends ReplyWaitView {
  readonly openedAtMs: number
  readonly isParent: boolean
}

/** Publishes addressees without the runtime's timing and relationship inputs. */
export function toReplyWaitViews(waits: readonly OpenReplyWaitView[]): ReplyWaitView[] {
  return waits.map(({ sessionId, name }) => ({ sessionId, name }))
}

/** Rule 1: a message from `senderSessionId` is durable in a cell of
 *  `recipientSessionId`, so each wait that the recipient holds on the sender
 *  ends with no notice, and its cell goes. The message itself wakes the
 *  park. The caller retires the cells before any reader of the recipient can
 *  commit the message, so a crash never leaves the cell of a wait whose
 *  committed reply ended it. A wait whose cell is written later opens after
 *  the message and waits for the next one. */
export async function endReplyWaitsByMessage(store: { readonly reader: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter }, senderSessionId: string, recipientSessionId: string): Promise<void> {
  const answered = (await readReplyWaits(store.reader, recipientSessionId)).filter((cell) => cell.addresseeSessionId === senderSessionId)
  if (answered.length === 0) return
  const book = books.get(store.reader)
  for (const cell of answered) {
    // A wait whose cell this read found but whose task is not yet registered
    // ends as soon as it registers (`openReplyWait`).
    book?.ended.add(cell.toolUseId)
    await dropReplyWait(store.writer, recipientSessionId, cell)
  }
  // The cells go before the wait ends, so an observer that the end tells
  // reads the stored waits without them. Cells that no run here holds, as
  // before a restore, change the stored waits all the same.
  const open = book?.waits.get(recipientSessionId)?.get(senderSessionId)
  if (open && answered.some((cell) => cell.toolUseId === open.toolUseId)) open.end({ kind: "reply" })
  else tellListeners(store.reader, recipientSessionId)
}

/** The run of `waiterSessionId` held a notice under `key`. A reply-wait end
 *  notice that waits in the waiter hides the wait it ends from the stored
 *  open waits (`storedOpenWaits`), so its readers hear of it. The commit of
 *  a held notice retires the cell, which changes nothing they read. */
export function noteBackgroundNotificationHeld(store: AsyncEventStateReadSurface, waiterSessionId: string, key: string): void {
  if (isReplyWaitNoticeKey(key)) tellListeners(store, waiterSessionId)
}

/** A park or the end of a run of a session, as rule 2 reads it. */
export interface SessionYield {
  /** The last assistant text of the turn. */
  readonly lastText?: string
  /** The agent asked to wait inside its turn with a wait call. */
  readonly waitRequested: boolean
}

/** Rule 2: `parked.sessionId` yielded without a reply. Each wait on it ends
 *  with its last words, once it read the message of that wait. A wait with
 *  no text ends at the first yield after it opened. The end of the turn is a
 *  yield. A wait call is a yield when the session also waits for a reply of
 *  its own, because it then starts to wait without a reply. Otherwise a wait
 *  call is a yield to a waiter only when no work of the session can wake it
 *  without that waiter. The run of the waiter, or of a session above the
 *  waiter, cannot end while the wait is open, so it cannot wake the park
 *  first. A wait call on other work is no yield: the turn continues when
 *  that work wakes it, and it can still reply. So each wait ends when its
 *  addressee yields, and a wait that sends a message closes no cycle. */
export async function observeSessionYield(store: AsyncEventStateReadSurface, parked: { readonly sessionId: string; readonly tasks?: ReplyWaitTasks }, yieldInput: SessionYield): Promise<void> {
  const book = books.get(store)
  const deps = book?.deps
  if (!book || !deps || book.suspended) return
  const { sessionId } = parked
  if (!yieldInput.waitRequested) observeSessionResumed(store, sessionId)
  else if (!book.parks.has(sessionId)) {
    let checking = false
    let dirty = false
    const park: ParkedYield = {
      subscriptions: new Map(),
      changed() {
        dirty = true
        if (checking) return
        checking = true
        queueMicrotask(() => {
          void (async () => {
            while (dirty && book.parks.get(sessionId) === park && !book.suspended) {
              dirty = false
              await observeSessionYield(store, parked, yieldInput)
            }
          })().catch((error: unknown) => {
            log.warn("reply wait progress observation failed", { sessionId, error: errorMessage(error) })
          }).finally(() => { checking = false })
        })
      },
    }
    book.parks.set(sessionId, park)
  }
  const observe = (tasks: WorkTasks): void => {
    const park = book.parks.get(sessionId)
    if (park && !park.subscriptions.has(tasks)) park.subscriptions.set(tasks, tasks.observeWorkChanges(park.changed))
  }
  if (parked.tasks) observe(parked.tasks)
  const currentPark = book.parks.get(sessionId)
  const waits = waitsOn(book, sessionId)
  if (waits.length === 0) return
  // Read at the park, before any await: the work that can wake it.
  const work = yieldInput.waitRequested && !book.waits.has(sessionId) ? parked.tasks?.liveWorkReferences() ?? [] : undefined
  const unread = new Set((await readUnreadSessionMessages(deps.projectionReader, sessionId)).map((cell) => cell.key))
  for (const wait of waits) {
    if (wait.sending || (wait.readKey && unread.has(wait.readKey))) continue
    if (work && await wakesWithout(book, deps, work, wait, observe)) continue
    if (yieldInput.waitRequested && book.parks.get(sessionId) !== currentPark) return
    if (book.suspended) return
    wait.end({ kind: "yielded", ...(yieldInput.lastText ? { lastText: yieldInput.lastText } : {}) })
  }
}

/** Clears progress subscriptions when the turn resumes or ends. */
export function observeSessionResumed(store: AsyncEventStateReadSurface, sessionId: string): void {
  const parks = books.get(store)?.parks
  const park = parks?.get(sessionId)
  parks?.delete(sessionId)
  for (const stop of park?.subscriptions.values() ?? []) stop()
}

async function wakesWithout(book: WaitBook, deps: ReplyWaitDeps, work: readonly WorkReference[], waiter: OpenWait, observe: (tasks: WorkTasks) => void): Promise<boolean> {
  const lineage = new Set(await deps.lineage(waiter.waiterSessionId))
  const seen = new Set<string>()
  async function tasksWake(tasks: WorkTasks): Promise<boolean> {
    observe(tasks)
    const waits = [...book.waits.values()].flatMap((byAddressee) => [...byAddressee.values()]).filter((wait) => wait.tasks === tasks)
    return any([
      ...tasks.liveWorkReferences(),
      ...waits.map(({ addressee }): WorkReference => ({ kind: "session", sessionId: addressee.sessionId })),
    ])
  }
  async function wakes(ref: WorkReference): Promise<boolean> {
    if (ref.kind === "command") return true
    const id = ref.kind === "session" ? ref.sessionId : ref.workflowId
    const key = `${ref.kind}:${id}`
    if (seen.has(key)) return false
    seen.add(key)
    const control = ref.kind === "workflow" ? liveWorkflowControl(book.store, id) : liveSessionControl(book.store, id)
    if (ref.kind === "workflow" && control?.workProgress) {
      const progress = await control.workProgress()
      if (progress.runnable) return true
      for (const member of progress.members) {
        if (member.tasks) {
          observe(member.tasks)
          const waiting = [...book.waits.values()].some((waits) => [...waits.values()].some((wait) => wait.tasks === member.tasks))
          if ((waiting || member.state === "waiting_on_work") && await tasksWake(member.tasks)) return true
          if (waiting) continue
        }
        if (lineage.has(member.sessionId)) continue
        if (member.state === "running" || member.state === "between_steps") return true
      }
      return false
    }
    if (lineage.has(id)) return false
    const waits = book.waits.get(id)
    if (waits?.size) {
      for (const wait of waits.values()) if (await tasksWake(wait.tasks)) return true
      return false
    }
    if (control && "child" in control && control.child && await control.state() === "waiting_on_work") return tasksWake(control.child.backgroundTasks)
    return true
  }
  async function any(refs: readonly WorkReference[]): Promise<boolean> {
    for (const ref of refs) if (await wakes(ref)) return true
    return false
  }
  return any(work)
}

/** Rule 3: something about `sessionId` changed that can stop it from
 *  answering, such as a stop, a settle, a delete, an interrupt, or its
 *  leaving this process. Each wait on it ends when it can no longer answer
 *  it: only a parent's or runtime's interrupt ends a wait on its child. */
export async function observeSessionChanged(store: AsyncEventStateReadSurface, sessionId: string): Promise<void> {
  const book = books.get(store)
  const deps = book?.deps
  if (!book || !deps || book.suspended) return
  for (const wait of waitsOn(book, sessionId)) await endIfUnavailable(book, deps, wait)
}

/** The project's runtime stops. A stop ends no wait: each stays held, and the
 *  next runtime registers it again and applies the end rules at once. */
export function suspendReplyWaits(store: AsyncEventStateReadSurface): void {
  const book = books.get(store)
  if (!book) return
  book.suspended = true
  for (const sessionId of book.parks.keys()) observeSessionResumed(store, sessionId)
  book.unsubscribe()
  books.delete(store)
}

/** Calls `listener` with the waiter each time a wait of the project opens or
 *  ends, and each time the stored open waits of a waiter change otherwise,
 *  across the runtimes of the project. A listener reads what changed from
 *  the stored waits (`readReplyWaitViews`), so a reader that keeps its last
 *  read needs to read again only after this call. */
export function onReplyWaitsChanged(store: AsyncEventStateReadSurface, listener: (waiterSessionId: string) => void): () => void {
  const listeners = changeListeners.get(store) ?? new Set<(waiterSessionId: string) => void>()
  changeListeners.set(store, listeners)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Calls `listener` with whether a run of `waiterSessionId` in this process
 *  holds an open wait, at once and each time its waits change. The run's
 *  stall watchdog reads it, so it is the run's own registration, not the
 *  stored record that a status reads. */
export function observeOpenReplyWaits(store: AsyncEventStateReadSurface, waiterSessionId: string, listener: (open: boolean) => void): () => void {
  const holdsWait = (): boolean => (books.get(store)?.waits.get(waiterSessionId)?.size ?? 0) > 0
  const stop = onReplyWaitsChanged(store, (sessionId) => {
    if (sessionId === waiterSessionId) listener(holdsWait())
  })
  listener(holdsWait())
  return stop
}

/** Whether `fromSessionId` waits for a reply, directly or through other
 *  reply waits, on `toSessionId`. A wait with no text on such an addressee
 *  would never end, so it is refused. The park of a parent on its running children is no edge: any
 *  input from the person and the end of any other child wake the park, a
 *  park on the waiter's own run alone is a yield that ends the wait
 *  (`observeSessionYield`), and the child shows that it waits on its
 *  parent, so a stall stays visible. */
export function waitsReach(store: AsyncEventStateReadSurface, fromSessionId: string, toSessionId: string): boolean {
  const waits = books.get(store)?.waits
  const seen = new Set<string>()
  const pending = [fromSessionId]
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined || seen.has(next)) continue
    if (next === toSessionId) return true
    seen.add(next)
    pending.push(...waits?.get(next)?.keys() ?? [])
  }
  return false
}
