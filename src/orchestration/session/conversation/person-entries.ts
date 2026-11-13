import type { ChatAttachment, ChatInput } from "../../../infra/chat-input.js"
import { attachmentMarker, nextAttachmentOrdinal } from "../../../protocol/client/attachments.js"
import type { StoredTailEntry } from "../chat-session-run-evidence.js"

/** A stored message that a person wrote: a user message with a human
 *  producer or a human origin. */
export type PersonEntry = StoredTailEntry & { readonly kind: "message"; readonly message: Extract<Extract<StoredTailEntry, { readonly kind: "message" }>["message"], { readonly kind: "user" }> }

/** One of the person's entries of a chat's newest turns. `turnsBack` is 0 for
 *  the newest turn, every entry after the newest turn end, and counts only
 *  the earlier turns that hold an entry of the person. */
export interface PersonEntryRef {
  readonly entryId: string
  readonly firstLine: string
  readonly turnsBack: number
}

export function isPersonEntry(entry: StoredTailEntry): entry is PersonEntry {
  return entry.kind === "message" && entry.message.kind === "user"
    && (entry.message.producer?.kind === "human" || entry.message.origin === "human")
}

/** An assistant entry with no tool call ends a turn. */
function endsTurn(entry: StoredTailEntry): boolean {
  if (entry.kind !== "message" || entry.message.kind !== "assistant") return false
  const content = entry.message.content
  return typeof content === "string" || !content.some((block) => block.type === "tool_use")
}

/** A selection that takes entry batches newest first. */
export interface PersonEntrySelection {
  /** Walks one batch backward; true once no older batch can add to the selection. */
  feed(batch: readonly StoredTailEntry[]): boolean
  /** The selection so far, oldest first. */
  refs(): readonly PersonEntryRef[]
}

/** Selects the person's entries of the newest turn and of `earlierTurns`
 *  earlier turns from entry batches that arrive newest first, as
 *  `readConversationTail` hands them on. `feed` walks one batch backward and
 *  answers whether the selection is closed, so no older batch can add to it.
 *  `refs` is the selection so far, oldest first. */
export function personEntrySelection(earlierTurns: number): PersonEntrySelection {
  const newestFirst: PersonEntryRef[] = []
  let turn = 0
  let turnHasPerson = false
  let newestEnded = false
  let closed = false
  return {
    feed(batch) {
      for (let index = batch.length - 1; index >= 0 && !closed; index -= 1) {
        const entry = batch[index]
        if (entry === undefined) continue
        // The newest turn counts also with no entry of the person, as a turn
        // that a notice started. An earlier end met before its turn holds an
        // entry of the person closes a turn that is not counted, such as a
        // reply to a notice.
        if (endsTurn(entry)) {
          if (!turnHasPerson && newestEnded) continue
          newestEnded = true
          if (turn >= earlierTurns) closed = true
          else turn += 1
          turnHasPerson = false
        } else if (isPersonEntry(entry)) {
          newestFirst.push({ entryId: entry.id, firstLine: firstLine(entry), turnsBack: turn })
          turnHasPerson = true
        }
      }
      return closed
    },
    refs: () => newestFirst.toReversed(),
  }
}

function firstLine(entry: PersonEntry): string {
  const { content } = entry.message
  const first = typeof content === "string" ? undefined : content[0]
  const text = typeof content === "string" ? content : first?.type === "text" ? first.text : ""
  return text.trim().split("\n", 1)[0] ?? ""
}

// A file name can hold a newline: the web client stores `File.name` as it is.
const MARKER = /\[(?:Image #\d+|File #\d+(?: [^\]]*)?)\]/g
const TEXT_ATTACHMENT = /^<attachment name="([\s\S]*?)" type="([^"\n]*)">\n([\s\S]*)\n<\/attachment>$/

/** The `ChatInput` whose `chatInputContent` is the stored content of one
 *  person entry, byte for byte: the inverse of the one writer of that
 *  content. The first block is the text, and each later block one
 *  attachment, in order. The attachment at position k takes the marker at
 *  position k of the text; past the text's markers, it takes a new marker
 *  of its kind with the next free number. The input keeps the entry's
 *  invocation and carries no producer or submission. Throws for a block
 *  that the writer never stores in a person entry. */
export function personEntryInput(entry: PersonEntry): ChatInput {
  const { content, invocation } = entry.message
  const shown = invocation === undefined ? {} : { invocation: { label: invocation.label, ...(invocation.args === undefined ? {} : { args: invocation.args }) } }
  if (typeof content === "string") return { text: content, ...shown }
  const [first, ...rest] = content
  if (first?.type !== "text") throw new Error(`Entry ${entry.id} does not start with its text`)
  const markers = [...first.text.matchAll(MARKER)].map((match) => match[0])
  const used = [...markers]
  const attachments = rest.map((block, position): ChatAttachment => {
    const markerAt = (kind: "image" | "text", name?: string): string => {
      const existing = markers[position]
      if (existing !== undefined) return existing
      const made = attachmentMarker(kind, nextAttachmentOrdinal(used), name)
      used.push(made)
      return made
    }
    if (block.type === "image") return { marker: markerAt("image"), mediaType: block.mediaType, data: block.data }
    const file = block.type === "text" ? TEXT_ATTACHMENT.exec(block.text) : null
    if (!file) throw new Error(`Entry ${entry.id} holds a ${block.type} block that a person's message does not hold`)
    const [, name = "", mediaType = "", body = ""] = file
    return { marker: markerAt("text", name), mediaType, name, data: Buffer.from(body, "utf8").toString("base64") }
  })
  return { text: first.text, ...(attachments.length > 0 ? { attachments } : {}), ...shown }
}
