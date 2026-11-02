import { createEventProjection, type EventProjection } from "../../../infra/event-projection.js"
import { heldProjection, releaseHeldProjection } from "../../../infra/projection-registry.js"
import type { DegradedBlock } from "../../../infra/output-blocks.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type EventStoreReadSurface, type StoredFact } from "../../../infra/event-store-types.js"
import { resolveToolContentReference, type ContentResolver } from "../../../infra/tool-content.js"
import { runToCompletion } from "../../../infra/task-scheduling.js"
import type { StoredConversationEntry } from "./conversation-entry-schemas.js"
import type { ConversationEntry, MessageEntry } from "./conversation-entry-types.js"
import { TURN_END_ID_PREFIX } from "./turn-end-record.js"
import { admitEntries, chatTreeViolation, entryLink, type AdmissionFrontier, type EntryLink } from "./conversation-entry-admission.js"
import { salvageConversationTreeFact, type ConversationTreeFact, type DegradedEntrySource, type ConversationTreeSalvageResult, type InlineConversationTreeFact, type SalvagedConversationEntry } from "./conversation-facts.js"
import { walkBranchFromLeaf } from "./conversation-tree-context.js"
import { sessionMessageSources, sessionMessageSourcesSync, recoverSessionMessageProducer, type SessionMessageSources } from "../session-message-sources.js"
import { ConversationContextIdentities } from "./conversation-context-identities.js"
import { subagentCompletionRunIds } from "../../agent-runtime/background-work-notifications.js"

// `type` (not `interface`) so the shape carries the implicit index signature
// `createEventProjection` requires of a projection state.
export interface DegradedTranscriptRecord {
  readonly kind: "degraded"
  readonly event: Pick<StoredFact, "aggregateId" | "type" | "version" | "position">
  readonly sourceEntryId?: string
  readonly sourceParentId?: string
  readonly ordinal: number
  /** The stored bytes that the gap stands for: one entry of a batch, or the
   *  whole fact when no single entry can carry them. */
  readonly raw: unknown
  readonly anchorLeafId: string | null
  readonly block: DegradedBlock
}


export type ConversationTreeTranscriptEntry = ConversationEntry | DegradedTranscriptRecord
export class DegradedTranscriptSequence {
  readonly #records: DegradedTranscriptRecord[] = []
  #unreadable = false

  append(record: DegradedTranscriptRecord): void {
    this.#records.push(record)
    if (record.block.failureClass === "decode_failure") this.#unreadable = true
  }

  /** Whether some entry of this conversation could not be decoded, so an
   *  entry whose parent is missing may have lost that parent to it. */
  get unreadable(): boolean {
    return this.#unreadable
  }

  materialize(): readonly DegradedTranscriptRecord[] {
    return this.#records
  }

  get length(): number {
    return this.#records.length
  }
}

interface ConversationEntrySource {
  readonly position: number
  readonly eventId: string
  readonly entryOrdinal: number
}

/** The part of a durable conversation tree that the agent loop reads at start. */
export type CommittedTree = Pick<ConversationTreeProjectionState, "leafId" | "entriesById">;

export type ConversationTreeProjectionState = {
  created: boolean
  conversationId?: string
  createdAt?: string
  /** Projection-owned append-only index shared by state revisions. Entries and
   * captured leaf paths stay unchanged; enumerate the current revision only. */
  readonly entriesById: Readonly<StringMap<ConversationEntry>>
  /** Accepted entries only, with ordinals from the original stored batch.
   * Shares the append-only lifetime and commit boundary of entriesById. */
  readonly entrySourcesById: Readonly<StringMap<ConversationEntrySource>>
  readonly contextIdentities: ConversationContextIdentities
  /** Run coverage from accepted durable completion entries, across all branches. */
  readonly completedNotificationRunIds: Set<string>
  leafId: string | null
  /** Store position of the `chat.tree.created` commit, or -1 before it folds.
   *  Floors the interruption sweep: facts written before this conversation
   *  existed belong to other conversations of the same session (a workflow's
   *  earlier steps), and a fresh tree must not report them as its own
   *  interrupted work. */
  createdPosition: number
  /** Store position of the newest commit that carried an assistant entry or
   *  an interruption-boundary record, or -1 when the conversation has
   *  neither.
   *
   *  The boundary between work the conversation accounts for and work an
   *  interrupted turn left behind. It is the assistant commit rather than the
   *  newest commit because a resuming turn commits the user's message first:
   *  a watermark that moved on a user turn would step over the very actions
   *  the next context needs reported. An interruption record moves it too,
   *  because that record accounts for everything before it: without this, a
   *  second interruption before any new assistant commit would recompute the
   *  first record's id, find it present, and go unreported. */
  assistantWatermark: number
  degraded: DegradedTranscriptSequence
  completedFollowUpRequestSequences: number[]
}

