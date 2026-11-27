import { CorruptEventRowError, type AsyncEventAppender, type AsyncEventStateReadSurface, type StoredFact } from "../../../infra/substrate/store/event-store-types.js"
import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import { Log } from "../../../infra/diagnostics/log.js"
import { createBackgroundLane } from "../../../infra/diagnostics/operation-log.js"
import { parseProjectionFact } from "../../../infra/substrate/projection/event-projection.js"
import { yieldToNextTask } from "../../../infra/process/task-scheduling.js"
import { parseConversationTreeFact } from "../../session/conversation/conversation-facts.js"
import type { StoredConversationEntry } from "../../session/conversation/conversation-entry-schemas.js"
import { turnEndOfEntry } from "../../session/conversation/turn-end-record.js"
import { answerOf } from "../../session/control/chat-turn-stops.js"
import type { ChatReadCause, ChatReadRecordedFact } from "../../session/persistence/chat-read-receipt-facts.js"
import type { ChatTurnStopFact } from "../../session/persistence/chat-turn-stop-facts.js"
import { parseSessionFact } from "../../session/persistence/session-fact-registry.js"
import { prepareSessionFactAppend } from "../../session/persistence/session-fact-writer.js"
import type { ChatTurnEnding } from "../../../protocol/session/chat-settlement-protocol-types.js"
import { unreadChatsCursor, type RuntimeUnreadChatsSnapshotResult, type StoppedChat, type UnreadChatsMutation, type UnreadChatsView } from "../../../protocol/session/unread-protocol-types.js"
import type { RuntimePosition, RuntimeUiPatchInput } from "../../../protocol/runtime/runtime-ui-protocol-types.js"
import type { RuntimeReadAnchor } from "./runtime-ui-patch-sequencer.js"

const log = Log.create({ service: "unread-chats-projection" })

const SESSION_AGGREGATE_PREFIX = "session:"
const DELETED_FACT_TYPE = "session.deleted"
const BASELINE_FACT_TYPES = ["chat.turn.stopped", "chat.turn.started", "chat.read.recorded", DELETED_FACT_TYPE] as const
const ENTRIES_FACT_TYPE = "chat.entries.appended"
const FOLDED_TYPES = new Set<string>([...BASELINE_FACT_TYPES, ENTRIES_FACT_TYPE])
/** The newest entry batches of each conversation that work at the baseline:
 *  enough for the turn's newest answer and cut, never its history. */
const TAIL_BATCHES = 16
/** The answer to a mark unread of a chat with no final message, no error,
 *  and no new assistant message: there is nothing that could be unread. */
const NOTHING_TO_MARK_UNREAD = "This chat has no message or error to mark unread."

/** SQLite caps one compound select, so one tail read names at most this many conversations. */
const TAIL_CONVERSATIONS_PER_READ = 500

/** `Connection` names one client connection, the owner of its presence. */
export interface UnreadChatsProjection<Connection> {
  /** The stopped unread chats and the chats with unread messages, and the
   *  position of the cursor that the answer covers. The first call reads
   *  the baseline, which publishes nothing. */
  snapshot(): Promise<RuntimeUnreadChatsSnapshotResult>
  /** Serves a presence report of `connection`, or a mark. A report says that
   *  the person is at its chat, or at no chat; when the last connection at a
   *  chat leaves it, the chat's receipt is recorded. A report with no
   *  connection has no one to hold it and does nothing. A chat marked unread
   *  stays unread for the connections at it until one of them reports it
   *  again. A mark unread of a chat with nothing to read is refused, so the
   *  list that offered it can say why nothing changed. */
  dispatch(command: UnreadChatsMutation, connection: Connection | undefined): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>
  /** The connection ended, and its presence with it. */
  disconnect(connection: Connection): void
  dispose(): void
}

export interface UnreadChatsProjectionDeps {
  readonly reader: Pick<AsyncEventStateReadSurface, "capturePosition" | "readPage" | "readSlice">
  readonly writer: Pick<AsyncEventAppender, "append">
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly bus: {
    publish(input: RuntimeUiPatchInput): void
    snapshotPosition(anchor: RuntimeReadAnchor): RuntimePosition
  }
}

