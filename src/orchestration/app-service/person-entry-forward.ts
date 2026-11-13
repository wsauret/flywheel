import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { ChatInput } from "../../infra/chat-input.js"
import { readConversationTail } from "../session/chat-session-run-evidence.js"
import { isPersonEntry, personEntryInput, personEntrySelection, type PersonEntry, type PersonEntryRef } from "../session/conversation/person-entries.js"
import type { SendChatOutcome } from "./runtime-supervisor-types.js"

export type ForwardOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface PersonEntryForward {
  /** The person's entries of the newest turn of a chat and of `earlierTurns`
   *  earlier turns that hold one, oldest first (`personEntrySelection`).
   *  Reads the newest entry batches only, so the cost follows the turns
   *  asked. Rejects for a chat that does not exist or a tail that this
   *  release cannot read. */
  personEntries(sessionId: string, earlierTurns: number): Promise<readonly PersonEntryRef[]>
  /** Commits a copy of each named person entry of the source chat in the
   *  target chat, in the order named, as that person's message with the
   *  stored content of its source. A copy is recorded under the entry id
   *  `person:forward:<source entry id>`, so a repeated forward of one entry
   *  to one chat commits nothing again (ARCH-SESSIONS-030, ARCH-SESSIONS-051).
   *  Refuses, before it commits anything, a source or target that is not an
   *  existing chat, an unreadable source, and an id that is not a person
   *  entry of the source. */
  forwardPersonEntries(input: { readonly sourceSessionId: string; readonly entryIds: readonly string[]; readonly targetSessionId: string }): Promise<ForwardOutcome>
}

export function createPersonEntryForward(deps: {
  readonly reader: AsyncEventStateReadSurface
  /** The conversation of a chat, or nothing for a session that is no chat. */
  readonly conversationOf: (sessionId: string) => Promise<string | undefined>
  readonly sendChat: (sessionId: string, input: ChatInput) => Promise<SendChatOutcome>
}): PersonEntryForward {
  async function personEntries(sessionId: string, earlierTurns: number): Promise<readonly PersonEntryRef[]> {
    const conversationId = await deps.conversationOf(sessionId)
    if (conversationId === undefined) throw new Error(`Chat ${sessionId} does not exist`)
    const selection = personEntrySelection(earlierTurns)
    if (await readConversationTail(deps.reader, conversationId, (batch) => selection.feed(batch)) === undefined) throw new Error(`The conversation of chat ${sessionId} cannot be read`)
    return selection.refs()
  }

  async function forwardPersonEntries({ sourceSessionId, entryIds, targetSessionId }: Parameters<PersonEntryForward["forwardPersonEntries"]>[0]): Promise<ForwardOutcome> {
    const sourceConversation = await deps.conversationOf(sourceSessionId)
    if (sourceConversation === undefined) return { ok: false, reason: `Chat ${sourceSessionId} does not exist` }
    if (await deps.conversationOf(targetSessionId) === undefined) return { ok: false, reason: `Chat ${targetSessionId} does not exist` }
    const wanted = new Set(entryIds)
    const found = new Map<string, PersonEntry>()
    let other: string | undefined
    const tail = await readConversationTail(deps.reader, sourceConversation, (batch) => {
      for (const entry of batch) {
        if (!wanted.has(entry.id)) continue
        if (isPersonEntry(entry)) found.set(entry.id, entry)
        else other = entry.id
      }
      return other !== undefined || found.size === wanted.size
    })
    if (tail === undefined) return { ok: false, reason: `The conversation of chat ${sourceSessionId} cannot be read` }
    const missing = other ?? entryIds.find((id) => !found.has(id))
    if (missing !== undefined) return { ok: false, reason: `Entry ${missing} is not a message of the person in chat ${sourceSessionId}` }
    for (const id of entryIds) {
      const entry = found.get(id)
      if (entry === undefined) continue
      const sent = await deps.sendChat(targetSessionId, { ...personEntryInput(entry), submissionIds: [`forward:${id}`] })
      if (!sent.ok) return sent
    }
    return { ok: true }
  }

  return { personEntries, forwardPersonEntries }
}