export function branchVisibleTranscriptEntries(
  branch: readonly ConversationEntry[],
  degraded: DegradedTranscriptSequence,
): ConversationTreeTranscriptEntry[] {
  return runToCompletion(branchVisibleTranscriptWork(branch, degraded, degraded.length))
}

/** Selects identities held by the current model context, including degraded gaps. */
export function currentContextIdentities(state: ConversationTreeProjectionState) {
  return state.contextIdentities.at(state.leafId)
}

/** The prefix length is required because projection revisions share the
 * sequence: a later revision appends records that this capture must exclude.
 * Projection replay appends facts by position and each fact's records by entry
 * ordinal, so the sequence is already in transcript order. */
export function* branchVisibleTranscriptWork(
  branch: readonly ConversationEntry[],
  degraded: DegradedTranscriptSequence,
  degradedLength: number,
): Generator<void, ConversationTreeTranscriptEntry[]> {
  const branchIds = new Set<string>()
  for (const entry of branch) { yield; branchIds.add(entry.id) }
  const byAnchor = new Map<string | null, DegradedTranscriptRecord[]>()
  for (const record of degraded.materialize().slice(0, degradedLength)) {
    yield
    if (record.anchorLeafId !== null && !branchIds.has(record.anchorLeafId)) continue
    const records = byAnchor.get(record.anchorLeafId)
    if (records) records.push(record)
    else byAnchor.set(record.anchorLeafId, [record])
  }
  const transcript: ConversationTreeTranscriptEntry[] = [...(byAnchor.get(null) ?? [])]
  for (const entry of branch) {
    yield
    transcript.push(entry, ...(byAnchor.get(entry.id) ?? []))
  }
  return transcript
}

// Historical stores also hold "chat.entry.provisional" and
// "chat.provisionals.discarded", written when an unfinished turn was recorded
// fragment by fragment. Their absence here is the whole compatibility story:
// the fold selects by type, so an unlisted type is never read and an old
// conversation opens as the committed turns it always was.
export const CHAT_TREE_FACT_TYPES = ["chat.tree.created", "chat.entries.appended", "chat.follow_up_turn.completed", "chat.reasoning.reported"] as const

function conversationTreeKey(conversationId: string): string {
  return `conversation-tree:${conversationId}`
}

export function createConversationTreeProjection(
  reader: AsyncEventReadSurface,
  conversationId: string,
): EventProjection<ConversationTreeProjectionState> {
  return heldProjection(reader, conversationTreeKey(conversationId), () => {
    let sources: SessionMessageSources
    return createEventProjection(reader, {
      aggregateId: `conversation:${conversationId}`,
      factTypes: CHAT_TREE_FACT_TYPES,
      readsToolContent: true,
      seed: async () => { sources = await sessionMessageSources(reader).replay(); return undefined },
      initialState,
      reduce: (state, event, content) => reduceConversationTreeEvent(state, event, content, sources),
      reduceCorruptRow: (state, corrupt) => {
        appendDegraded(state, corruptEventEnvelope(corrupt), { ordinal: 0 }, state.leafId, "decode_failure")
        return { ...state }
      },
    })
  })
}

/** Drops the held tree of one conversation over `store`, for an owner whose
 *  session no longer reads it. A tree another holder still uses stays correct:
 *  that holder keeps its instance, and the next ask builds a new one. */
export function releaseConversationTreeProjection(reader: AsyncEventReadSurface, conversationId: string): void {
  releaseHeldProjection(reader, conversationTreeKey(conversationId))
}