interface ChatStop {
  readonly position: number
  readonly stoppedAt: number
  readonly ending: ChatTurnEnding
  readonly finalEntryId?: string
  readonly firstLine?: string
}

type ReceiptPayload = ChatReadRecordedFact["payload"]

/** What the set knows about one root chat, folded from its newest stop,
 *  start, and receipt, and from the entry batches of its conversation. */
interface ChatRead {
  stop?: ChatStop
  started?: { readonly position: number; readonly conversationId: string }
  receipt?: ReceiptPayload & { readonly position: number }
  /** Receipts on their way to the store, oldest first. The newest one is
   *  what the person has read until the store answers. */
  readonly pending: ReceiptPayload[]
  /** The newest entry batch that this fold read, and in it the newest
   *  assistant entry, the newest answer since the person's last message (the
   *  answer that the chat's next stop names when its turn says nothing new),
   *  and the newest cut that ended a turn with no stop. */
  entriesAt?: number
  assistantAt?: number
  answerId?: string
  cutAt?: number
  /** The key of the newest stop that this set judged for a page. A stop
   *  recorded again with the same key, as a compaction or a turn that says
   *  nothing new does, is not new. */
  judgedKey?: string
}

/** The chat's place in the published view. */
type ViewEntry = { readonly kind: "stopped"; readonly position: number; readonly chat: StoppedChat } | { readonly kind: "unread" }

/** The project's chats that stopped for the person unread, and its working
 *  chats with unread messages (ARCH-PROTOCOL-072), beside the set of
 *  sessions that wait on a question. It also owns the presence that clients
 *  report and the read receipts that the presence and the person's marks
 *  produce (ARCH-SESSIONS-052).
 *
 *  Nothing is read at construction. The first request reads the newest stop,
 *  start, and receipt of every session in one paged read, and the newest
 *  entry batches of the chats that work, in one read. After it, each stored
 *  fact advances the set from its own payload with no read, and the whole
 *  view is published only when a chat's place in it changes. A chat whose
 *  newest facts cannot be decoded is left out and recorded once. A chat with
 *  no receipt has read its messages through the baseline
 *  (PI-INTERACTION-188). */
