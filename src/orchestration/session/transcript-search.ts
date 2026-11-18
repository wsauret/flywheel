import type { Database } from "bun:sqlite"
import type { ConversationSearchIndex } from "../../infra/conversation-fts.js"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js"

import { countTranscriptIndex, indexedToolUseId, rankConversationsByBestMessage, searchTranscriptIndex, type TranscriptIndexHit } from "../../infra/conversation-recall-search.js"
import type { ChatSearchRequest, ChatSearchResult, FoundChat, TranscriptSearchHit, TranscriptSearchRequest, TranscriptSearchResult } from "../../protocol/transcript-protocol-types.js"
import type { ReplayedSession } from "./schemas.js"
import { contentSearchable } from "../../protocol/client/chat-content-search.js"
import { buildFtsMatch, typedWordIsPrefix } from "./conversation-recall.js"
import { parseConversationCheckpointFact } from "./conversation-checkpoint-facts.js"
import { parseConversationTreeFact } from "./conversation/conversation-facts.js"

/** Transcript search for people, over the same index the agent's recall tool
 *  reads: every committed chat entry of every session in the project, kept
 *  current on the one writer seam. A hit names the session and the entry
 *  that produced its block, so a client can open the transcript there. */

const TRANSCRIPT_SEARCH_PAGE_SIZE = 20
/** The most chats that one chat search answers: one screen of a session list. */
const CHAT_SEARCH_LIMIT = 20
/** The entry batches of a found chat that one read takes, newest first, while its final message is looked for. */
const CHAT_SEARCH_TAIL_BATCHES = 8
const EXCERPT_CHARS = 300

export interface TranscriptSearchService {
  search(request: TranscriptSearchRequest): Promise<TranscriptSearchResult>
  /** The root chats with a message that holds every keyword of the request (`rankConversationsByBestMessage`), each
   *  with the time of its newest entry, and an excerpt of where it stands. Work is bounded by the answer: one
   *  index catch-up, one ranked query, and two reads of the newest facts of the answered chats; an answered chat with
   *  no checkpoint and no final message in its newest batches pages back through its own history to its newest one.
   *  A query that is not `contentSearchable` only brings the index current and answers no chats, so a client sends
   *  one as its session list opens. Once `signal` aborts, the search stops at its next stage and rejects with the
   *  abort; a stage that runs finishes first, because SQLite here cannot stop a statement that runs. */
  findChats(request: ChatSearchRequest, signal?: AbortSignal): Promise<ChatSearchResult>
}

interface TranscriptSearchSession {
  readonly id: string
  readonly conversationId: string
  readonly name?: string
  readonly kind: ReplayedSession["kind"]
}

interface TranscriptSearchDeps {
  readonly index: Pick<ConversationSearchIndex, "through">
  readonly source: AsyncEventStateReadSurface
  /** The project's sessions, read per search so a session created since the
   *  last one is searchable at once. */
  readonly sessions: () => Promise<readonly TranscriptSearchSession[]>
}

