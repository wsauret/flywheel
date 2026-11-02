import type { AsyncEventStateReadSurface, AsyncEventWriter, InFlightRecord, InFlightWrite } from "../../../infra/event-store-types.js"
import { heldBackgroundNotificationPut } from "./queued-background-notifications.js"
import { Log } from "../../../infra/log.js"
import type { ConversationMessage } from "../../agent-runtime/llm/types.js"

/** The in-flight kind of one open reply wait. The waiter holds it in its own
 *  session, keyed by the addressee and the call that opened the wait, so a
 *  wait outlives the process that opened it: the next run of the waiter
 *  registers it again. Each end retires exactly the cell of the wait it
 *  ends, never a newer wait on the same addressee: a message from the
 *  addressee retires it when the message is held in the waiter, and the
 *  notice of any other end retires it in the commit that makes the notice
 *  durable in the waiter's conversation. */
export const REPLY_WAIT_IN_FLIGHT_KIND = "session.reply_wait"

const log = Log.create({ service: "reply-wait-cells" })

/** The wait that one cell holds: who it waits on, and the call that opened it. */
export interface ReplyWaitIdentity {
  readonly addresseeSessionId: string
  /** The `message_session` call that opened the wait. */
  readonly toolUseId: string
}

/** One open reply wait as its waiter holds it. */
export interface ReplyWaitCell extends ReplyWaitIdentity {
  readonly openedAtMs: number
  /** The cell key of the message that the addressee must read before its
   *  yield ends the wait. A wait with no text has none: the first yield of
   *  the addressee after the wait opened ends it. */
  readonly readKey?: string
}

function cellKey(wait: ReplyWaitIdentity): string {
  return `${encodeURIComponent(wait.addresseeSessionId)}:${encodeURIComponent(wait.toolUseId)}`
}

function identityOf(key: string): ReplyWaitIdentity | undefined {
  const parts = key.split(":")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined
  try {
    return { addresseeSessionId: decodeURIComponent(parts[0]), toolUseId: decodeURIComponent(parts[1]) }
  } catch {
    // boundary: a key this build did not write is unreadable, not an error.
    return undefined
  }
}

/** Migration evidence for the exact call that opened a retained wait. */
export function replyWaitSource(row: InFlightRecord): ReplyWaitIdentity | undefined {
  if (row.kind !== REPLY_WAIT_IN_FLIGHT_KIND || typeof row.payload.openedAtMs !== "number"
    || row.payload.readKey !== undefined && typeof row.payload.readKey !== "string") return undefined
  return identityOf(row.key)
}

/** Holds one open wait. */
export async function holdReplyWait(writer: AsyncEventWriter, waiterSessionId: string, cell: ReplyWaitCell): Promise<void> {
  await writer.putInFlight?.(waiterSessionId, REPLY_WAIT_IN_FLIGHT_KIND, cellKey(cell), {
    openedAtMs: cell.openedAtMs,
    ...(cell.readKey === undefined ? {} : { readKey: cell.readKey }),
  })
}

/** Retires the cell of one wait outside an append: a reply ended it, or its
 *  own session stopped it, or a newer wait on the same addressee replaced it. */
export async function dropReplyWait(writer: AsyncEventWriter, waiterSessionId: string, wait: ReplyWaitIdentity): Promise<void> {
  await writer.dropInFlight?.(waiterSessionId, REPLY_WAIT_IN_FLIGHT_KIND, cellKey(wait))
}

/** The open waits a waiter holds. */
export async function readReplyWaits(reader: AsyncEventStateReadSurface, waiterSessionId: string): Promise<ReplyWaitCell[]> {
  return replyWaitCellsOf(waiterSessionId, await reader.readInFlight(waiterSessionId, REPLY_WAIT_IN_FLIGHT_KIND))
}

/** The open waits among the in-flight `rows` of `waiterSessionId`, which a
 *  reader can read with rows of other kinds in one snapshot. A cell this
 *  reader cannot decode is named in a warning and keeps its bytes. */
export function replyWaitCellsOf(waiterSessionId: string, rows: readonly InFlightRecord[]): ReplyWaitCell[] {
  const cells: ReplyWaitCell[] = []
  for (const row of rows) {
    if (row.kind !== REPLY_WAIT_IN_FLIGHT_KIND) continue
    const identity = identityOf(row.key)
    const { openedAtMs, readKey } = row.payload
    if (!identity || typeof openedAtMs !== "number" || (readKey !== undefined && typeof readKey !== "string")) {
      log.warn("unreadable reply wait skipped", { sessionId: waiterSessionId, key: row.key })
      continue
    }
    cells.push({ ...identity, openedAtMs, ...(readKey === undefined ? {} : { readKey }) })
  }
  return cells
}

const NOTICE_KEY_PREFIX = "reply-wait:"

/** The key of the notice that ends one wait for any reason other than a
 *  message from the addressee. A repeat of one end converges on one notice. */
export function replyWaitNoticeKey(wait: ReplyWaitIdentity): string {
  return `${NOTICE_KEY_PREFIX}${cellKey(wait)}`
}

/** Whether `key` is the key of a notice that ends one reply wait. */
export function isReplyWaitNoticeKey(key: string): boolean {
  return key.startsWith(NOTICE_KEY_PREFIX)
}

/** The reply-wait cells that the commit of `messages` retires: each
 *  reply-wait notice retires the cell of the one wait it ends. A drop of a
 *  key that no cell holds is a no-op. */
export function replyWaitRetirements(messages: readonly ConversationMessage[]): InFlightWrite[] {
  return messages.flatMap((message) => message.kind === "user" ? message.backgroundNotificationIds ?? [] : [])
    .filter((key) => key.startsWith(NOTICE_KEY_PREFIX))
    .map((key) => ({ op: "drop", kind: REPLY_WAIT_IN_FLIGHT_KIND, key: key.slice(NOTICE_KEY_PREFIX.length) }))
}

/** A historical aggregate wait cannot acquire an answering agent by conversion.
 * Preserve an existing end notice and retire exactly the old wait in the same transaction. */
export function orchestrationReplyWaitClosures(input: {
  readonly rows: readonly InFlightRecord[]
  readonly addressee: string
  readonly conversationId: string
  readonly noticeKeys: ReadonlySet<string>
}): readonly InFlightWrite[] {
  const writes: InFlightWrite[] = []
  for (const row of input.rows) {
    const identity = replyWaitSource(row)
    if (identity?.addresseeSessionId !== input.addressee) continue
    const key = replyWaitNoticeKey(identity)
    if (!input.noticeKeys.has(key)) writes.push(heldBackgroundNotificationPut(
      { target: "conversation", conversationId: input.conversationId },
      "This reply wait ended because the workflow is orchestration, not an answering agent. Its delivered message is preserved. Use process wait for workflow completion, or message the particular agent session for a reply.",
      key,
    ))
    writes.push({ op: "swap", kind: row.kind, key: row.key, expectedRaw: row.raw, payload: null })
  }
  return writes
}