function initialState(): ConversationTreeProjectionState {
  return { created: false, entriesById: {}, entrySourcesById: {}, contextIdentities: new ConversationContextIdentities(), completedNotificationRunIds: new Set(), leafId: null, createdPosition: -1, assistantWatermark: -1, degraded: new DegradedTranscriptSequence(), completedFollowUpRequestSequences: [] }
}

/** Synchronous startup recovery uses the same historical fold before async owners exist.
 * The sender sources read every session creation, so a caller that folds many
 * conversations keeps one `sessionMessageSourcesSync` read and passes its result in. */
export function readConversationSnapshotSync(reader: EventStoreReadSurface, conversationId: string, sources: SessionMessageSources = sessionMessageSourcesSync(reader)()): ConversationTreeProjectionState {
  let state = initialState()
  for (const fact of reader.readTolerant({ aggregateId: `conversation:${conversationId}`, types: CHAT_TREE_FACT_TYPES })) {
    if (fact instanceof CorruptEventRowError) {
      appendDegraded(state, corruptEventEnvelope(fact), { ordinal: 0 }, state.leafId, "decode_failure")
    } else state = reduceConversationTreeEvent(state, fact, reader.toolContent, sources)
  }
  return state
}

/** Reconstruct an isolated history at one primary boundary. Unlike the live
 * held projection, this state cannot advance while a search awaits indexing. */
export async function readConversationSnapshot(
  reader: AsyncEventReadSurface,
  conversationId: string,
  upperPosition: number,
): Promise<ConversationTreeProjectionState> {
  let state = initialState()
  const sources = await sessionMessageSources(reader).replay()
  let afterPosition = 0
  while (true) {
    const page = await reader.readPage(
      { aggregateId: `conversation:${conversationId}`, types: CHAT_TREE_FACT_TYPES },
      upperPosition, afterPosition, true,
    )
    for (const fact of page.facts) {
      if (fact instanceof CorruptEventRowError) {
        appendDegraded(state, corruptEventEnvelope(fact), { ordinal: 0 }, state.leafId, "decode_failure")
      } else {
        state = reduceConversationTreeEvent(state, fact, page.toolContent, sources)
      }
    }
    if (page.continuationPosition === null) return state
    afterPosition = page.continuationPosition
  }
}

function corruptEventEnvelope(corrupt: CorruptEventRowError): StoredFact {
  return {
    aggregateId: corrupt.row.aggregateId,
    id: corrupt.row.eventId,
    seq: corrupt.row.seq,
    type: corrupt.row.type,
    version: corrupt.row.version,
    timestamp: corrupt.row.timestamp,
    actor: corrupt.row.actor,
    sessionId: corrupt.row.sessionId,
    payload: { rawPayload: corrupt.row.rawPayload, error: corrupt.message },
    position: corrupt.row.position,
  }
}

