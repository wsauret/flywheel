import type { Database } from "bun:sqlite"
import { CONVERSATION_FTS_TABLE } from "./conversation-fts.js"

/** The tokens of a ranked conversation's snippet. A session list shows it on one line, so the window stays short and
 *  FTS5 places the match a few tokens from its start; a 32-token window put a late match past the line's end. */
const CONVERSATION_SNIPPET_TOKENS = 10

export interface RecallSearchHit {
  entryId: string
  entryKind: string
  role: string
  snippet: string
  /** BM25 rank from FTS5; lower (more negative) is more relevant. */
  rank: number
}

export interface RecallSearchQuery {
  /** Inclusive primary snapshot ceiling, shared by page and count. */
  upperPosition: number
  conversationId: string
  /** FTS5 MATCH expression that the caller built with buildFtsMatch (see its
   *  FTS5 MATCH contract); this module runs it as given. */
  match: string
  /** When set, restrict to these entry ids (the active-branch lineage scope).
   *  When undefined, search the whole conversation (scope:all). */
  entryIds?: ReadonlySet<string>
  /** Top-K to retrieve. The caller derives this from its page count; this
   *  module owns NO page-size magic number. */
  limit: number
  offset?: number
}

interface RecallSearchSqlRow {
  entry_id: string
  entry_kind: string
  role: string
  snippet: string
  rank: number
}

interface SqlParameters {
  [name: string]: string | number
}
// Builds the scope predicate (conversation + optional lineage allowlist) shared
// by the page-window search and the total-count query, so both range over
// exactly the same rows - the count is the true total the search would page
// through, never a per-page-capped approximation.
interface ScopePredicate {
  clause: string
  params: SqlParameters
}

/** One hit from the whole index, with the conversation it came from. */
export interface TranscriptIndexHit extends RecallSearchHit {
  conversationId: string
}

export interface TranscriptIndexQuery {
  upperPosition: number
  /** FTS5 MATCH expression, built by the caller as for recall. */
  match: string
  /** The conversations to search; undefined searches every conversation in
   *  the store, which is every session of the project. */
  conversationIds?: ReadonlySet<string>
  limit: number
  offset?: number
}

function buildConversationsPredicate(conversationIds: ReadonlySet<string> | undefined): ScopePredicate | null {
  if (!conversationIds) return { clause: "", params: {} }
  const ids = [...conversationIds]
  if (ids.length === 0) return null
  const params: SqlParameters = {}
  for (const [i, id] of ids.entries()) params[`$c${i}`] = id
  return { clause: ` and conversation_id in (${ids.map((_, i) => `$c${i}`).join(", ")})`, params }
}

/** Ranked hits across one or every conversation: the same MATCH, ranking,
 *  and snippet as recall, scoped by conversation rather than by lineage. */
export function searchTranscriptIndex(db: Database, query: TranscriptIndexQuery): TranscriptIndexHit[] {
  const scope = buildConversationsPredicate(query.conversationIds)
  if (!scope) return []
  const sql = `
    select conversation_id, entry_id, entry_kind, role,
      snippet(${CONVERSATION_FTS_TABLE}, 0, '[', ']', '...', 32) as snippet,
      bm25(${CONVERSATION_FTS_TABLE}) as rank
    from ${CONVERSATION_FTS_TABLE}
    where ${CONVERSATION_FTS_TABLE} match $match${scope.clause} and source_position <= $upperPosition
    order by rank
    limit $limit offset $offset
  `
  return db.query<RecallSearchSqlRow & { conversation_id: string }, [SqlParameters]>(sql)
    .all({ ...scope.params, $match: query.match, $upperPosition: query.upperPosition, $limit: query.limit, $offset: query.offset ?? 0 })
    .map((r) => ({ conversationId: r.conversation_id, entryId: r.entry_id, entryKind: r.entry_kind, role: r.role, snippet: r.snippet, rank: r.rank }))
}

/** Which conversations to rank and how many to answer. */
export interface ConversationRankQuery {
  upperPosition: number
  /** FTS5 MATCH expression, built by the caller as for recall. */
  match: string
  /** The conversations that may rank; a hit in any other is dropped. */
  conversationIds: ReadonlySet<string>
  limit: number
}

/** The conversations whose messages best match, best first, each with its best hit: only the person's and the
 *  model's messages rank, never tool results or summaries. A conversation ranks by the BM25 rank of its best message
 *  alone, so a long conversation gains nothing from many weak hits. FTS5 refuses bm25() under an aggregate, so the
 *  grouping happens here: the hits stream in rank order and stop at the `limit`-th conversation. The ranked query
 *  selects the rowid alone, because a column that a filter or the sort reads is read for every hit, and a common word
 *  in a large project matches about 500,000 rows (22 s to filter in SQL, about 1 s to rank). Only the hits that the
 *  stream reaches read their columns, and only the answered hits read a snippet. */
