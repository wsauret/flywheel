import { Schema } from "effect"
import { requireGuardedEventAppender, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { ComposerReturnSchema, returnedInputNoticeId, type ClaimComposerReturnsResult } from "../../protocol/composer-returns.js"
import { createSessionPlacementProjection, sessionMetadataStateOf } from "./session-metadata-projection.js"
import { tryOpenConversationTree } from "./conversation/conversation-tree-handle.js"
import { createConversationMessageEntry } from "./conversation/conversation-tree.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND, queuedInputPayload, type QueuedUserInputCell } from "./conversation/queued-user-inputs.js"
import { liveSessionControl } from "./live-session-control.js"

export const COMPOSER_RETURN_KIND = "chat.composer_return"
const CellSchema = Schema.Struct({ version: Schema.Literal(1), conversationId: Schema.NonEmptyString, ...ComposerReturnSchema.fields })
const decode = Schema.decodeUnknownSync(CellSchema)
const log = Log.create({ service: "composer-returns" })

/** Resolves the durable owning chat without using a viewer or live runner. */
export async function owningChat(reader: AsyncEventStateReadSurface, sessionId: string) {
  const placements = await createSessionPlacementProjection(reader).replay()
  let id = sessionId
  let current = sessionMetadataStateOf(placements, sessionId).sessions[sessionId]
  while (current && (current.kind === "subagent" || current.kind === "workflow-agent")) {
    const parent = current.launchedFrom.parentSessionId
    id = parent
    current = sessionMetadataStateOf(placements, parent).sessions[parent]
  }
  return current?.kind === "chat" ? { ...current, id } : undefined
}

/** Atomically preserves unread human words on the owning chat and retires their
 * source hold. Repeated settlement never recreates a claimed convenience copy. */
export async function returnUnreadHumanInput(store: {
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
}, source: { readonly sessionId: string; readonly name: string }, cells: readonly QueuedUserInputCell[]): Promise<void> {
  if (cells.length === 0) return
  const parent = await owningChat(store.reader, source.sessionId)
  if (!parent) throw new Error(`No owning chat for returned input from ${source.sessionId}`)
  const tree = await tryOpenConversationTree({ sessionId: parent.id, conversationId: parent.conversationId, store: store.reader, writer: store.writer })
  if (!tree) throw new Error(`Missing parent conversation ${parent.conversationId}`)
  try {
    for (const cell of cells) {
      const noticeId = returnedInputNoticeId(source.sessionId, cell.key)
      const { origin: _origin, producer: _producer, ...input } = queuedInputPayload(cell)
      const payload = CellSchema.make({ version: 1, conversationId: parent.conversationId, noticeId, sourceSessionId: source.sessionId, sourceName: source.name, input })
      const message = `Subagent "${source.name}" finished before reading your message:\n\n${cell.text}`
      const timestamp = new Date().toISOString()
      for (;;) {
        const appends = await tree.getStorage().prepareEntriesAppend(async (state) => state.entriesById[noticeId] ? [] : [
          createConversationMessageEntry({ kind: "system", content: message, displayOnly: true }, noticeId, state.leafId, timestamp),
        ])
        if (appends.length === 0) break
        try {
          const result = await requireGuardedEventAppender(store.writer, "Composer returns require atomic publication").appendBatchGuarded(appends.map((append) => ({
            ...append, inFlight: [
              { op: "swap", sessionId: source.sessionId, kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: cell.key, expectedRaw: cell.raw, payload: null },
              { op: "put", kind: COMPOSER_RETURN_KIND, key: noticeId, payload },
            ],
          })))
          if (result.kind === "conflict") continue
        } catch (cause) {
          if (await tree.getEntry(noticeId)) break
          throw cause
        }
        liveSessionControl(store.reader, parent.id)?.publishCommittedNotice?.({ id: noticeId, message, timestamp: Date.parse(timestamp) })
        log.info("unread input return published", { sourceSessionId: source.sessionId, parentSessionId: parent.id, noticeId })
        break
      }
    }
  } finally { tree.getStorage().dispose() }
}

/** Claims only copies naming a submission sent by the caller, exactly once. The transcript notice is
 * immutable; a lost claim reply loses only the optional local draft copy. */
export async function claimComposerReturns(store: { readonly reader: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter }, sessionId: string, submissionIds: readonly string[]): Promise<ClaimComposerReturnsResult> {
  const chat = await owningChat(store.reader, sessionId)
  if (!chat || chat.id !== sessionId) return { ok: false, error: "Composer returns require an existing parent chat." }
  const sent = new Set(submissionIds)
  for (;;) {
    const rows = await store.reader.readInFlight(sessionId, COMPOSER_RETURN_KIND)
    if (rows.length === 0) return { ok: true, kind: "empty" }
    const matches = []
    for (const row of rows) {
      try {
        const item = decode(row.payload)
        if (item.input.submissionIds?.some((id) => sent.has(id))) matches.push({ row, item })
      } catch {
        log.warn("unreadable composer return retained", { sessionId, key: row.key, kind: row.kind, version: row.payload.version })
        return { ok: false, error: "A saved composer return is unreadable. Its words remain in the parent transcript." }
      }
    }
    if (matches.length === 0) return { ok: true, kind: "no_match" }
    if (!store.writer.swapInFlightBatch) throw new Error("Composer claims require atomic cell authority")
    if (await store.writer.swapInFlightBatch(sessionId, matches.map(({ row }) => ({ op: "swap", kind: row.kind, key: row.key, expectedRaw: row.raw, payload: null })))) {
      return { ok: true, kind: "claimed", items: matches.map(({ item }) => item) }
    }
  }
}