export function createUnreadChatsProjection<Connection>(deps: UnreadChatsProjectionDeps): UnreadChatsProjection<Connection> {
  let chats: Map<string, ChatRead> | undefined
  let baseline: Promise<Map<string, ChatRead>> | undefined
  // Facts stored while the baseline read ran. Each applies once the baseline
  // lands; one that the baseline already holds is older than its fold.
  let heldDuringBaseline: StoredFact[] | undefined
  let baselinePosition = 0
  let latestPosition = 0
  const entries = new Map<string, ViewEntry>()
  const unreadable = new Set<string>()
  const at = new Map<Connection, { readonly sessionId: string; counts: boolean }>()
  const writes = createBackgroundLane(log, "unread-chats")
  let failedWrites = 0
  let disposed = false

  function reportUnreadable(sessionIds: Iterable<string>, cause: string): void {
    const fresh = [...sessionIds].filter((sessionId) => !unreadable.has(sessionId))
    if (fresh.length === 0) return
    for (const sessionId of fresh) unreadable.add(sessionId)
    log.warn("read state unreadable; chats left out of the unread set", { count: fresh.length, sessionIds: fresh, cause })
  }

  /** Folds one fact into `held`, and answers the chat it changed. */
  function fold(held: Map<string, ChatRead>, fact: StoredFact): string | undefined {
    const { sessionId } = fact
    if (unreadable.has(sessionId)) return undefined
    try {
      if (fact.type === ENTRIES_FACT_TYPE) {
        const chat = held.get(sessionId)
        if (!chat || (chat.entriesAt ?? -1) >= fact.position) return undefined
        // A batch that cannot be decoded holds nothing this fold can read,
        // and it never hides the chat's stop.
        const appended = decodeEntries(fact)
        if (!appended) return undefined
        chat.entriesAt = fact.position
        foldEntries(chat, appended, fact.position)
        return sessionId
      }
      if (fact.aggregateId !== `${SESSION_AGGREGATE_PREFIX}${sessionId}`) return undefined
      if (fact.type === DELETED_FACT_TYPE) {
        held.delete(sessionId)
        return sessionId
      }
      const parsed = parseProjectionFact(fact, parseSessionFact<ChatTurnStopFact | ChatReadRecordedFact>)
      const chat = held.get(sessionId) ?? { pending: [] }
      held.set(sessionId, chat)
      if (parsed.type === "chat.turn.started") {
        if ((chat.started?.position ?? -1) >= fact.position) return undefined
        chat.started = { position: fact.position, conversationId: parsed.payload.conversationId }
      } else if (parsed.type === "chat.turn.stopped") {
        if ((chat.stop?.position ?? -1) >= fact.position) return undefined
        const { ending, finalEntryId, firstLine } = parsed.payload
        chat.stop = { position: fact.position, stoppedAt: fact.timestamp, ending, ...(finalEntryId ? { finalEntryId } : {}), ...(firstLine !== undefined ? { firstLine } : {}) }
        if (finalEntryId) chat.answerId = finalEntryId
      } else {
        if ((chat.receipt?.position ?? -1) >= fact.position) return undefined
        chat.receipt = { position: fact.position, ...parsed.payload }
      }
      return sessionId
    } catch {
      // `cause` is a kind, never an error message: the message quotes the stored payload.
      reportUnreadable([sessionId], fact.type)
      return sessionId
    }
  }

  function present(sessionId: string): boolean {
    for (const presence of at.values()) if (presence.counts && presence.sessionId === sessionId) return true
    return false
  }

  /** Whether the chat holds something the person has not read under
   *  `receipt`, setting presence aside. */
  function unreadUnder(chat: ChatRead, receipt: ReceiptPayload | undefined): boolean {
    if (receipt?.cause === "marked_unread") return markable(chat)
    const { stop } = chat
    if (stop && isStopped(chat)) {
      if (stop.finalEntryId !== undefined) return receipt?.finalEntryId !== stop.finalEntryId
      return stop.ending.kind !== "completed" && stop.position > (receipt?.readThrough ?? -1)
    }
    return isWorking(chat) && chat.assistantAt !== undefined && chat.assistantAt > (receipt?.readThrough ?? baselinePosition)
  }

  function entryOf(sessionId: string, chat: ChatRead | undefined): ViewEntry | undefined {
    if (!chat || unreadable.has(sessionId) || present(sessionId) || !unreadUnder(chat, chat.pending.at(-1) ?? chat.receipt)) return undefined
    const { stop } = chat
    if (!stop || !isStopped(chat)) return { kind: "unread" }
    return {
      kind: "stopped",
      position: stop.position,
      chat: { sessionId, ending: stop.ending, ...(stop.firstLine !== undefined ? { firstLine: stop.firstLine } : {}), stoppedAt: stop.stoppedAt, stopKey: stopKeyOf(stop) },
    }
  }

  /** Moves each chat of `sessionIds` to its place in the view, and answers
   *  whether any place changed. */
  function place(held: Map<string, ChatRead>, sessionIds: Iterable<string>): boolean {
    let changed = false
    for (const sessionId of sessionIds) {
      const next = entryOf(sessionId, held.get(sessionId))
      if (JSON.stringify(next) === JSON.stringify(entries.get(sessionId))) continue
      if (next) entries.set(sessionId, next)
      else entries.delete(sessionId)
      changed = true
    }
    return changed
  }

  /** Moves the chats of `sessionIds` to their places and publishes the view
   *  when a place changed. `stoppedNow` names the chats whose live stop
   *  fact this change folded: each one that the view now lists with a stop
   *  it did not judge before is announced in the patch, so a pager pages
   *  for a real stop and never for a read, a mark, or a baseline. */
  function refresh(sessionIds: Iterable<string>, stoppedNow: Iterable<string> = []): void {
    if (!chats) return
    const changed = place(chats, sessionIds)
    const newStops: StoppedChat[] = []
    for (const sessionId of stoppedNow) {
      const chat = chats.get(sessionId)
      if (!chat?.stop) continue
      const key = stopKeyOf(chat.stop)
      if (chat.judgedKey === key) continue
      chat.judgedKey = key
      const entry = entries.get(sessionId)
      if (entry?.kind === "stopped") newStops.push(entry.chat)
    }
    if (!changed || disposed) return
    deps.bus.publish({ cursor: unreadChatsCursor(), payload: { kind: "unreadChats.changed", ...view(), newStops } })
  }

  function view(): UnreadChatsView {
    const stopped = [...entries.values()].flatMap((entry) => entry.kind === "stopped" ? [entry] : []).toSorted((first, second) => second.position - first.position)
    const unread = [...entries].flatMap(([sessionId, entry]) => entry.kind === "unread" ? [sessionId] : []).toSorted()
    return { stopped: stopped.map((entry) => entry.chat), unread }
  }

  function apply(held: Map<string, ChatRead>, events: readonly StoredFact[]): void {
    const touched = new Set<string>()
    const stopped = new Set<string>()
    for (const event of events) {
      latestPosition = Math.max(latestPosition, event.position)
      if (!FOLDED_TYPES.has(event.type)) continue
      const sessionId = fold(held, event)
      if (sessionId === undefined) continue
      touched.add(sessionId)
      if (event.type === "chat.turn.stopped") stopped.add(sessionId)
    }
    refresh(touched, stopped)
    // A chat that stops while the person is at it is read at its stop.
    for (const sessionId of stopped) if (present(sessionId)) record(held, sessionId, "stopped_under_presence")
  }

  /** The receipt that `cause` records now: a read covers every fact stored
   *  so far and names the answer in front of the person, and a mark unread
   *  keeps the position read before it. Undefined for a mark unread of a
   *  chat with nothing to read. */
  function receiptFor(chat: ChatRead, cause: ChatReadCause): ReceiptPayload | undefined {
    const prior = chat.pending.at(-1) ?? chat.receipt
    if (cause === "marked_unread") return markable(chat) ? { readThrough: prior?.readThrough ?? baselinePosition, cause } : undefined
    const finalEntryId = isStopped(chat) ? chat.stop?.finalEntryId : chat.answerId
    return { readThrough: latestPosition, ...(finalEntryId ? { finalEntryId } : {}), cause }
  }

  /** Records the receipt for `cause`. Its content is taken now, so a fact
   *  stored before the write reaches the store is never read by it, and the
   *  chat reads as that receipt until the store answers. Whether to write is
   *  decided in the ordered write lane against the committed receipt, after
   *  every earlier receipt settled: nothing is written when the receipt
   *  would not change what the chat shows. A failed write leaves the chat as
   *  the store holds it, so the next trigger records it again. */
  function record(held: Map<string, ChatRead>, sessionId: string, cause: ChatReadCause): Promise<void> {
    const chat = held.get(sessionId)
    if (!chat || unreadable.has(sessionId)) return Promise.resolve()
    const receipt = receiptFor(chat, cause)
    if (!receipt) return Promise.resolve()
    chat.pending.push(receipt)
    refresh([sessionId])
    return writes.run(async () => {
      try {
        if (held.get(sessionId) !== chat || unreadUnder(chat, receipt) === unreadUnder(chat, chat.receipt)) return
        const stored = await deps.writer.append(prepareSessionFactAppend(sessionId, { type: "chat.read.recorded", version: 1, actor: "user", payload: receipt }))
        if (chats === held) apply(held, [stored])
        const { readThrough, finalEntryId } = receipt
        log.info("chat read recorded", { sessionId, cause, readThrough, position: stored.position, ...(finalEntryId ? { finalEntryId } : {}), ...(failedWrites > 0 ? { failedBefore: failedWrites } : {}) })
        failedWrites = 0
      } catch (error) {
        if (failedWrites === 0) log.warn("chat read not recorded", { sessionId, cause, error: errorMessage(error) })
        failedWrites += 1
      } finally {
        chat.pending.splice(chat.pending.indexOf(receipt), 1)
        refresh([sessionId])
      }
    })
  }

  async function readBaseline(): Promise<Map<string, ChatRead>> {
    const held = new Map<string, ChatRead>()
    // The newest row of each session and type decides, and only it is folded.
    // A row that a newer one superseded is never decoded, so it cannot hide a
    // chat even when it cannot be parsed or its schema is not this build's.
    // Pages arrive in position order, so a later row replaces an earlier one.
    const newest = new Map<string, StoredFact | CorruptEventRowError>()
    const rowOf = (fact: StoredFact | CorruptEventRowError) => fact instanceof CorruptEventRowError ? fact.row : fact
    const query = { aggregatePrefix: SESSION_AGGREGATE_PREFIX, types: BASELINE_FACT_TYPES }
    const upper = await deps.reader.capturePosition()
    for (let position = 0; position < upper;) {
      const page = await deps.reader.readPage(query, upper, position, true, "deferred")
      for (const fact of page.facts) {
        const row = rowOf(fact)
        newest.set(`${row.aggregateId}\u0000${row.type}`, fact)
      }
      if (page.continuationPosition === null) break
      position = page.continuationPosition
      await yieldToNextTask()
    }
    const deciding = [...newest.values()].toSorted((first, second) => rowOf(first).position - rowOf(second).position)
    reportUnreadable(deciding.flatMap((fact) => fact instanceof CorruptEventRowError ? [fact.row.sessionId] : []), "baseline read")
    for (const fact of deciding) if (!(fact instanceof CorruptEventRowError)) fold(held, fact)
    baselinePosition = upper
    latestPosition = Math.max(latestPosition, upper)
    await readWorkingTails(held)
    return held
  }

  /** One read of the newest entry batches of every chat that works at the
   *  baseline, so its newest assistant entry, its answer, and a cut that
   *  ended its turn survive a restart. */
  async function readWorkingTails(held: Map<string, ChatRead>): Promise<void> {
    const working = [...held.values()].flatMap((chat) => isWorking(chat) && chat.started ? [chat.started] : [])
    const aggregateIds = [...new Set(working.map((started) => `conversation:${started.conversationId}`))]
    if (aggregateIds.length === 0) return
    const afterPosition = Math.min(...working.map((started) => started.position))
    const tail: StoredFact[] = []
    for (let index = 0; index < aggregateIds.length; index += TAIL_CONVERSATIONS_PER_READ) {
      const ids = aggregateIds.slice(index, index + TAIL_CONVERSATIONS_PER_READ)
      const slice = await deps.reader.readSlice({ aggregateIds: ids, types: [ENTRIES_FACT_TYPE], afterPosition, order: "desc", limitPerAggregate: TAIL_BATCHES, limit: ids.length * TAIL_BATCHES }, true)
      // A batch that cannot be decoded holds nothing this fold can read.
      for (const fact of slice.facts) if (!(fact instanceof CorruptEventRowError)) tail.push(fact)
    }
    for (const fact of tail.toSorted((first, second) => first.position - second.position)) fold(held, fact)
  }

  function load(): Promise<Map<string, ChatRead>> {
    baseline ??= (async () => {
      heldDuringBaseline = []
      const held = await readBaseline()
      place(held, held.keys())
      // The stops that the baseline holds are judged: none of them pages.
      for (const chat of held.values()) if (chat.stop) chat.judgedKey = stopKeyOf(chat.stop)
      chats = held
      const pending = heldDuringBaseline
      heldDuringBaseline = undefined
      apply(held, pending)
      // A presence reported before the baseline held while the chat stopped.
      for (const { sessionId, counts } of at.values()) {
        const chat = held.get(sessionId)
        if (counts && chat && isStopped(chat)) record(held, sessionId, "stopped_under_presence")
      }
      return held
    })().catch((error: unknown) => {
      // The next request reads the baseline again, and that read covers
      // every fact that this one would have.
      baseline = undefined
      heldDuringBaseline = undefined
      throw error
    })
    return baseline
  }

  /** The chat that `connection` left: the last connection at it records the receipt. */
  function left(prior: { readonly sessionId: string; readonly counts: boolean } | undefined, next: string | undefined): Promise<void> {
    if (!prior?.counts || prior.sessionId === next) return Promise.resolve()
    const { sessionId } = prior
    // A loaded set decides at once, so no fact folds between the end of the
    // presence and its receipt and shows the chat unread for a moment.
    const decide = (held: Map<string, ChatRead>): Promise<void> => present(sessionId) ? Promise.resolve() : record(held, sessionId, "presence_ended")
    return chats ? decide(chats) : load().then(decide)
  }

  const unsubscribeStored = deps.onStored((events) => {
    if (disposed) return
    if (chats) apply(chats, events)
    else if (heldDuringBaseline) heldDuringBaseline.push(...events.filter((event) => FOLDED_TYPES.has(event.type)))
  })

  async function report(connection: Connection, sessionId: string | undefined): Promise<void> {
    const prior = at.get(connection)
    if (sessionId === undefined) at.delete(connection)
    else at.set(connection, { sessionId, counts: true })
    const leaving = left(prior, sessionId)
    if (chats) refresh(sessionId === undefined ? [] : [sessionId])
    else if (sessionId !== undefined) void load().catch((error: unknown) => { log.warn("unread set not loaded for a presence", { error: errorMessage(error) }) })
    await leaving
  }

  /** Records a mark, and answers false for a mark unread of a chat with
   *  nothing to read, which records nothing. */
  async function mark(sessionId: string, read: boolean): Promise<boolean> {
    const held = await load()
    const chat = held.get(sessionId)
    if (!read && (chat === undefined || !markable(chat))) return false
    if (!read) for (const presence of at.values()) if (presence.sessionId === sessionId) presence.counts = false
    await record(held, sessionId, read ? "marked_read" : "marked_unread")
    refresh([sessionId])
    return true
  }

  return {
    async snapshot() {
      await load()
      await writes.settled()
      // Taken with the view, so every patch the answer covers is one the
      // client skips.
      return { ...view(), snapshotPosition: deps.bus.snapshotPosition({ kind: "cursor", cursor: unreadChatsCursor() }) }
    },
    async dispatch(command, connection) {
      if (command.type === "chat.presence") {
        if (connection !== undefined) await report(connection, command.sessionId)
        return { ok: true }
      }
      return await mark(command.sessionId, command.type === "chat.mark_read") ? { ok: true } : { ok: false, error: NOTHING_TO_MARK_UNREAD }
    },
    disconnect(connection) {
      const prior = at.get(connection)
      at.delete(connection)
      left(prior, undefined).catch((error: unknown) => { log.warn("presence end not recorded", { error: errorMessage(error) }) })
    },
    dispose() {
      disposed = true
      unsubscribeStored()
    },
  }
}

