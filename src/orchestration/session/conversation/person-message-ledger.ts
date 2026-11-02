import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../../infra/event-store-types.js"
import { normalizeChatInput, type ChatInputLike } from "../../../infra/chat-input.js"
import { Log } from "../../../infra/log.js"
import { workflowContextRecordsAddendum } from "../../../workflows/context-bundle/context-projection.js"
import { ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND } from "./addressed-workflow-messages.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND, RETAINED_INPUT_GAP_IN_FLIGHT_KIND } from "./queued-user-inputs.js"
import { conversationHoldsEntries } from "./session-message-entries.js"
import { owningChat } from "../composer-returns.js"
import { returnedInputNoticeId } from "../../../protocol/composer-returns.js"

/** Where the ledger already holds a person's message: an entry of the
 *  conversation, a held cell that the next save point or reader commits,
 *  or, for a workflow, the record of a request addendum that a commit made
 *  of the message before it retired the cell.
 *
 *  A client sends a person's message again under the same submission
 *  identity when its connection ended before the runtime answered
 *  (ARCH-SESSIONS-030). Every path that records a person's message reads this first,
 *  before any refusal or side effect, and a message the ledger holds is a
 *  receipt that records nothing. The conversation and its held cells stay
 *  the only record; this is a read of them, not a second one (ARCH-SUBSTRATE-038). */
export type PersonMessageRecord = "entry" | "cell" | "addendum" | "returned"

const log = Log.create({ service: "person-message-ledger" })

/** Where one conversation of `sessionId` holds the person's message keyed
 *  `key`, if it does. A retained gap is a held cell that a conversion set
 *  aside under its key, so it counts as a held cell too. */
export async function conversationPersonMessage(reader: AsyncEventStateReadSurface, place: { readonly sessionId: string; readonly conversationId: string; readonly kind: "chat" | "subagent" | "workflow-agent" }, key: string): Promise<PersonMessageRecord | undefined> {
  if ((await conversationHoldsEntries(reader, place.conversationId, [key])).has(key)) return "entry"
  if (await holdsCell(reader, place.sessionId, [QUEUED_USER_INPUT_IN_FLIGHT_KIND, RETAINED_INPUT_GAP_IN_FLIGHT_KIND], key)) return "cell"
  if (place.kind !== "subagent") return undefined
  const parent = await owningChat(reader, place.sessionId)
  const noticeId = returnedInputNoticeId(place.sessionId, key)
  return parent && parent.id !== place.sessionId && (await conversationHoldsEntries(reader, parent.conversationId, [noticeId])).has(noticeId) ? "returned" : undefined
}

/** Where a workflow holds the person's message keyed `key`, if it does: its
 *  held cell, or the addendum its context recorded. The agent that read the
 *  message live holds an entry too, but the cell or the addendum always
 *  exists beside that entry, so this reads no agent's conversation. */
export async function workflowPersonMessage(reader: AsyncEventStateReadSurface, workflowId: string, key: string): Promise<PersonMessageRecord | undefined> {
  if (await holdsCell(reader, workflowId, [ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, QUEUED_USER_INPUT_IN_FLIGHT_KIND], key)) return "cell"
  return await workflowContextRecordsAddendum(reader, workflowId, key) ? "addendum" : undefined
}

/** Holds a person's message under `key` in a cell of `kind` only while no
 *  cell of that kind holds it, in one guarded write. Two copies that arrive
 *  together so put one cell. A copy that a commit already recorded finds
 *  that record in `recorded`, which runs after the write. Every path records
 *  the message before it retires the cell: a chat or child commit records
 *  the entry and retires the cell in one transaction, and a workflow commit
 *  records the addendum first and retires the addressed cell in a later
 *  write (`src/workflows/vm/host-commit-controller.ts`). So a copy that finds
 *  no record found the cell before its retirement, the guarded write
 *  refused, and the answer is `cell`. When it finds a record, the cell this
 *  write put is a second one and goes again.
 *
 *  Accepted risk: between that write and its removal, a reader that adopts
 *  held cells, such as a child that starts, can take the second cell for a
 *  key the conversation already holds and record the message again. The
 *  window is one read long and needs a copy sent again at the same moment.
 *
 *  Answers `held`, the record that holds the message instead, or null when
 *  the store cannot hold in-flight state. */
export async function holdPersonMessageOnce(
  writer: AsyncEventWriter,
  hold: { readonly sessionId: string; readonly kind: string; readonly key: string; readonly payload: unknown },
  recorded: () => Promise<PersonMessageRecord | undefined>,
): Promise<"held" | PersonMessageRecord | null> {
  if (!writer.swapInFlight) return null
  if (!await writer.swapInFlight(hold.sessionId, hold.kind, hold.key, null, hold.payload)) return "cell"
  const record = await recorded()
  if (record === undefined) return "held"
  await writer.dropInFlight?.(hold.sessionId, hold.kind, hold.key)
  return record
}

/** One record per message that a resend found in the ledger. It names the
 *  submission and where the ledger holds it, never the words. */
export function recordPersonMessageReceipt(sessionId: string | null, input: ChatInputLike, where: PersonMessageRecord): readonly string[] {
  const submissionIds = normalizeChatInput(input).submissionIds ?? []
  log.info("person message already recorded", { sessionId, submissionId: submissionIds[0], where })
  return submissionIds
}

async function holdsCell(reader: AsyncEventStateReadSurface, sessionId: string, kinds: readonly string[], key: string): Promise<boolean> {
  return (await reader.readInFlight(sessionId, kinds, key)).some((row) => row.key === key)
}
