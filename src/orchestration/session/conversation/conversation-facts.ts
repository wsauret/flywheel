import { Schema } from "effect"
import { defineFact } from "../../../infra/event-registry.js"
import { ConversationEntrySchema, HistoricalConversationEntrySchema, HistoricalStoredConversationEntrySchema, StoredConversationEntryV3Schema, StoredConversationEntryV4Schema, StoredConversationEntryV5Schema, StoredConversationEntryV6Schema, StoredConversationEntryV7Schema, StoredConversationEntryV8Schema, type StoredConversationEntry } from "./conversation-entry-schemas.js"

const DateTimeStringSchema = Schema.String.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)) || "Expected ISO datetime string"),
)

const ConversationTreeCreatedFactSchema = defineFact({
  type: "chat.tree.created",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    createdAt: DateTimeStringSchema,
  }),
})

const ChatEntriesAppendedFactSchema = defineFact({
  type: "chat.entries.appended",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(HistoricalConversationEntrySchema)).check(Schema.isNonEmpty()),
  }),
})

const ChatFollowUpTurnCompletedFactSchema = defineFact({
  type: "chat.follow_up_turn.completed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
})

// Version 2 added tool-content references. Both historical versions preserve
// unmarked user-role messages without claiming that a human produced them.
const ChatEntriesAppendedV2FactSchema = defineFact({
  type: "chat.entries.appended",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(HistoricalStoredConversationEntrySchema)).check(Schema.isNonEmpty()),
  }),
})

// Version 3 added explicit human provenance. Its producer vocabulary names a
// parent's message `parent-agent`, which decodes as a session producer.
const ChatEntriesAppendedV3FactSchema = defineFact({
  type: "chat.entries.appended",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(StoredConversationEntryV3Schema)).check(Schema.isNonEmpty()),
  }),
})

// Version 4 stored a message from another session with a session producer
// that carried no envelope. Remove it after 2027-04-03, when no store holds it.
const ChatEntriesAppendedV4FactSchema = defineFact({
  type: "chat.entries.appended",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(StoredConversationEntryV4Schema)).check(Schema.isNonEmpty()),
  }),
})

// Version 5 stores a message from another session with its session producer
// and the envelope the recipient reads. The writer uses it only for a batch
// that carries such a message, so a rollback degrades only those batches (see
// `chatEntriesAppendedVersion`). It has no launch producer, so it decodes
// unchanged into the current shape.
const ChatEntriesAppendedV5FactSchema = defineFact({
  type: "chat.entries.appended",
  version: 5,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(StoredConversationEntryV5Schema)).check(Schema.isNonEmpty()),
  }),
})

// Version 6 also stores the assignment that launched a subagent with a launch
// producer that names the parent. The writer uses it only for a batch that
// carries such a message, which is the publication of a subagent.
const ChatEntriesAppendedV6FactSchema = defineFact({
  type: "chat.entries.appended",
  version: 6,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(StoredConversationEntryV6Schema)).check(Schema.isNonEmpty()),
  }),
})

/** Review evidence uses one bounded root. Ordinary tool text can remain inline or referenced. */
const ChatEntriesAppendedV7FactSchema = defineFact({
  type: "chat.entries.appended",
  version: 7,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(StoredConversationEntryV7Schema)).check(Schema.isNonEmpty()),
  }),
})

/** Version 8 also stores content-repair decisions. The writer uses it only for
 *  a batch that holds one, so an earlier build reads every other batch. */
const ChatEntriesAppendedV8FactSchema = defineFact({
  type: "chat.entries.appended",
  version: 8,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    entries: Schema.mutable(Schema.Array(StoredConversationEntryV8Schema)).check(Schema.isNonEmpty()),
  }),
})

// The reasoning tokens that providers reported for the responses of assistant
// messages, written in the batch of the entries fact that stores the messages.
// It is its own fact, not a field of those messages, because the fold of a
// build before 2026-10-08 selects only the fact types it knows: that build
// reads the messages whole and only estimates their re-sent thinking lower.
const ChatReasoningReportedFactSchema = defineFact({
  type: "chat.reasoning.reported",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    counts: Schema.mutable(Schema.Array(Schema.Struct({
      entryId: Schema.NonEmptyString,
      reasoningTokens: Schema.Int.check(Schema.isGreaterThan(0)),
    }))).check(Schema.isNonEmpty()),
  }),
})