function reduceConversationTreeEvent(
  state: ConversationTreeProjectionState,
  event: StoredFact,
  toolContent: ContentResolver,
  sources: SessionMessageSources,
): ConversationTreeProjectionState {
  const decoded = salvageReplayEvent(event, toolContent)
  if (decoded.kind === "degraded") {
    for (const source of decoded.sources) appendDegraded(state, event, source, state.leafId, "decode_failure")
    return { ...state }
  }
  if (decoded.kind === "entries") {
    if (event.aggregateId !== `conversation:${decoded.conversationId}`) {
      throw chatTreeViolation(event, "orphan-event", `fact targets conflicting conversation ${decoded.conversationId}`)
    }
    return appendEntries(state, event, decoded.items, sources)
  }
  const fact = decoded.fact
  if (fact.type === "chat.tree.created") {
    if (state.created) {
      appendDegraded(state, event, { ordinal: 0 }, state.leafId)
      return { ...state }
    }
    return {
      ...state,
      created: true,
      conversationId: fact.payload.conversationId,
      createdAt: fact.payload.createdAt,
      createdPosition: event.position,
    }
  }
  requireCreation(state.created, event)

  switch (fact.type) {
    case "chat.entries.appended":
      return appendEntries(state, event, fact.payload.entries, sources)
    case "chat.follow_up_turn.completed": {
      if (state.conversationId !== fact.payload.conversationId) throw chatTreeViolation(event, "orphan-event", `follow-up marker targets ${fact.payload.conversationId}`)
      if (state.completedFollowUpRequestSequences.includes(fact.payload.requestSequence)) {
        throw chatTreeViolation(event, "duplicate-event", `follow-up request ${fact.payload.requestSequence} already completed`)
      }
      const branch = walkBranchFromLeaf(state.entriesById, state.leafId, () => {
        throw chatTreeViolation(event, "missing-producer-event", `follow-up request ${fact.payload.requestSequence} has an incomplete active branch`)
      })
      const matches = branch.filter(
        (entry) => entry.kind === "message" && entry.followUpRequestSequence === fact.payload.requestSequence,
      )
      if (matches.length !== 1 || state.completedFollowUpRequestSequences.length + 1 !== fact.payload.requestSequence) {
        throw chatTreeViolation(event, "missing-producer-event", `follow-up request ${fact.payload.requestSequence} has no matching correlated user turn`)
      }
      return { ...state, completedFollowUpRequestSequences: [...state.completedFollowUpRequestSequences, fact.payload.requestSequence] }
    }
    case "chat.reasoning.reported": {
      const counted: StringMap<ConversationEntry> = {}
      for (const { entryId, reasoningTokens } of fact.payload.counts) {
        const entry = state.entriesById[entryId]
        // A count whose message did not decode has nothing to annotate; the
        // gap of that message's batch already stands in the transcript.
        if (entry?.kind !== "message" || entry.message.kind !== "assistant") continue
        counted[entryId] = { ...entry, message: { ...entry.message, reasoningTokens } }
      }
      // In place, as `appendEntries` commits: the fold owns this index.
      Object.assign(state.entriesById, counted)
      return { ...state }
    }
  }
}

/** A recovered fact other than the creation needs a readable creation before
 *  it. A salvaged entry batch does not: it stands as recovered history.
 *  @throws {InvariantViolation} When no readable creation came before. */
function requireCreation(created: boolean, event: StoredFact): void {
  if (!created) throw chatTreeViolation(event, "missing-producer-event", "chat.tree.created has not been observed")
}

function appendEntries(
  state: ConversationTreeProjectionState,
  event: StoredFact,
  items: readonly (ConversationEntry | SalvagedConversationEntry)[],
  sources: SessionMessageSources,
): ConversationTreeProjectionState {
  const { admissions, frontier } = admitEntries(event, items, (id) => {
    const entry = state.entriesById[id]
    return entry && entryLink(entry)
  }, { leafId: state.leafId, unreadable: state.degraded.unreadable })
  // The prototype supplies committed lookups without copying history. Own
  // properties hold only this fact's accepted entries until validation ends.
  const entriesById: StringMap<ConversationEntry> = Object.create(state.entriesById)
  const entrySourcesById: StringMap<ConversationEntrySource> = {}
  const degraded: DegradedTranscriptRecord[] = []
  const contextUpdates: (ConversationEntry | DegradedTranscriptRecord)[] = []
  let answered = false
  for (const admission of admissions) {
    if (admission.kind === "degraded") {
      const record = degradedRecord(event, admission.source, admission.anchorLeafId, admission.failureClass)
      degraded.push(record)
      contextUpdates.push(record)
      continue
    }
    let entry = admission.entry
    if (entry.kind === "message" && entry.message.kind === "user") {
      const producer = recoverSessionMessageProducer(entry.message.producer, sources)
      if (producer !== entry.message.producer) entry = { ...entry, message: { ...entry.message, producer } }
    }
    validateFollowUpEntry(entry, entriesById, event)
    entriesById[entry.id] = entry
    entrySourcesById[entry.id] = Object.freeze({ position: event.position, eventId: event.id, entryOrdinal: admission.ordinal })
    contextUpdates.push(entry)
    if (entry.kind === "message" && entry.message.kind === "assistant") answered = true
    // Recognized by id: turn-end records (a crash, a pause, Escape) carry the
    // prefix, and a durable flag on the entry would be a schema change every
    // reader pays for. Records written before the prefix existed simply do
    // not move the watermark, which is the pre-fix behavior.
    if (entry.id.startsWith(TURN_END_ID_PREFIX)) answered = true
  }
  Object.assign(state.entriesById, entriesById)
  Object.assign(state.entrySourcesById, entrySourcesById)
  for (const update of contextUpdates) {
    if (update.kind === "degraded") state.contextIdentities.appendGap(update.anchorLeafId, JSON.stringify(update.raw))
    else {
      state.contextIdentities.append(update, state.entriesById)
      // This append-only set shares the accepted-entry index's commit boundary.
      for (const id of subagentCompletionRunIds(update.id)) state.completedNotificationRunIds.add(id)
    }
  }
  for (const record of degraded) state.degraded.append(record)
  return { ...state, leafId: frontier.leafId, ...(answered ? { assistantWatermark: event.position } : {}) }
}

