import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { RequestAddendumMessage } from "../../workflows/context-bundle/context-facts.js"
import { readSessionMessageEntries, type SessionMessageEntry } from "../session/conversation/session-message-entries.js"

const log = Log.create({ service: "workflow-request-addenda" })

/** The messages that an agent of a workflow read from its parent session, in the
 *  order the agent's conversation recorded them. The read covers every entry
 *  of the conversation, on every branch and in every generation, because a
 *  context reset or a Resume does not unsay a parent's message.
 *
 *  An entry qualifies only when its producer is a session whose envelope
 *  names the relation "parent". A person's message, a message from a
 *  sibling or another session, a runtime notice (`origin: "system"`), and a
 *  historical `parent-agent` entry, which decodes with no envelope, never
 *  qualify. The key is the entry id, which is the cell key
 *  `msg:<sessionId>:<toolUseId>` of the delivery, so a replayed delivery
 *  keeps its key. A message with no text adds no direction, so it is not an
 *  addendum. An unreadable batch is skipped with a warning: the agent itself
 *  read it as a degraded gap. */
export async function readParentMessages(
  reader: AsyncEventStateReadSurface,
  conversationId: string,
): Promise<RequestAddendumMessage[]> {
  const { entries, unreadableBatches } = await readSessionMessageEntries(reader, conversationId)
  if (unreadableBatches > 0) log.warn("workflow agent conversation has unreadable entry batches; parent messages in them are not request addenda", { conversationId, unreadable: unreadableBatches })
  return entries.flatMap((entry) => parentMessage(entry) ?? [])
}

function parentMessage(entry: SessionMessageEntry): RequestAddendumMessage | null {
  const { message } = entry
  const { envelope } = message.producer
  if (message.origin === "system" || envelope.relation !== "parent") return null
  // A message from another session follows the `chatInputContent` layout:
  // its text alone, or its text block and then one block for each
  // attachment. Content in any other layout carries no text to add.
  const [first, ...attachments] = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
  if (first?.type !== "text" || first.text.length === 0) return null
  return {
    key: entry.id,
    source: { kind: "parent", name: envelope.name || message.producer.sessionId },
    text: first.text,
    ...(envelope.personWords === undefined ? {} : { personWords: envelope.personWords }),
    ...(attachments.length === 0 ? {} : { attachmentCount: attachments.length }),
  }
}
