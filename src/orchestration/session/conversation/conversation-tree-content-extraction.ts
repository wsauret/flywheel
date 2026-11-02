import { extractContent, type ToolContentRow } from "../../../infra/tool-content.js"
import type { StoredConversationEntry } from "./conversation-entry-schemas.js"
import { parseConversationTreeFact, type ConversationTreeFact } from "./conversation-facts.js"

export interface ExtractedTreeFact {
  readonly fact: ConversationTreeFact
  readonly contentRows: readonly ToolContentRow[]
}

/** Write-side extraction for the entry-carrying chat fact, the inverse of the
 *  fold's hydration: toolResult text parts over the inline threshold become
 *  reference parts. Current facts keep their version; historical
 *  version-1 facts advance to version 2 only when extraction produces
 *  references. */
export function extractTreeFactContent(fact: ConversationTreeFact): ExtractedTreeFact {
  if (fact.version === 2) return { fact, contentRows: [] }
  if (fact.type === "chat.entries.appended") {
    const rows: ToolContentRow[] = []
    const entries = fact.payload.entries.map((entry) => extractEntryContent(entry, rows))
    if (rows.length === 0) return { fact, contentRows: [] }
    return {
      fact: parseConversationTreeFact({ type: fact.type, version: fact.version === 1 ? 2 : fact.version, actor: fact.actor, payload: { conversationId: fact.payload.conversationId, entries } }),
      contentRows: dedupedRows(rows),
    }
  }
  return { fact, contentRows: [] }
}

function extractEntryContent(entry: StoredConversationEntry, rows: ToolContentRow[]): StoredConversationEntry {
  if (entry.kind !== "message" || entry.message.kind !== "toolResult") return entry
  let referenced = false
  const content = entry.message.content.map((part) => {
    if (part.type !== "text") return part
    const extracted = extractContent(part.text)
    if (extracted.kind === "inline") return part
    referenced = true
    rows.push(extracted.row)
    return { type: "text_reference" as const, ...extracted.reference }
  })
  if (!referenced) return entry
  return { ...entry, message: { ...entry.message, content } }
}

/** A batch can repeat one text (a retried tool, identical outputs). The
 *  (session_id, sha256) key makes duplicate inserts no-ops anyway; deduping
 *  keeps the append from carrying the bytes twice. */
function dedupedRows(rows: readonly ToolContentRow[]): readonly ToolContentRow[] {
  if (rows.length < 2) return rows
  return [...new Map(rows.map((row) => [row.sha256, row])).values()]
}
