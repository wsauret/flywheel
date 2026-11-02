import { CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { StoredConversationEntry } from "./conversation/conversation-entry-schemas.js"
import type { ConversationEntry } from "./conversation/conversation-entry-types.js"
import { salvageConversationTreeFact } from "./conversation/conversation-facts.js"
import type { ReplayedSession } from "./schemas.js"

const log = Log.create({ service: "empty-chat" })

/** How many batches one read of the scan takes. The first batch of a chat
 *  with history holds the person's first message, so such a chat costs one
 *  read, and an empty chat has few batches or none. */
const SCAN_PAGE_BATCHES = 8

/** Whether a session is an empty chat: a chat that holds nothing of the
 *  person, with no name the person gave it and no message of the person in
 *  its conversation. The close of its tab and a stop that no client holds
 *  its project through remove an empty chat (PI-INTERACTION-075). The error of a runner
 *  that failed is not durable, so it keeps nothing. A message on any branch
 *  counts, so a branch change never makes a chat with a message empty. A
 *  session that is gone, or that is not a chat, is not an empty chat. */
export async function isEmptyChat(session: ReplayedSession | null, store: AsyncEventReadSurface): Promise<boolean> {
  return session?.kind === "chat" && session.userNamed !== true && !await conversationHoldsUserMessage(store, session.conversationId)
}

/** Reads the conversation's appended batches in order and stops at the first
 *  message of the person, so the answer never replays the conversation. A
 *  batch that the store cannot read counts as a message, because its bytes
 *  can hold one, and no rule removes bytes that no reader can read. */
async function conversationHoldsUserMessage(store: AsyncEventReadSurface, conversationId: string): Promise<boolean> {
  const aggregateId = `conversation:${conversationId}`
  const upperPosition = await store.capturePosition()
  let afterPosition = 0
  while (true) {
    const page = await store.readPage({ aggregateId, types: ["chat.entries.appended"], limit: SCAN_PAGE_BATCHES }, upperPosition, afterPosition, true)
    for (const batch of page.facts) {
      if (batch instanceof CorruptEventRowError) return unreadable(conversationId, batch.row.position)
      const reading = readBatch(batch)
      if (reading === "unreadable") return unreadable(conversationId, batch.position)
      if (reading === "message") return true
      afterPosition = batch.position
    }
    if (page.continuationPosition === null) return false
    afterPosition = page.continuationPosition
  }
}

function unreadable(conversationId: string, position: number): true {
  log.warn("a conversation batch that the empty-chat check cannot read keeps its chat", { conversationId, position })
  return true
}

/** Decodes one batch through the conversation's reviewed salvage, which
 *  the conversation's own projection also uses. */
function readBatch(batch: StoredFact): "message" | "none" | "unreadable" {
  const decoded = salvageConversationTreeFact({ type: batch.type, version: batch.version, actor: batch.actor, payload: batch.payload })
  switch (decoded.kind) {
    case "recovered":
      return decoded.fact.type === "chat.entries.appended" && decoded.fact.payload.entries.some(isUserMessage) ? "message" : "none"
    case "entries":
      if (decoded.items.some((item) => item.kind === "entry" && isUserMessage(item.entry))) return "message"
      return decoded.items.some((item) => item.kind === "degraded") ? "unreadable" : "none"
    case "degraded":
      return "unreadable"
  }
}

function isUserMessage(entry: ConversationEntry | StoredConversationEntry): boolean {
  return entry.kind === "message" && entry.message.kind === "user"
}