/** The sessions of a metadata catalog that a search reads: every session with a conversation. */
export function searchableSessions(sessions: readonly { readonly id: string; readonly data: ReplayedSession }[]): TranscriptSearchSession[] {
  return sessions.flatMap(({ id, data }) => data.kind !== "workflow"
    ? [{ id, conversationId: data.conversationId, kind: data.kind, ...(data.name === undefined ? {} : { name: data.name }) }]
    : [])
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

  async function findChats(request: ChatSearchRequest, signal?: AbortSignal): Promise<ChatSearchResult> {
    const upperPosition = await deps.source.capturePosition()
    if (!contentSearchable(request.query)) {
      await deps.index.through(upperPosition)
      return { chats: [] }
    }
    // The session list searches as the person types: every word must match, and the word being typed is a prefix
    // from its fourth letter.
    const match = buildFtsMatch(request.query, { typing: true })
    const excluded = new Set(request.exclude)
    // The catalog holds no deleted session, and every root chat, and only a root chat, has kind chat.
    const chats = new Map((await deps.sessions()).flatMap((row) => row.kind === "chat" && !excluded.has(row.id) ? [[row.conversationId, row] as const] : []))
    signal?.throwIfAborted()
    const connection = await deps.index.through(upperPosition)
    // The ranking holds the thread for up to a second. Searches that a person typed past queue behind it, and each
    // one's withdrawal is a message that arrives only once the thread yields to its event loop, so the search yields
    // to it once before it ranks.
    if (signal !== undefined) await new Promise((resolve) => { setImmediate(resolve) })
    signal?.throwIfAborted()
    const terms = request.query.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 0)
    const found = rankConversationsByBestMessage(connection, { upperPosition, match, terms, lastTermIsPrefix: typedWordIsPrefix(request.query), conversationIds: new Set(chats.keys()), limit: CHAT_SEARCH_LIMIT })
      .flatMap((hit) => { const chat = chats.get(hit.conversationId); return chat ? [{ chat, entryId: hit.entryId, snippet: hit.snippet }] : [] })
    signal?.throwIfAborted()
    if (found.length === 0) return { chats: [] }
    const [checkpoints, tails] = await Promise.all([
      deps.source.readSlice({ aggregateIds: found.map(({ chat }) => `session:${chat.id}`), types: ["conversation.checkpoint.updated"], order: "desc", limitPerAggregate: 1, limit: found.length }, true),
      deps.source.readSlice({ aggregateIds: found.map(({ chat }) => `conversation:${chat.conversationId}`), types: ["chat.entries.appended"], order: "desc", limitPerAggregate: CHAT_SEARCH_TAIL_BATCHES, limit: found.length * CHAT_SEARCH_TAIL_BATCHES }, true),
    ])
    const states = checkpointStates(checkpoints.facts)
    const batches = Map.groupBy(tails.facts, (fact) => fact instanceof CorruptEventRowError ? fact.row.aggregateId : fact.aggregateId)
    return {
      chats: await Promise.all(found.map(async ({ chat, entryId, snippet }): Promise<FoundChat> => {
        const aggregateId = `conversation:${chat.conversationId}`
        const newest = batches.get(aggregateId) ?? []
        const lastActivityAt = newest.find((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError))?.timestamp
        const state = states.get(chat.conversationId)
        const final = state === undefined ? newestFinalText(newest) ?? await olderFinalText(aggregateId, newest, signal) : undefined
        const excerpt = state !== undefined ? { source: "checkpoint" as const, text: excerptOf(state) } : final !== undefined ? { source: "final" as const, text: excerptOf(final) } : undefined
        return { sessionId: chat.id, ...(lastActivityAt === undefined ? {} : { lastActivityAt }), entryId, snippet, ...(excerpt ? { excerpt } : {}) }
      })),
    }
  }

  /** The newest final message before `newest`, the chat's newest batches, read one bounded page at a time until one
   *  is found or the history ends. */
  async function olderFinalText(aggregateId: string, newest: readonly (StoredFact | CorruptEventRowError)[], signal: AbortSignal | undefined): Promise<string | undefined> {
    let page = newest
    while (page.length === CHAT_SEARCH_TAIL_BATCHES) {
      signal?.throwIfAborted()
      // SAFETY: the loop guard holds the page length at CHAT_SEARCH_TAIL_BATCHES, which is positive, so the last fact exists.
      const beforePosition = page[page.length - 1]!.position
      page = (await deps.source.readSlice({ aggregateId, types: ["chat.entries.appended"], order: "desc", beforePosition, limit: CHAT_SEARCH_TAIL_BATCHES }, true)).facts
      const final = newestFinalText(page)
      if (final !== undefined) return final
    }
    return undefined
  }

  return { search, findChats }
}

/** The current state of each conversation's newest checkpoint that states one. A fact that this release cannot read
 *  gives no excerpt. */
function checkpointStates(facts: readonly (StoredFact | CorruptEventRowError)[]): ReadonlyMap<string, string> {
  const states = new Map<string, string>()
  for (const fact of facts) {
    if (fact instanceof CorruptEventRowError) continue
    try {
      const { payload } = parseProjectionFact(fact, parseConversationCheckpointFact)
      if (payload.checkpoint.currentState.trim()) states.set(payload.conversationId, payload.checkpoint.currentState)
    } catch {
      continue
    }
  }
  return states
}

/** The text of the newest model message that calls no tool in these batches, newest batch first. A batch that this
 *  release cannot read is skipped. */
function newestFinalText(newestFirst: readonly (StoredFact | CorruptEventRowError)[]): string | undefined {
  for (const batch of newestFirst) {
    if (batch instanceof CorruptEventRowError) continue
    let fact
    try {
      fact = parseProjectionFact(batch, parseConversationTreeFact)
    } catch {
      continue
    }
    if (fact.type !== "chat.entries.appended") continue
    for (const entry of fact.payload.entries.toReversed()) {
      if (entry.kind !== "message" || entry.message.kind !== "assistant" || entry.displayOnly === true) continue
      const { content } = entry.message
      if (typeof content === "string") {
        if (content.trim()) return content
        continue
      }
      if (content.some((block) => block.type === "tool_use")) continue
      const text = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
      if (text.trim()) return text
    }
  }
  return undefined
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS).trimEnd()}...`
}

/** The id the transcript resolves to a block: the entry's own, except a tool
 *  result, whose block is the tool use it answers. */
function anchorEntryId(db: Database, hit: TranscriptIndexHit): string {
  if (hit.role !== "tool_result") return hit.entryId
  return indexedToolUseId(db, hit.conversationId, hit.entryId) ?? hit.entryId
}