/** The links of a conversation's accepted entries and where their admission
 *  stands: what deciding the admission of later entries reads, without any
 *  message text. `admitTreeFact` advances it. */
export interface ConversationTopology {
  readonly links: Map<string, EntryLink>
  frontier: AdmissionFrontier
  /** Whether a readable creation was admitted. */
  created: boolean
}

export function newConversationTopology(): ConversationTopology {
  return { links: new Map(), frontier: { leafId: null, unreadable: false }, created: false }
}

/** Advances `topology` by one row of `CHAT_TREE_FACT_TYPES` as the tree fold
 *  reads it, and returns the links of the entries that the conversation
 *  accepted from it. `toolContent` must resolve the row's references: a
 *  batch whose referenced text does not verify is one gap, as in the tree.
 *  @throws {InvariantViolation} Where the tree fold throws for the same row. */
export function admitTreeFact(topology: ConversationTopology, row: StoredFact | CorruptEventRowError, toolContent: ContentResolver): readonly EntryLink[] {
  if (row instanceof CorruptEventRowError) {
    topology.frontier = { ...topology.frontier, unreadable: true }
    return []
  }
  const decoded = salvageReplayEvent(row, toolContent)
  if (decoded.kind === "recovered") {
    if (decoded.fact.type === "chat.tree.created") {
      topology.created = true
      return []
    }
    requireCreation(topology.created, row)
  }
  const items = decoded.kind === "degraded" ? decoded.sources.map((source) => ({ kind: "degraded" as const, source }))
    : decoded.kind === "entries" ? decoded.items
    : decoded.fact.type === "chat.entries.appended" ? decoded.fact.payload.entries
    : []
  const { admissions, frontier } = admitEntries(row, items, (id) => topology.links.get(id), topology.frontier)
  topology.frontier = frontier
  return admissions.flatMap((admission) => {
    if (admission.kind === "degraded") return []
    topology.links.set(admission.entry.id, admission.link)
    return [admission.link]
  })
}


function appendDegraded(
  state: ConversationTreeProjectionState,
  event: StoredFact,
  source: DegradedEntrySource,
  anchorLeafId: string | null,
  failureClass: DegradedBlock["failureClass"] = "structural_violation",
): void {
  const record = degradedRecord(event, source, anchorLeafId, failureClass)
  state.degraded.append(record)
  state.contextIdentities.appendGap(anchorLeafId, JSON.stringify(record.raw))
}

function degradedRecord(
  event: StoredFact,
  source: DegradedEntrySource,
  anchorLeafId: string | null,
  failureClass: DegradedBlock["failureClass"] = "structural_violation",
): DegradedTranscriptRecord {
  return {
    kind: "degraded",
    event: { aggregateId: event.aggregateId, type: event.type, version: event.version, position: event.position },
    ...(source.sourceEntryId ? { sourceEntryId: source.sourceEntryId } : {}),
    ...(source.sourceParentId ? { sourceParentId: source.sourceParentId } : {}),
    ordinal: source.ordinal,
    // A gap carries exactly the bytes it stands for, so a batch of k
    // unreadable entries holds each entry once, not the whole fact k times.
    raw: "raw" in source ? source.raw : event,
    anchorLeafId,
    block: {
      kind: "degraded",
      id: `${event.aggregateId}:${event.position}:${source.ordinal}`,
      factFamily: "chat_tree",
      failureClass,
      eventType: event.type,
      eventVersion: event.version,
      eventPosition: event.position,
      notice: "Part of this transcript could not be displayed.",
      timestamp: event.timestamp,
    },
  }
}

