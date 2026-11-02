import { SQLiteError, type Database } from "bun:sqlite"
import { CONVERSATION_FTS_TABLE } from "./conversation-fts.js"

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
  /** FTS5 MATCH expression, already sanitized by the caller (the session layer
   *  builds it via buildFtsMatch; see the FTS5 MATCH contract). */
  match: string
  /** The agent's original raw query, used only for the quoted-phrase fallback
   *  when the sanitized `match` still throws an FTS5 syntax error. */
  rawQuery: string
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
  /** FTS5 MATCH expression, sanitized by the caller as for recall. */
  match: string
  rawQuery: string
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
  return runWithFtsFallback(db, query, scope, (match, params) =>
    db.query<RecallSearchSqlRow & { conversation_id: string }, [SqlParameters]>(sql)
      .all({ ...params, $match: match, $limit: query.limit, $offset: query.offset ?? 0 })
      .map((r) => ({ conversationId: r.conversation_id, entryId: r.entry_id, entryKind: r.entry_kind, role: r.role, snippet: r.snippet, rank: r.rank })))
}

export function countTranscriptIndex(db: Database, query: TranscriptIndexQuery): number {
  const scope = buildConversationsPredicate(query.conversationIds)
  if (!scope) return 0
  const sql = `
    select count(*) as total
    from ${CONVERSATION_FTS_TABLE}
    where ${CONVERSATION_FTS_TABLE} match $match${scope.clause} and source_position <= $upperPosition
  `
  return runWithFtsFallback(db, query, scope, (match, params) => {
    const row = db.query<{ total: number }, [SqlParameters]>(sql).get({ ...params, $match: match })
    return row?.total ?? 0
  })
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

// Runs `match` against the FTS table with the scope predicate, retrying the raw
// query as a single quoted phrase if the sanitized expression is FTS5-invalid.
// Both the page-window search and the count run through this so the
// quoted-phrase fallback is applied identically to each.
function runWithFtsFallback<T>(
  db: Database,
  query: { match: string; rawQuery: string; upperPosition: number },
  scope: ScopePredicate,
  run: (match: string, params: SqlParameters) => T,
): T {
  try {
    return run(query.match, { ...scope.params, $upperPosition: query.upperPosition })
  } catch (err) {
    // Repair-when-semantics-are-clear: a residual FTS5 MATCH parse error falls
    // back to the raw query as a single quoted phrase, which FTS5 always parses
    // literally. FTS5 surfaces parse failures under several SQLiteError messages
    // ("fts5: syntax error", "unterminated string", "unknown special query");
    // each is a MATCH-expression parse failure, so all repair the same way.
    // Re-throw anything that is not an FTS5 MATCH parse error.
    if (err instanceof SQLiteError && isFtsMatchParseError(err.message)) {
      return run(`"${query.rawQuery.replace(/"/g, '""')}"`, { ...scope.params, $upperPosition: query.upperPosition })
    }
    throw err
  }
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
  return runWithFtsFallback(db, query, scope, (match, params) =>
    db.query<RecallSearchSqlRow, [SqlParameters]>(sql)
      .all({ ...params, $match: match, $limit: query.limit, $offset: query.offset ?? 0 })
      .map((r) => ({ entryId: r.entry_id, entryKind: r.entry_kind, role: r.role, snippet: r.snippet, rank: r.rank })))
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
  return runWithFtsFallback(db, query, scope, (match, params) => {
    const row = db.query<{ total: number }, [SqlParameters]>(sql).get({ ...params, $match: match })
    return row?.total ?? 0
  })
}

function isFtsMatchParseError(message: string): boolean {
  return /fts5: syntax error|unterminated string|unknown special query/.test(message)
}