function decodeEntries(fact: StoredFact): readonly StoredConversationEntry[] | undefined {
  try {
    const appended = parseProjectionFact(fact, parseConversationTreeFact)
    return appended.type === ENTRIES_FACT_TYPE ? appended.payload.entries : undefined
  } catch {
    return undefined
  }
}

/** Advances `chat` by one entry batch of its conversation, stored at `position`. */
function foldEntries(chat: ChatRead, batch: readonly StoredConversationEntry[], position: number): void {
  for (const entry of batch) {
    if (entry.kind !== "message") continue
    const { message } = entry
    if (message.kind === "user" && message.origin === "human") chat.answerId = undefined
    if (message.kind === "assistant") chat.assistantAt = position
    const answer = answerOf(entry)
    if (answer) chat.answerId = answer.entryId
    const end = turnEndOfEntry(entry)
    // A cut ends the turn with no stop: an interrupt, a close, or a crash.
    // A planned cut has a successor that continues the same turn.
    if (end && (end.reason === "crash" || (end.reason === "paused" && end.planned !== true))) chat.cutAt = position
  }
}

/** The identity of a stop: its final entry, or the stop itself for one with no answer. */
function stopKeyOf(stop: ChatStop): string {
  return stop.finalEntryId ?? `stop:${stop.position}`
}

function isStopped(chat: ChatRead): boolean {
  return chat.stop !== undefined && chat.stop.position > (chat.started?.position ?? -1)
}

/** Whether the chat's agent still works: its newest start is newer than its
 *  newest stop and than any cut. */
function isWorking(chat: ChatRead): boolean {
  return chat.started !== undefined && !isStopped(chat) && chat.started.position > (chat.cutAt ?? -1)
}

/** Whether the chat holds something to read: a stop with a final message or
 *  an error, or a working turn with an assistant message. */
function markable(chat: ChatRead): boolean {
  if (isStopped(chat)) return chat.stop?.finalEntryId !== undefined || chat.stop?.ending.kind !== "completed"
  return isWorking(chat) && chat.assistantAt !== undefined
}
