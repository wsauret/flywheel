import { createHash } from "node:crypto"
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
  /** The entry's text, without its attachments. */
  readonly text: string
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
          newestFirst.push({ entryId: entry.id, text: entryText(entry), turnsBack: turn })
          turnHasPerson = true
        }
      }
      return closed
    },
    refs: () => newestFirst.toReversed(),
  }
}

function entryText(entry: PersonEntry): string {
  const { content } = entry.message
  if (typeof content === "string") return content
  const first = content[0]
  return first?.type === "text" ? first.text : ""
}

/** The first line of a text with content, for a short mention of a message or passage. */
export function firstLineOf(text: string): string {
  return text.trim().split("\n", 1)[0] ?? ""
}

/** Collapses each run of whitespace to one space and trims, and answers for each character of the result the index
 *  of its source character. */
function collapseWhitespace(text: string) {
  let collapsed = ""
  const sourceIndex: number[] = []
  let pendingSpace = -1
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ""
    if (/\s/.test(char)) {
      if (pendingSpace < 0 && collapsed.length > 0) pendingSpace = index
      continue
    }
    if (pendingSpace >= 0) {
      collapsed += " "
      sourceIndex.push(pendingSpace)
      pendingSpace = -1
    }
    collapsed += char
    sourceIndex.push(index)
  }
  return { collapsed, sourceIndex }
}

/** The passages of a split request as the person wrote them (ARCH-SESSIONS-051). Each passage must occur word for
 *  word in the texts, read as one text in their order; the comparison collapses each run of whitespace to one space,
 *  so a line break that a model copied as a space still matches. Answers the person's own text of each passage, in
 *  the order given, or a refusal that names the first passage that is empty or that the texts do not hold. */
export function locatePassages(texts: readonly string[], passages: readonly string[]): { readonly ok: true; readonly passages: readonly string[] } | { readonly ok: false; readonly reason: string } {
  const source = texts.join("\n")
  const { collapsed, sourceIndex } = collapseWhitespace(source)
  const located: string[] = []
  for (const passage of passages) {
    const wanted = collapseWhitespace(passage).collapsed
    const at = wanted ? collapsed.indexOf(wanted) : -1
    const start = sourceIndex[at]
    const last = sourceIndex[at + wanted.length - 1]
    if (start === undefined || last === undefined) {
      return { ok: false, reason: wanted ? `the part "${passage}" is not in the person's messages word for word: copy each part exactly from them` : "a part is empty" }
    }
    located.push(source.slice(start, last + 1))
  }
  return { ok: true, passages: located }
}

/** A short hash that names one split of a request: the same passages give the same hash, also when a model copies
 *  their whitespace differently. */
export function passagesHash(passages: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(passages.map((passage) => collapseWhitespace(passage).collapsed))).digest("hex").slice(0, 16)
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