export function rankConversationsByBestMessage(db: Database, query: ConversationRankQuery): TranscriptIndexHit[] {
  const ranked = db.query<{ rowid: number }, [SqlParameters]>(
    `select rowid from ${CONVERSATION_FTS_TABLE} where ${CONVERSATION_FTS_TABLE} match $match order by rank`,
  )
  const columns = db.query<{ conversation_id: string; role: string; source_position: number }, [SqlParameters]>(
    `select conversation_id, role, source_position from ${CONVERSATION_FTS_TABLE} where rowid = $rowid`,
  )
  const best = new Map<string, number>()
  for (const { rowid } of ranked.iterate({ $match: query.match })) {
    const row = columns.get({ $rowid: rowid })
    if (row === null || (row.role !== "user" && row.role !== "assistant") || row.source_position > query.upperPosition) continue
    if (!query.conversationIds.has(row.conversation_id) || best.has(row.conversation_id)) continue
    best.set(row.conversation_id, rowid)
    if (best.size === query.limit) break
  }
  const snippet = db.query<RecallSearchSqlRow, [SqlParameters]>(`
    select entry_id, entry_kind, role, snippet(${CONVERSATION_FTS_TABLE}, 0, '[', ']', '...', ${CONVERSATION_SNIPPET_TOKENS}) as snippet, bm25(${CONVERSATION_FTS_TABLE}) as rank
    from ${CONVERSATION_FTS_TABLE}
    where ${CONVERSATION_FTS_TABLE} match $match and rowid = $rowid
  `)
  return [...best].flatMap(([conversationId, rowid]) => {
    const row = snippet.get({ $match: query.match, $rowid: rowid })
    return row ? [{ conversationId, entryId: row.entry_id, entryKind: row.entry_kind, role: row.role, snippet: row.snippet, rank: row.rank }] : []
  })
}

export function countTranscriptIndex(db: Database, query: TranscriptIndexQuery): number {
  const scope = buildConversationsPredicate(query.conversationIds)
  if (!scope) return 0
  const sql = `
    select count(*) as total
    from ${CONVERSATION_FTS_TABLE}
    where ${CONVERSATION_FTS_TABLE} match $match${scope.clause} and source_position <= $upperPosition
  `
  const row = db.query<{ total: number }, [SqlParameters]>(sql).get({ ...scope.params, $match: query.match, $upperPosition: query.upperPosition })
  return row?.total ?? 0
}

/** The tool use id a tool result row names: the index stores a result as
 *  `[toolUseId] text`, and the tool block a hit should land on is keyed by
 *  that id, not by the result entry's own. */
export function indexedToolUseId(db: Database, conversationId: string, entryId: string): string | undefined {
  const row = db.query<{ content: string }, [SqlParameters]>(
    `select content from ${CONVERSATION_FTS_TABLE} where conversation_id = $conversationId and entry_id = $entryId limit 1`,
  ).get({ $conversationId: conversationId, $entryId: entryId })
  return row?.content.match(/^\[([^\]]+)\]/)?.[1]
}

function buildScopePredicate(query: RecallSearchQuery): ScopePredicate | null {
  const params: SqlParameters = { $conversationId: query.conversationId }
  if (!query.entryIds) {
    return { clause: " and conversation_id = $conversationId", params }
  }
  const ids = [...query.entryIds]
  if (ids.length === 0) return null
  const placeholders = ids.map((_, i) => `$e${i}`).join(", ")
  for (const [i, id] of ids.entries()) params[`$e${i}`] = id
  return { clause: ` and conversation_id = $conversationId and entry_id in (${placeholders})`, params }
}

export function searchConversationRecall(db: Database, query: RecallSearchQuery): RecallSearchHit[] {
  // Named params throughout, matching the whole codebase (event-store-search.ts).
  // The lineage allowlist is pushed INTO the SQL so FTS5 ranks only in-scope
  // rows and `limit` cuts the in-scope top-K - a JS post-filter would drop
  // in-scope hits that ranked below the cut.
  const scope = buildScopePredicate(query)
  if (!scope) return []
  const sql = `
    select entry_id, entry_kind, role,
      snippet(${CONVERSATION_FTS_TABLE}, 0, '[', ']', '...', 32) as snippet,
      bm25(${CONVERSATION_FTS_TABLE}) as rank
    from ${CONVERSATION_FTS_TABLE}
    where ${CONVERSATION_FTS_TABLE} match $match${scope.clause} and source_position <= $upperPosition
    order by rank
    limit $limit offset $offset
  `
  return db.query<RecallSearchSqlRow, [SqlParameters]>(sql)
    .all({ ...scope.params, $match: query.match, $upperPosition: query.upperPosition, $limit: query.limit, $offset: query.offset ?? 0 })
    .map((r) => ({ entryId: r.entry_id, entryKind: r.entry_kind, role: r.role, snippet: r.snippet, rank: r.rank }))
}

// True total number of in-scope matches, independent of any page window. The
// session layer reports this as totalMatches so "N total" and totalPages reflect
// the real match count rather than a fetch-limit-capped slice. Ranges over the
// SAME scope predicate as searchConversationRecall, so the count is exactly the
// number of rows the search would page through.
export function countConversationRecall(db: Database, query: RecallSearchQuery): number {
  const scope = buildScopePredicate(query)
  if (!scope) return 0
  const sql = `
    select count(*) as total
    from ${CONVERSATION_FTS_TABLE}
    where ${CONVERSATION_FTS_TABLE} match $match${scope.clause} and source_position <= $upperPosition
  `
  const row = db.query<{ total: number }, [SqlParameters]>(sql).get({ ...scope.params, $match: query.match, $upperPosition: query.upperPosition })
  return row?.total ?? 0
}