export const ConversationTreeFactSchemas = [
  ConversationTreeCreatedFactSchema,
  ChatEntriesAppendedFactSchema,
  ChatEntriesAppendedV2FactSchema,
  ChatEntriesAppendedV3FactSchema,
  ChatEntriesAppendedV4FactSchema,
  ChatEntriesAppendedV5FactSchema,
  ChatEntriesAppendedV6FactSchema,
  ChatEntriesAppendedV7FactSchema,
  ChatEntriesAppendedV8FactSchema,
  ChatFollowUpTurnCompletedFactSchema,
  ChatReasoningReportedFactSchema,
] as const

const ConversationTreeFactSchema = Schema.Union(ConversationTreeFactSchemas)

export type ConversationTreeFact = typeof ConversationTreeFactSchema.Type

/** The fold sees only hydrated entries, regardless of the stored history version. */
export type InlineConversationTreeFact = Exclude<ConversationTreeFact, { type: "chat.entries.appended" }> | {
  readonly type: "chat.entries.appended"
  readonly version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  readonly actor: "flywheel"
  readonly payload: {
    readonly conversationId: string
    readonly entries: readonly typeof ConversationEntrySchema.Type[]
  }
}

/** The facts a current writer records `entries` with, in this order: the
 *  entries, then the reasoning counts their assistant messages carry, which
 *  no entries fact stores. */
export function chatEntriesFacts(conversationId: string, entries: readonly (typeof ConversationEntrySchema.Type)[]): readonly [ConversationTreeFact, ...ConversationTreeFact[]] {
  const counts: { entryId: string; reasoningTokens: number }[] = []
  const stored = entries.map((entry): StoredConversationEntry => {
    if (entry.kind !== "message" || entry.message.kind !== "assistant" || entry.message.reasoningTokens === undefined) return entry
    const { reasoningTokens, ...message } = entry.message
    counts.push({ entryId: entry.id, reasoningTokens })
    return { ...entry, message }
  })
  const appended = parseConversationTreeFact({ type: "chat.entries.appended", version: chatEntriesAppendedVersion(stored), actor: "flywheel", payload: { conversationId, entries: stored } })
  return counts.length === 0
    ? [appended]
    : [appended, { type: "chat.reasoning.reported", version: 1, actor: "flywheel", payload: { conversationId, counts } }]
}

/** The version a current writer gives a batch of entries: the lowest version
 *  that stores every producer in it, so an earlier build still reads every
 *  other batch. A content-repair decision requires 8; otherwise reference-backed
 *  review evidence requires 7, a launch producer requires 6, a session producer
 *  requires 5, and other entries use 3. */
export function chatEntriesAppendedVersion(entries: readonly { readonly kind: string; readonly message?: { readonly kind: string; readonly contentRepair?: unknown; readonly mutationEvidence?: unknown; readonly producer?: { readonly kind: string } } }[]): 3 | 5 | 6 | 7 | 8 {
  if (entries.some(entry => entry.kind === "message" && entry.message?.kind === "system" && entry.message.contentRepair !== undefined)) return 8
  if (entries.some(entry => entry.kind === "message" && entry.message?.kind === "system" && entry.message.mutationEvidence !== undefined)) return 7
  const producers = new Set(entries.flatMap((entry) => entry.kind === "message" && entry.message?.kind === "user" && entry.message.producer ? [entry.message.producer.kind] : []))
  if (producers.has("launch")) return 6
  return producers.has("session") ? 5 : 3
}

/** The first `chat.entries.appended` version that stores the envelope of a
 *  message from another session. Every earlier version decodes a session
 *  producer with no envelope, so an earlier batch never holds an enveloped
 *  session message. */
export const FIRST_SESSION_ENVELOPE_VERSION = 5

export function parseConversationTreeFact(value: unknown): ConversationTreeFact {
  return Schema.decodeUnknownSync(ConversationTreeFactSchema, { onExcessProperty: "error" })(value)

}

type ConversationTreeFactEnvelope = { readonly type: string; readonly version: number; readonly actor: string; readonly payload: unknown }