type InlineConversationTreeSalvageResult =
  | { readonly kind: "recovered"; readonly fact: InlineConversationTreeFact }
  | Extract<ConversationTreeSalvageResult, { kind: "entries" | "degraded" }>

/** The single entry parse point of the fold: decode the fact, then hydrate
 *  reference-capable history to exact text without changing version or provenance so every
 *  downstream consumer - transcript, block projection, branch history,
 *  model-context rebuild, recall render - receives only the inline shape. */
function salvageReplayEvent(event: StoredFact, toolContent: ContentResolver): InlineConversationTreeSalvageResult {
  const decoded = salvageConversationTreeFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
  const payload = event.payload
  const conversationId = typeof payload === "object" && payload !== null && "conversationId" in payload ? payload.conversationId : undefined
  if (typeof conversationId === "string" && event.aggregateId !== `conversation:${conversationId}`) {
    throw chatTreeViolation(event, "orphan-event", `fact targets conflicting conversation ${conversationId}`)
  }
  if (decoded.kind !== "recovered") return decoded
  try {
    return { kind: "recovered", fact: hydrateConversationTreeFact(decoded.fact, event, toolContent) }
  } catch {
    return { kind: "degraded", sources: [{ ordinal: 0 }] }
  }
}

/** Resolve reference-capable entries to sha256-verified inline text while
 *  preserving the fact's version and message provenance. */
function hydrateConversationTreeFact(
  fact: ConversationTreeFact,
  event: StoredFact,
  toolContent: ContentResolver,
): InlineConversationTreeFact {
  if (fact.type !== "chat.entries.appended" || fact.version === 1) return fact
  return {
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: {
      conversationId: fact.payload.conversationId,
      entries: fact.payload.entries.map((entry) => hydrateConversationEntry(entry, event, toolContent)),
    },
  }
}

function hydrateConversationEntry(entry: StoredConversationEntry, event: StoredFact, toolContent: ContentResolver): ConversationEntry {
  if (entry.kind !== "message") return entry
  const message = entry.message
  if (message.kind !== "toolResult") return { ...entry, message }
  const hydrated: MessageEntry["message"] = {
    ...message,
    content: message.content.map((part) => part.type !== "text_reference" ? part : ({
      type: "text" as const,
      text: resolveToolContentReference(toolContent, event.sessionId, part, {
        eventType: event.type,
        eventPosition: event.position,
        aggregateId: event.aggregateId,
      }),
    })),
  }
  return { ...entry, message: hydrated }
}

function validateFollowUpEntry(entry: ConversationEntry, entriesById: StringMap<ConversationEntry>, event: StoredFact): void {
  if (entry.kind === "message" && entry.followUpRequestSequence !== undefined) {
    if (entry.message.kind !== "user") {
      throw chatTreeViolation(event, "orphan-event", `follow-up request ${entry.followUpRequestSequence} is not a user turn`)
    }
    // oxlint-disable-next-line eslint/guard-for-in -- batch overlays must include committed entries for cross-batch identity validation.
    for (const id in entriesById) {
      const existing = entriesById[id]
      if (existing?.kind === "message" && existing.followUpRequestSequence === entry.followUpRequestSequence) {
        throw chatTreeViolation(event, "duplicate-event", `duplicate follow-up request ${entry.followUpRequestSequence}`)
      }
    }
    const priorRequests = walkBranchFromLeaf(entriesById, entry.parentId, () => {
      throw chatTreeViolation(event, "missing-producer-event", `follow-up request ${entry.followUpRequestSequence} has an incomplete parent branch`)
    }).filter((existing) => existing.kind === "message" && existing.followUpRequestSequence !== undefined)
    if (entry.followUpRequestSequence !== priorRequests.length + 1) {
      throw chatTreeViolation(event, "orphan-event", `follow-up request ${entry.followUpRequestSequence} is not contiguous`)
    }
  }
}

interface StringMap<T> { [key: string]: T }
