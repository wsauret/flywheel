import type { AsyncEventReadSurface } from "../../infra/event-store-types.js"
import type { ConversationSearchIndex } from "../../infra/conversation-fts.js"
import {
  countConversationRecall,
  searchConversationRecall,
  type RecallSearchHit,
  type RecallSearchQuery,
} from "../../infra/conversation-recall-search.js"
import { branchVisibleTranscriptEntries, readConversationSnapshot, type DegradedTranscriptRecord } from "./conversation/conversation-projection.js"
import { walkBranchFromLeaf, type BranchWalkGap } from "./conversation/conversation-tree-context.js"
import type { ConversationEntry } from "./conversation/conversation-entry-types.js"
import {
  RECALL_PAGE_SIZE,
  RECALL_READ_DEFAULT_LIMIT,
  RECALL_READ_MAX_LIMIT,
  type RecallPort,
  type RecallEntryReference,
  type RecallHit,
  type RecallInput,
  type RecallResult,
  type RecallScope,
} from "../../protocol/conversation-recall.js"
import { renderRecallEntry, renderRecallEntryText } from "./conversation-recall-render.js"

const DEFAULT_RECENT = 25

interface RecallDeps {
  store: AsyncEventReadSurface
  index: ConversationSearchIndex
  conversationId: string
}

export function createConversationRecall(deps: RecallDeps): RecallPort {
  const reader = deps.store
  return async (input: RecallInput): Promise<RecallResult> => {
    const upperPosition = await reader.capturePosition()
    const ordered = await orderedScopedEntries(reader, deps.conversationId, input.scope, upperPosition)
    const indexByEntryId = new Map(ordered.map((entry, index) => [sourceIdentity(entry), index]))
    const entryById = new Map(ordered.map((entry) => [sourceIdentity(entry), entry]))
    const entryIds = input.scope === "lineage" ? new Set(ordered.map(sourceIdentity)) : undefined

    const expand = input.expand ?? []
    if (expand.length > 0 && !input.query?.trim()) {
      return expandResult(expand, indexByEntryId, entryById, input.offset ?? 0, input.limit ?? RECALL_READ_DEFAULT_LIMIT)
    }

    if (input.query?.trim()) {
      const page = Math.max(1, input.page ?? 1)
      const raw = input.query.trim()
      const searchQuery: RecallSearchQuery = {
        upperPosition,
        conversationId: deps.conversationId,
        match: buildFtsMatch(raw),
        ...(entryIds ? { entryIds } : {}),
        limit: RECALL_PAGE_SIZE + 1,
        offset: (page - 1) * RECALL_PAGE_SIZE,
      }
      const db = await deps.index.through(upperPosition)
      const hits = searchConversationRecall(db, searchQuery)
      const rendered = hits.map((hit) => toRecallHit(hit, indexByEntryId, entryById, {
        conversationId: deps.conversationId,
        page,
        limit: searchQuery.limit,
        availableReadPositions: ordered.length,
      }))
      // totalMatches is the TRUE in-scope match count from a scoped COUNT query,
      // not rendered.length: the latter is capped by the per-page fetch limit and
      // would grow each page, so the tool's "N total" / totalPages would be wrong.
      return {
        hits: rendered.slice(0, RECALL_PAGE_SIZE),
        totalMatches: countConversationRecall(db, searchQuery),
      }
    }

    // Default-recent: no FTS, just the tail of the scoped ordering.
    const recent = ordered.slice(-DEFAULT_RECENT)
    return {
      hits: recent.flatMap((entry) => {
        const index = indexByEntryId.get(sourceIdentity(entry))
        return index === undefined ? [] : [renderRecallRecord(entry, index)]
      }),
    }
  }
}

async function orderedScopedEntries(reader: AsyncEventReadSurface, conversationId: string, scope: RecallScope, upperPosition: number): Promise<RecallEntry[]> {
  const state = await readConversationSnapshot(reader, conversationId, upperPosition)
  const raw = scope === "lineage"
    ? walkBranchFromLeaf(state.entriesById, state.leafId, (gap) => onGap(conversationId, gap))
    : topoFlatten(state.entriesById)
  const readable = raw.filter(isRecallable)
  const readableIds = new Set(readable.map((entry) => entry.id))
  const visible = branchVisibleTranscriptEntries(raw, state.degraded)
  const degraded = visible.filter((entry): entry is DegradedTranscriptRecord => entry.kind === "degraded")
    .filter((record) => record.sourceEntryId !== undefined && !readableIds.has(record.sourceEntryId))
  return [...readable, ...degraded].sort(compareRecallEntries)
}

type RecallEntry = ConversationEntry | DegradedTranscriptRecord

function sourceIdentity(entry: RecallEntry): string {
  if (entry.kind !== "degraded") return entry.id
  if (entry.sourceEntryId === undefined) throw new Error("recall: degraded transcript record has no validated source identity")
  return entry.sourceEntryId
}

function compareRecallEntries(left: RecallEntry, right: RecallEntry): number {
  if (left.kind === "degraded" && right.kind === "degraded") return left.event.position - right.event.position || left.ordinal - right.ordinal
  if (left.kind === "degraded") return 1
  if (right.kind === "degraded") return -1
  return 0
}

function isRecallable(entry: ConversationEntry): boolean {
  if (entry.kind === "leaf" || entry.kind === "label" || entry.kind === "session_info") return false
  if (entry.kind === "message" && entry.displayOnly === true) return false
  return true
}