/** What a transcript gap names of the stored fact that it stands for. */
export interface DegradedEntrySource {
  readonly ordinal: number
  readonly sourceEntryId?: string
  readonly sourceParentId?: string
  /** The stored bytes of the one entry that the gap stands for; absent when
   *  the gap stands for the whole fact. */
  readonly raw?: unknown
}

export type SalvagedConversationEntry =
  | { readonly kind: "entry"; readonly entry: typeof ConversationEntrySchema.Type; readonly ordinal: number; readonly provenance: "salvaged" }
  | { readonly kind: "degraded"; readonly source: DegradedEntrySource }

export type ConversationTreeSalvageResult =
  | { readonly kind: "recovered"; readonly fact: ConversationTreeFact }
  | { readonly kind: "entries"; readonly conversationId: string; readonly items: readonly SalvagedConversationEntry[] }
  | { readonly kind: "degraded"; readonly sources: readonly DegradedEntrySource[] }

/** Decode one historical fact strictly, then apply only the reviewed entry-family salvage. */
export function salvageConversationTreeFact(value: ConversationTreeFactEnvelope): ConversationTreeSalvageResult {
  try {
    return { kind: "recovered", fact: parseConversationTreeFact(value) }
  } catch {
    const knownExcess = salvageKnownExcessFact(value)
    if (knownExcess) return { kind: "recovered", fact: knownExcess }
    const salvaged = salvageEntriesFact(value)
    return salvaged ?? { kind: "degraded", sources: salvageEntryIdentities(value) }
  }
}

function salvageKnownExcessFact(value: ConversationTreeFactEnvelope): ConversationTreeFact | null {
  if (value.type !== "chat.tree.created" || value.version !== 1 || value.actor !== "flywheel") return null
  if (typeof value.payload !== "object" || value.payload === null) return null
  if (!("conversationId" in value.payload) || !("createdAt" in value.payload)) return null
  try {
    return parseConversationTreeFact({
      type: value.type,
      version: value.version,
      actor: value.actor,
      payload: { conversationId: value.payload.conversationId, createdAt: value.payload.createdAt },
    })
  } catch {
    return null
  }
}

function salvageEntriesFact(value: ConversationTreeFactEnvelope): Extract<ConversationTreeSalvageResult, { kind: "entries" }> | null {
  if (value.type !== "chat.entries.appended" || value.version !== 1 || value.actor !== "flywheel") return null
  if (typeof value.payload !== "object" || value.payload === null || !("conversationId" in value.payload) || !("entries" in value.payload)) return null
  if (typeof value.payload.conversationId !== "string" || value.payload.conversationId.length === 0 || !Array.isArray(value.payload.entries) || value.payload.entries.length === 0) return null
  const decodeEntry = Schema.decodeUnknownSync(HistoricalConversationEntrySchema)
  const items = value.payload.entries.map((entry, ordinal): SalvagedConversationEntry => {
    try {
      return { kind: "entry", entry: decodeEntry(entry), ordinal, provenance: "salvaged" }
    } catch {
      return { kind: "degraded", source: salvageEntryIdentity(entry, ordinal) }
    }
  })
  return { kind: "entries", conversationId: value.payload.conversationId, items }
}

function salvageEntryIdentity(entry: unknown, ordinal: number): DegradedEntrySource {
  if (typeof entry !== "object" || entry === null) return { ordinal, raw: entry }
  const sourceEntryId = "id" in entry && typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined
  const sourceParentId = "parentId" in entry && typeof entry.parentId === "string" && entry.parentId.length > 0 ? entry.parentId : undefined
  return { ordinal, ...(sourceEntryId ? { sourceEntryId } : {}), ...(sourceParentId ? { sourceParentId } : {}), raw: entry }
}
function salvageEntryIdentities(value: ConversationTreeFactEnvelope): readonly DegradedEntrySource[] {
  if (value.type !== "chat.entries.appended" || typeof value.payload !== "object" || value.payload === null || !("entries" in value.payload) || !Array.isArray(value.payload.entries)) {
    return [{ ordinal: 0 }]
  }
  const sources = value.payload.entries.map((entry, ordinal) => salvageEntryIdentity(entry, ordinal))
  return sources.length > 0 ? sources : [{ ordinal: 0 }]
}
