import type { ComposerCheckpoint } from "./input-reload-checkpoint.js"
import type { SessionMemory } from "./session-residents.js"

type Draft = ComposerCheckpoint["active"]

/** Owns the new-chat draft and transfers inactive resident drafts on replacement.
 *  Transferred entries wait here only until their resident owner is available. */
export function createComposerDrafts(memory: (id: string) => SessionMemory | undefined, initialSessionId: string | undefined) {
  let sessionId = initialSessionId
  let newChat: Draft | undefined
  const visited = new Set<string>(sessionId === undefined ? [] : [sessionId])
  const transferred = new Map<string, Draft>()
  const read = (id: string): Draft | undefined => {
    const input = transferred.get(id) ?? memory(id)?.draft
    return input === undefined ? undefined : { text: input.text, attachments: input.attachments ?? [] }
  }
  const keep = (id: string | undefined, input: Draft | undefined) => {
    if (id === undefined) newChat = input
    else {
      visited.add(id)
      const resident = memory(id)
      if (resident !== undefined) { resident.draft = input; transferred.delete(id) }
      else if (input !== undefined) transferred.set(id, input)
      else transferred.delete(id)
    }
  }
  return {
    /** Removes accepted words from their source draft, including an inactive owner. */
    settle(source: string | undefined, acceptedText: string, active: Draft): Draft {
      const input = source === sessionId ? active : source === undefined ? newChat : read(source)
      if (!input?.text.startsWith(acceptedText)) return active
      const remaining = { ...input, text: input.text.slice(acceptedText.length) }
      if (source === sessionId) return remaining
      keep(source, remaining.text || remaining.attachments.length ? remaining : undefined)
      return active
    },
    /** Transfers only the source's unsent remainder, without selecting either session. */
    finish(source: string, parent: string, active: Draft) {
      const input = source === sessionId ? active : read(source)
      if (source === parent || !input || (!input.text && !input.attachments.length)) return { active, moved: false }
      const previous = parent === sessionId ? active : read(parent)
      const merged = { text: previous?.text ? `${previous.text}\n\n${input.text}` : input.text, attachments: [...previous?.attachments ?? [], ...input.attachments] }
      if (source !== sessionId) keep(source, undefined)
      if (parent !== sessionId) keep(parent, merged)
      return { active: parent === sessionId ? merged : source === sessionId ? { text: "", attachments: [] } : active, moved: true }
    },
    /** Appends to an inactive session without changing the selected draft. */
    append(id: string, input: Draft): void {
      const previous = read(id)
      keep(id, { text: previous?.text ? `${previous.text}\n\n${input.text}` : input.text, attachments: [...previous?.attachments ?? [], ...input.attachments] })
    },
    move(next: string | undefined, active: Draft, created: boolean): Draft | undefined {
      const previous = sessionId
      sessionId = next
      if (next !== undefined) visited.add(next)
      if (previous === undefined && created) { newChat = undefined; return active }
      keep(previous, active.text.length === 0 && active.attachments.length === 0 ? undefined : active)
      const input = next === undefined ? newChat : read(next)
      if (next !== undefined) transferred.delete(next)
      return input
    },
    capture(): Pick<ComposerCheckpoint, "sessionId" | "newChat" | "drafts"> {
      return {
        sessionId, newChat,
        drafts: Object.fromEntries([...visited].flatMap((id) => {
          const input = id === sessionId ? undefined : read(id)
          return input === undefined ? [] : [[id, input]]
        })),
      }
    },
    adopt(saved: ComposerCheckpoint): Draft | undefined {
      newChat = saved.newChat
      for (const [id, input] of Object.entries(saved.drafts)) keep(id, input)
      if (saved.sessionId === sessionId) return saved.active
      keep(saved.sessionId, saved.active)
      return sessionId === undefined ? newChat : read(sessionId)
    },
  }
}