function onGap(conversationId: string, gap: BranchWalkGap): never {
  throw new Error(gap.kind === "leaf"
    ? `recall: conversation ${conversationId} has no leaf entry ${gap.leafEntryId}`
    : `recall: entry ${gap.childId} references missing parent ${gap.parentId}`)
}

// Deterministic parent-before-child topological flatten of the projection:
// roots by insertion order, pre-order DFS children by insertion order. Re-runs
// over the same projection produce identical #index assignments.
//
// Iterative (explicit stack) rather than recursive: a long linear conversation
// chain is a degenerate tree of depth N, and recursion would overflow the call
// stack on a deep chain. The stack is seeded with the roots in reverse insertion
// order and each node's children are pushed in reverse insertion order, so nodes
// pop in forward insertion order - producing the same pre-order, parent-before-
// child sequence the recursive form did.
function topoFlatten(entriesById: StringMap<ConversationEntry>): ConversationEntry[] {
  const childrenByParent = new Map<string | null, ConversationEntry[]>()
  for (const entry of Object.values(entriesById)) {
    const bucket = childrenByParent.get(entry.parentId)
    if (bucket) bucket.push(entry)
    else childrenByParent.set(entry.parentId, [entry])
  }
  const ordered: ConversationEntry[] = []
  const stack = [...(childrenByParent.get(null) ?? [])].toReversed()
  while (stack.length > 0) {
    // SAFETY: guarded by stack.length > 0, so pop() returns a ConversationEntry.
    const entry = stack.pop()!
    ordered.push(entry)
    const children = childrenByParent.get(entry.id)
    if (children) for (let i = children.length - 1; i >= 0; i--) {
      // SAFETY: i is bounded by [0, children.length), so the index is in range.
      stack.push(children[i]!)
    }
  }
  return ordered
}

interface RecallMappingContext {
  conversationId: string
  page: number
  limit: number
  availableReadPositions: number
}

function toRecallHit(
  hit: RecallSearchHit,
  indexByEntryId: Map<string, number>,
  entryById: Map<string, RecallEntry>,
  context: RecallMappingContext,
): RecallHit {
  const index = indexByEntryId.get(hit.entryId)
  const entry = entryById.get(hit.entryId)
  if (index === undefined || entry === undefined) {
    throw new Error(`recall: selected FTS hit did not map exactly once (conversation=${context.conversationId}, entry=${hit.entryId}, page=${context.page}, limit=${context.limit}, availableReadPositions=${context.availableReadPositions})`)
  }
  const rendered = renderRecallRecord(entry, index)
  return { ...rendered, snippet: hit.snippet }
}

function expandResult(
  expand: readonly RecallEntryReference[],
  indexByEntryId: Map<string, number>,
  entryById: Map<string, RecallEntry>,
  offset: number,
  limit: number,
): RecallResult {
  const entryByIndex = new Map<number, RecallEntry>()
  for (const [entryId, index] of indexByEntryId) {
    const entry = entryById.get(entryId)
    if (entry) entryByIndex.set(index, entry)
  }
  const invalidExpand: Array<number | string> = []
  const hits: RecallHit[] = []
  for (const requested of expand) {
    const entry = typeof requested === "number"
      ? (Number.isInteger(requested) ? entryByIndex.get(requested) : undefined)
      : entryById.get(requested)
    if (entry === undefined) invalidExpand.push(requested)
    else {
      const entryId = sourceIdentity(entry)
      const index = indexByEntryId.get(entryId)
      if (index === undefined) throw new Error(`recall: scoped entry ${entryId} has no numeric coordinate`)
      hits.push(expandedRecallRecord(entry, index, offset, Math.min(limit, RECALL_READ_MAX_LIMIT)))
    }
  }
  return invalidExpand.length > 0 ? { hits, invalidExpand } : { hits }
}

function renderRecallRecord(entry: RecallEntry, index: number): RecallHit {
  if (entry.kind !== "degraded") return renderRecallEntry(entry, index)
  return { index, entryId: sourceIdentity(entry), role: "degraded", summary: entry.block.notice }
}

function expandedRecallRecord(entry: RecallEntry, index: number, offset: number, limit: number): RecallHit {
  const text = entry.kind === "degraded" ? entry.block.notice : renderRecallEntryText(entry)
  const end = Math.min(text.length, offset + limit)
  const reference = renderRecallRecord(entry, index)
  return {
    index,
    entryId: reference.entryId,
    role: reference.role,
    ...(reference.files ? { files: reference.files } : {}),
    text: text.slice(offset, end),
    offset,
    totalLength: text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
  }
}

/** FTS5 MATCH contract: split the query on whitespace and OR-join each word as
 *  an FTS5 string literal, with every `"` doubled. FTS5 runs a string literal
 *  through the table tokenizer (`porter unicode61`) as a phrase, so a word that
 *  holds punctuation matches the content it names: "3.11" matches the terms
 *  3 + 11, "feature-flag" matches feature + flag, and an operator word such as
 *  OR is a plain term. Punctuation and operator words thus cannot make the
 *  result an FTS5 syntax error. A blank
 *  query yields an empty string, which FTS5 rejects, so a caller must not
 *  search with it. */
export function buildFtsMatch(query: string): string {
  return query
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `"${word.replace(/"/g, '""')}"`)
    .join(" OR ")
}
interface StringMap<T> { [key: string]: T }
