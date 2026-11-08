import type { Database } from "bun:sqlite"
import type { ConversationSearchIndex } from "../../infra/conversation-fts.js"
import type { AsyncEventReadSurface } from "../../infra/event-store-types.js"

import { countTranscriptIndex, indexedToolUseId, searchTranscriptIndex, type TranscriptIndexHit } from "../../infra/conversation-recall-search.js"
import type { TranscriptSearchHit, TranscriptSearchRequest, TranscriptSearchResult } from "../../protocol/transcript-protocol-types.js"
import { buildFtsMatch } from "./conversation-recall.js"

/** Transcript search for people, over the same index the agent's recall tool
 *  reads: every committed chat entry of every session in the project, kept
 *  current on the one writer seam. A hit names the session and the entry
 *  that produced its block, so a client can open the transcript there. */

export const TRANSCRIPT_SEARCH_PAGE_SIZE = 20

export interface TranscriptSearchService {
  search(request: TranscriptSearchRequest): Promise<TranscriptSearchResult>
}

interface TranscriptSearchSession {
  readonly id: string
  readonly conversationId: string
  readonly name?: string
}

interface TranscriptSearchDeps {
  readonly index: Pick<ConversationSearchIndex, "through">
  readonly source: AsyncEventReadSurface
  /** The project's sessions, read per search so a session created since the
   *  last one is searchable at once. */
  readonly sessions: () => Promise<readonly TranscriptSearchSession[]>
}

function hitRole(role: string): TranscriptSearchHit["role"] {
  if (role === "user" || role === "assistant") return role
  if (role === "tool_result") return "tool"
  return "summary"
}

export function createTranscriptSearch(deps: TranscriptSearchDeps): TranscriptSearchService {
  const empty = (page: number): TranscriptSearchResult => ({ hits: [], total: 0, page, pageSize: TRANSCRIPT_SEARCH_PAGE_SIZE })

  async function search(request: TranscriptSearchRequest): Promise<TranscriptSearchResult> {
    const page = Math.max(1, Math.floor(request.page))
    const match = buildFtsMatch(request.query)
    if (match.length === 0) return empty(page)
    const upperPosition = await deps.source.capturePosition()
    const sessions = (await deps.sessions()).filter((row) => row.conversationId !== undefined)
    const byConversation = new Map(sessions.map((row) => [row.conversationId, row]))
    let conversationIds: ReadonlySet<string> | undefined
    if (request.sessionId !== undefined) {
      const conversationId = sessions.find((row) => row.id === request.sessionId)?.conversationId
      if (conversationId === undefined) return empty(page)
      conversationIds = new Set([conversationId])
    }
    const connection = await deps.index.through(upperPosition)
    const query = { upperPosition, match, ...(conversationIds ? { conversationIds } : {}), limit: TRANSCRIPT_SEARCH_PAGE_SIZE, offset: (page - 1) * TRANSCRIPT_SEARCH_PAGE_SIZE }
    const hits = searchTranscriptIndex(connection, query).flatMap((hit): TranscriptSearchHit[] => {
      const session = byConversation.get(hit.conversationId)
      // A conversation no session lists is one being deleted or a child the
      // catalog does not carry; nothing a person can open.
      if (!session) return []
      return [{
        sessionId: session.id,
        ...(session.name === undefined ? {} : { sessionTitle: session.name }),
        entryId: anchorEntryId(connection, hit),
        role: hitRole(hit.role),
        snippet: hit.snippet,
      }]
    })
    return { hits, total: countTranscriptIndex(connection, query), page, pageSize: TRANSCRIPT_SEARCH_PAGE_SIZE }
  }

  return { search }
}

/** The id the transcript resolves to a block: the entry's own, except a tool
 *  result, whose block is the tool use it answers. */
function anchorEntryId(db: Database, hit: TranscriptIndexHit): string {
  if (hit.role !== "tool_result") return hit.entryId
  return indexedToolUseId(db, hit.conversationId, hit.entryId) ?? hit.entryId
}
