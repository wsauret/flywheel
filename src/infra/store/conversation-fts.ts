import { Database } from "bun:sqlite"
import { basename, dirname, resolve } from "node:path"
import { mkdirSync } from "node:fs"

import { CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "./event-store-types.js"
import { InvariantViolation } from "../invariant.js"
import { createOrderedLane, type OrderedLane } from "../ordered-lane.js"
import { isRecord } from "../record.js"
import { referencePartReference, resolveToolContentReference, type ContentResolver } from "../runtime-facts/tool-content.js"
import { admitPrivateDatabaseFiles, ensurePrivateDirectoryUnder, ensurePrivateFile } from "../private-path.js"
import { applySqliteDurabilityPragmas } from "../sqlite-durability.js"
import { DebugLog } from "../diagnostics/debug-log.js"

/** Columns the recall index carries. `conversation_id`, `entry_id`,
 *  `entry_kind`, and `role` are UNINDEXED filter/return columns; only `content`
 *  is tokenized for MATCH. Storing them UNINDEXED keeps them queryable in the
 *  same row without bloating the term index. */
export const CONVERSATION_FTS_TABLE = "conversation_recall_fts"

/** Maps each FTS row to the session whose fact produced it, so a deletion
 *  tombstone can remove rows indexed before the session was deleted. */
const SESSION_ROWS_TABLE = "conversation_index_session_rows"

function createConversationIndexTables(db: Database): void {
  db.exec(`
    create virtual table ${CONVERSATION_FTS_TABLE} using fts5(
      content,
      conversation_id unindexed,
      entry_id unindexed,
      entry_kind unindexed,
      role unindexed,
      source_position unindexed,
      tokenize = 'porter unicode61'
    )
  `)
  db.exec(`create table ${SESSION_ROWS_TABLE} (session_id text not null, row_id integer not null)`)
  db.exec(`create index ${SESSION_ROWS_TABLE}_session on ${SESSION_ROWS_TABLE} (session_id)`)
  db.exec("create table conversation_index_position (position integer not null)")
  db.exec("insert into conversation_index_position values (0)")
}

interface ConversationFtsRow {
  conversationId: string
  entryId: string
  entryKind: string
  role: string
  content: string
}
interface ContentBlock {
  readonly [key: string]: unknown
}

interface TextContentBlock extends ContentBlock {
  readonly text: string
}

// Maintains the derived index from committed primary pages.
// A malformed chat-entry shape here is a producer bug on Flywheel-owned data,
// so it throws the canonical InvariantViolation rather than dropping the row
// silently.
//
// Only COMMITTED `chat.entries.appended` entries are indexed. Provisional
// entries (`chat.entry.provisional`) are deliberately excluded: the projection
// discards them once the committed append supersedes them, so indexing a
// provisional row would orphan it in the FTS table and corrupt recall
// ranking/counts. This matches recall's own exclusion of provisional entries.
function indexChatEntriesForFts(db: Database, event: StoredFact, content: ContentResolver): void {
  if (event.type !== "chat.entries.appended") return
  const conversationId = event.payload.conversationId
  if (typeof conversationId !== "string") throw ftsViolation(event, `${event.type} payload missing conversationId`)
  const entries = event.payload.entries
  if (!Array.isArray(entries)) throw ftsViolation(event, `${event.type} payload entries is not an array`)
  const resolvePart = referencePartResolver(content, event)
  for (const entry of entries) {
    const row = ftsRowForEntry(event, conversationId, entry, resolvePart)
    if (row) indexConversationEntry(db, row, event.sessionId, event.position)
  }
}

type ReferencePartResolver = (part: ContentBlock) => string

function referencePartResolver(content: ContentResolver, event: StoredFact): ReferencePartResolver {
  return (part) => {
    const reference = referencePartReference(part)
    if (reference === undefined) throw ftsViolation(event, "chat entry tool-content reference part is malformed")
    return resolveToolContentReference(
      content,
      event.sessionId,
      reference,
      { eventType: event.type, eventPosition: event.position, aggregateId: event.aggregateId },
    )
  }
}

/** Index an entry in the derived page transaction. Conversation
 *  writers reject duplicate entry ids and guard the expected sequence before
 *  insertion; this derived index does not own deduplication. */
function indexConversationEntry(db: Database, row: ConversationFtsRow, sessionId: string, position: number): void {
  const { lastInsertRowid } = db.query(`insert into ${CONVERSATION_FTS_TABLE} (content, conversation_id, entry_id, entry_kind, role, source_position) values (?, ?, ?, ?, ?, ?)`)
    .run(row.content, row.conversationId, row.entryId, row.entryKind, row.role, position)
  db.query(`insert into ${SESSION_ROWS_TABLE} (session_id, row_id) values (?, ?)`).run(sessionId, lastInsertRowid)
}

/** Remove every row indexed for the deleted sessions. Idempotent, so a crash
 *  before the watermark passes the tombstone only repeats it. */
function removeDeletedSessions(db: Database, sessionIds: ReadonlySet<string>): void {
  if (sessionIds.size === 0) return
  const removeRows = db.query(`delete from ${CONVERSATION_FTS_TABLE} where rowid in (select row_id from ${SESSION_ROWS_TABLE} where session_id = ?)`)
  const removeMap = db.query(`delete from ${SESSION_ROWS_TABLE} where session_id = ?`)
  db.transaction(() => {
    for (const sessionId of sessionIds) {
      removeRows.run(sessionId)
      removeMap.run(sessionId)
    }
  }).immediate()
}

export interface ConversationSearchIndex {
  /** Catch up to the captured primary position, or reject without serving stale hits. */
  through(position: number): Promise<Database>
  /** Release this consumer after its searches finish. */
  dispose(): Promise<void>
}

const INDEX_GENERATION = 2
const INDEX_WRITE_BUSY_TIMEOUT_MS = 5_000
const indexOwners = new Map<string, { index: ReturnType<typeof createConversationSearchIndex>; holds: number; readonly replays: OrderedLane }>()

/** Share one lazy derived writer per execution owner. The final consumer closes
 * both handles after queued replay completes. This never opens primary SQLite.
 * `deletionFactTypes` names the fact types beyond `session.deleted` that
 * delete a session's conversation. The installed catalog fixes them per
 * process, so the first acquire of a file decides them for every holder. */
export function acquireConversationSearchIndex(dbFile: string, source: AsyncEventReadSurface, deletionFactTypes: readonly string[]): ConversationSearchIndex {
  const key = resolve(dbFile)
  let owner = indexOwners.get(key)
  if (!owner) {
    owner = { index: createConversationSearchIndex(key, source, deletionFactTypes), holds: 0, replays: createOrderedLane() }
    indexOwners.set(key, owner)
  }
  owner.holds++
  const held = owner
  let disposal: Promise<void> | undefined
  return {
    through(position) {
      return held.replays.run(() => held.index.through(position))
    },
    dispose() {
      disposal ??= (async () => {
        held.holds--
        await held.replays.settled()
        if (held.holds === 0 && indexOwners.get(key) === held) {
          indexOwners.delete(key)
          held.index.dispose()
        }
      })()
      return disposal
    },
  }
}

function createConversationSearchIndex(dbFile: string, source: AsyncEventReadSurface, deletionFactTypes: readonly string[]) {
  const deletionTypes = ["session.deleted", ...deletionFactTypes]
  let writer: Database | undefined
  let reader: Database | undefined

  function open(): Database {
    if (writer) return writer
    const parent = dirname(dbFile)
    mkdirSync(dirname(parent), { recursive: true })
    ensurePrivateDirectoryUnder(dirname(parent), basename(parent))
    admitPrivateDatabaseFiles(dbFile)
    ensurePrivateFile(dbFile)
    const db = new Database(dbFile)
    try {
      applySqliteDurabilityPragmas(db, INDEX_WRITE_BUSY_TIMEOUT_MS)
      const reset = db.transaction(() => {
        const generation = db.query<{ user_version: number }, []>("pragma user_version").get()?.user_version
        if (generation === INDEX_GENERATION) return false
        db.exec(`drop table if exists ${CONVERSATION_FTS_TABLE}; drop table if exists ${SESSION_ROWS_TABLE}; drop table if exists conversation_index_position`)
        createConversationIndexTables(db)
        db.exec(`pragma user_version = ${INDEX_GENERATION}`)
        return true
      }).immediate()
      // Dropped tables leave free pages in the file. VACUUM returns them, and
      // under WAL the main file shrinks only once the checkpoint copies back.
      if (reset) db.exec("vacuum; pragma wal_checkpoint(truncate)")
      reader = new Database(dbFile, { readonly: true })
      writer = db
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  async function replay(upper: number): Promise<void> {
    const db = open()
    const initialWatermark = db.query<{ position: number }, []>("select position from conversation_index_position").get()
    if (!initialWatermark) throw new Error("Conversation search index watermark is missing")
    const deletedSessionIds = new Set<string>()
    // Appends cannot follow deletion, so every deleted session that the index
    // still holds or has yet to index has its tombstone in this range.
    let deletionPosition = initialWatermark.position
    while (deletionPosition < upper) {
      const page = await source.readPage({ types: deletionTypes }, upper, deletionPosition)
      for (const fact of page.facts) {
        if (fact instanceof CorruptEventRowError) {
          // oxlint-disable-next-line eslint/no-throw-literal -- boundary: narrowed Error subclass
          throw fact
        }
        deletedSessionIds.add(fact.sessionId)
      }
      deletionPosition = page.continuationPosition ?? upper
    }
    removeDeletedSessions(db, deletedSessionIds)
    let position = initialWatermark.position
    while (position < upper) {
      const page = await source.readPage({ types: ["chat.entries.appended"] }, upper, position)
      const next = page.continuationPosition ?? upper
      const expectedPosition = position
      const facts = page.facts
      const toolContent = page.toolContent
      DebugLog.record({
        type: "conversation.fts.write",
        payload: {
          indexedThroughPosition: expectedPosition,
          pageThroughPosition: next,
          requestedThroughPosition: upper,
        },
      })
      position = db.transaction(() => {
        const watermark = db.query<{ position: number }, []>("select position from conversation_index_position").get()
        if (!watermark) throw new Error("Conversation search index watermark is missing")
        const current = watermark.position
        if (current !== expectedPosition) return current
        for (const fact of facts) {
          if (fact instanceof CorruptEventRowError) {
            // oxlint-disable-next-line eslint/no-throw-literal -- boundary: narrowed Error subclass
            throw fact
          }
          if (deletedSessionIds.has(fact.sessionId)) continue
          indexChatEntriesForFts(db, fact, toolContent)
        }
        db.query("update conversation_index_position set position = ?").run(next)
        return next
      }).immediate()
    }
  }

  return {
    async through(position: number) {
      await replay(position)
      // SAFETY: replay opens both handles before it can resolve.
      return reader!
    },
    dispose() {
      reader?.close()
      writer?.close()
    },
  }
}

function ftsViolation(event: StoredFact, detail: string): InvariantViolation {
  return new InvariantViolation({
    kind: "schema-mismatch",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail,
  })
}

function ftsRowForEntry(event: StoredFact, conversationId: string, entry: unknown, resolvePart: ReferencePartResolver): ConversationFtsRow | null {
  if (!isRecord(entry)) throw ftsViolation(event, "chat entry is not an object")
  const id = entry.id
  const kind = entry.kind
  if (typeof id !== "string" || typeof kind !== "string") throw ftsViolation(event, "chat entry missing id/kind")
  if (kind === "leaf" || kind === "label" || kind === "session_info") return null
  if (kind === "message") {
    if (entry.displayOnly === true) return null
    const rendered = renderMessageEntryForFts(entry.message, resolvePart)
    if (rendered === null) return null
    return { conversationId, entryId: id, entryKind: "message", role: rendered.role, content: rendered.text }
  }
  if (kind === "compaction" || kind === "branch_summary") {
    const summary = typeof entry.summary === "string" ? entry.summary : ""
    return { conversationId, entryId: id, entryKind: kind, role: kind, content: summary }
  }
  // MAINTENANCE INVARIANT: every SessionEntry kind must be handled above. A NEW
  // kind added to the chat-tree schema MUST be classified here (indexed with a
  // searchable projection, or explicitly skipped with `return null`) - this
  // throw is the tripwire that forces that decision rather than silently
  // dropping the kind from recall.
  throw ftsViolation(event, `unexpected chat entry kind ${kind}`)
}

// Flattens a persisted message to `{ role, text }` for the index over
// Flywheel's PersistedContentBlock shape. System / compactionSummary
// messages are not separately indexed (the compaction entry already indexes its
// summary), so they return null.
function renderMessageEntryForFts(message: unknown, resolvePart: ReferencePartResolver): { role: string; text: string } | null {
  if (!isRecord(message)) return null
  if (message.kind === "user") return { role: "user", text: ftsTextOf(message.content) }
  if (message.kind === "assistant") {
    const text = ftsTextOf(message.content)
    const tools = ftsToolCalls(message.content)
    const files = ftsFilesFromContent(message.content)
    const parts = [tools, text, ...files].filter((p) => p.length > 0)
    return { role: "assistant", text: parts.join("\n") }
  }
  if (message.kind === "toolResult") {
    const id = typeof message.toolUseId === "string" ? message.toolUseId : ""
    return { role: "tool_result", text: `[${id}] ${ftsToolResultText(message.content, resolvePart)}` }
  }
  return null
}

function ftsContentBlocks(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function ftsTextOf(content: unknown): string {
  if (typeof content === "string") return content
  return ftsContentBlocks(content)
    .filter((b): b is TextContentBlock => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
}

function ftsToolCalls(content: unknown): string {
  return ftsContentBlocks(content)
    .filter((b) => b.type === "tool_use")
    .map((b) => `${typeof b.name === "string" ? b.name : ""}(${ftsStringifyInput(b.input)})`)
    .join(", ")
}

function ftsFilesFromContent(content: unknown): string[] {
  return ftsContentBlocks(content)
    .filter((b) => b.type === "tool_use")
    .map((b) => ftsExtractPath(b.input))
    .filter((p): p is string => p !== null)
}

function ftsExtractPath(input: unknown): string | null {
  if (!isRecord(input)) return null
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const value = input[key]
    if (typeof value === "string") return value
  }
  return null
}

function ftsStringifyInput(input: unknown): string {
  if (!isRecord(input)) return ""
  const path = ftsExtractPath(input)
  if (path) return `path=${path}`
  if (typeof input.command === "string") return `command=${input.command}`
  if (typeof input.query === "string") return `query=${input.query}`
  return Object.keys(input).join(", ")
}

function ftsToolResultText(content: unknown, resolvePart: ReferencePartResolver): string {
  return ftsContentBlocks(content)
    .flatMap((b) => {
      if (b.type === "text" && typeof b.text === "string") return [b.text]
      if (b.type === "text_reference") return [resolvePart(b)]
      return []
    })
    .join("\n")
}
