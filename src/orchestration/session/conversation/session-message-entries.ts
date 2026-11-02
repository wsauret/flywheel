import { createEventProjection } from "../../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { heldProjection } from "../../../infra/projection-registry.js"
import type { StoredConversationEntry } from "./conversation-entry-schemas.js"
import type { ConversationEntry } from "./conversation-entry-types.js"
import { FIRST_SESSION_ENVELOPE_VERSION, salvageConversationTreeFact } from "./conversation-facts.js"

type SessionProducer<M> = M extends { readonly producer?: infer P } ? Extract<P, { readonly kind: "session" }> : never
type EnvelopedProducer<P> = P extends { readonly envelope?: infer V } ? P & { readonly envelope: NonNullable<V> } : never
type UserMessageEntry<E> = E extends { readonly kind: "message"; readonly message: infer M }
  ? M extends { readonly kind: "user" } ? E & { readonly message: M & { readonly producer: EnvelopedProducer<SessionProducer<M>> } } : never
  : never

/** A user entry that holds a message which another session sent through
 *  `message_session`, as the conversation recorded it. */
export type SessionMessageEntry = UserMessageEntry<StoredConversationEntry | ConversationEntry>

export interface SessionMessageEntries {
  /** The entries in recorded order, on every branch and in every generation. */
  readonly entries: readonly SessionMessageEntry[]
  /** The batches that could hold such a message but that no reviewed
   *  decode can read. The conversation's own projection shows each one as a
   *  degraded gap. */
  readonly unreadableBatches: number
}

/** Reads every enveloped session message, on every branch and generation,
 *  from the held entry index. Only new batches cross the conversation's
 *  reviewed salvage boundary; tool content is not hydrated. */
export async function readSessionMessageEntries(reader: AsyncEventStateReadSurface, conversationId: string): Promise<SessionMessageEntries> {
  const state = await entryIndex(reader, conversationId).replay()
  return { entries: state.messages.slice(), unreadableBatches: state.unreadableMessageBatches }
}

/** Which of `keys` name an entry of one conversation, on any branch and in
 *  any generation, through the index over every batch version: a
 *  person's message writes a version without the session envelope. */
export async function conversationHoldsEntries(reader: AsyncEventStateReadSurface, conversationId: string, keys: readonly string[]): Promise<ReadonlySet<string>> {
  if (keys.length === 0) return new Set()
  const state = await entryIndex(reader, conversationId).replay()
  return new Set(keys.filter((key) => state.entryIds.has(key)))
}

/** The ids of every tool call that one conversation's assistant entries
 *  record, on every branch and in every generation, through the same index
 *  over every batch version, with no tool-content hydration. A
 *  nested call is recorded through its container call. `unreadableBatches`
 *  counts the batches whose calls are unknown. */
export async function readConversationToolUseIds(reader: AsyncEventStateReadSurface, conversationId: string): Promise<{ readonly toolUseIds: ReadonlySet<string>; readonly unreadableBatches: number }> {
  const state = await entryIndex(reader, conversationId).replay()
  return { toolUseIds: new Set(state.toolUseIds), unreadableBatches: state.unreadableBatches }
}

interface EntryIndex {
  readonly entryIds: Set<string>
  readonly messages: SessionMessageEntry[]
  readonly toolUseIds: Set<string>
  unreadableBatches: number
  unreadableMessageBatches: number
}

function entryIndex(reader: AsyncEventStateReadSurface, conversationId: string) {
  return heldProjection(reader, `conversation-entry-index:${conversationId}`, () => createEventProjection<EntryIndex>(reader, {
    aggregateId: `conversation:${conversationId}`,
    factTypes: ["chat.entries.appended"],
    initialState: () => ({ entryIds: new Set(), messages: [], toolUseIds: new Set(), unreadableBatches: 0, unreadableMessageBatches: 0 }),
    draft: (state) => state,
    reduce: indexBatch,
    reduceCorruptRow: (state) => {
      state.unreadableBatches += 1
      state.unreadableMessageBatches += 1
      return state
    },
  }))
}

function indexBatch(state: EntryIndex, row: StoredFact): EntryIndex {
  const decoded = salvageConversationTreeFact({ type: row.type, version: row.version, actor: row.actor, payload: row.payload })
  const entries = decoded.kind === "recovered"
    ? decoded.fact.type === "chat.entries.appended" ? decoded.fact.payload.entries : []
    : decoded.kind === "entries" ? decoded.items.flatMap((item) => item.kind === "entry" ? [item.entry] : []) : []
  const unreadable = decoded.kind === "degraded" || (decoded.kind === "entries" && decoded.items.some((item) => item.kind === "degraded"))
  // These containers stay private and each read returns a snapshot. Advancing
  // them in place costs only the new batch, not a copy of the entire index.
  for (const entry of entries) {
    state.entryIds.add(entry.id)
    if (row.version >= FIRST_SESSION_ENVELOPE_VERSION && isSessionMessage(entry)) state.messages.push(entry)
    if (entry.kind !== "message" || entry.message.kind !== "assistant" || !Array.isArray(entry.message.content)) continue
    for (const block of entry.message.content) if (block.type === "tool_use") state.toolUseIds.add(block.id)
  }
  if (unreadable) {
    state.unreadableBatches += 1
    if (row.version >= FIRST_SESSION_ENVELOPE_VERSION) state.unreadableMessageBatches += 1
  }
  return state
}

function isSessionMessage(entry: StoredConversationEntry | ConversationEntry): entry is SessionMessageEntry {
  return entry.kind === "message" && entry.message.kind === "user" && entry.message.producer?.kind === "session" && entry.message.producer.envelope !== undefined
}
