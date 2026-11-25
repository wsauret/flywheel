import type { SessionRelation } from "./chat-input-schema.js"

/** One file that rides with a message: an image pasted or chosen on the
 *  sender's device, or a text file from it. `marker` is the text the message
 *  shows in its place, `[Image #1]` or `[File #1 report.csv]`; `name` is the
 *  file's own name when it had one, which a clipboard image does not. */
export interface ChatAttachment {
  readonly marker: string
  readonly mediaType: string
  /** The bytes, base64. */
  readonly data: string
  readonly name?: string
}

/** Display metadata for a slash-invoked inline step or skill. The input's
 *  `text` carries the full expanded prompt for the model; the transcript
 *  renders only a divider labeled `label` plus, when present,
 *  `args` (the user's raw argument text) as the visible user message. */
export interface ChatInvocation {
  readonly label: string
  readonly args?: string
}


/** What the recipient reads about a message besides its text: the sender as
 *  it was named when it sent, whether the sender waits for a reply, and the
 *  words of the person that the sender read since its last exchange with the
 *  recipient. The runtime sets every field at delivery; no field is markup,
 *  so the provider view of a stored message never changes. */
export interface SessionMessageEnvelope {
  readonly name: string
  readonly relation: SessionRelation
  readonly waits: boolean
  readonly personWords?: string
}

/** Another session that sent a message through a runtime-admitted action.
 *  The runtime sets every field from the sending tool call, so the model of
 *  the sender cannot claim another identity. */
export interface SessionInputProducer {
  readonly kind: "session"
  readonly sessionId: string
  readonly conversationId: string
  /** The tool call of the sender that admitted the message. */
  readonly toolUseId: string
  /** The wake hop of the turn that sent the message: the number of steps in
   *  the chain of session messages that led to that turn (`hopAfter`). */
  readonly hop: number
  /** Every message that `message_session` sends carries one. A message that
   *  a parent steered before session messages, or that a build before the
   *  message tool sent, has none and reads as plain text. */
  readonly envelope?: SessionMessageEnvelope
  /** Derived historical identity gap. Never grants a workflow an agent reply address. */
  readonly recovery?: { readonly workflowId: string; readonly reason: "unresolved" | "ambiguous" }
}

/** Who produced one accepted message: a person, or another session. */
export type UserInputProducer =
  | { readonly kind: "human" }
  | SessionInputProducer

/** The parent session whose launching tool call gave a subagent its
 *  assignment, named as it was at launch. The publication of the child sets
 *  it, so the assignment is never accepted input: it starts no wake chain,
 *  and the model reads it as plain text. */
interface LaunchProducer {
  readonly kind: "launch"
  readonly sessionId: string
  readonly toolUseId: string
  readonly name: string
}

/** Who produced one stored user-role message. */
export type MessageProducer = UserInputProducer | LaunchProducer

/** The same explicit identity gap is visible in provider context and transcript display. */
export function sessionMessageRecoveryNotice(producer: MessageProducer | undefined): string | undefined {
  return producer?.kind === "session" && producer.recovery
    ? `Historical workflow message from ${producer.recovery.workflowId} (${producer.recovery.reason}). The historical sender session cannot be resolved. No exact reply target is available.`
    : undefined
}

export interface ChatInput {
  readonly text: string
  readonly attachments?: readonly ChatAttachment[]
  readonly invocation?: ChatInvocation
  /** Client submissions represented by this input. They survive
   *  persistence and joins, and let a client replace its local row. A
   *  person's message with exactly one submission is also recorded under
   *  `person:<submission>`, so a copy that the client sends again after a
   *  lost answer is a receipt and records nothing (ARCH-SESSIONS-030). They never
   *  enter a provider message body. */
  readonly submissionIds?: readonly string[]
  /** In-flight recovery keys of the queued dispatches this input carries (a
   *  restart join can merge several). Written at mid-turn dispatch so the
   *  user's words survive a crash; the save-point flush that commits the
   *  resulting message retires them. Ephemeral transport, never persisted. */
  readonly dispatchIds?: readonly string[]
  /** Durable attribution for accepted input whose producer is known. */
  readonly producer?: UserInputProducer
}
export type ChatInputContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }


export type ChatInputLike = string | ChatInput

export function chatInputText(input: ChatInputLike): string {
  return typeof input === "string" ? input : input.text
}

export function normalizeChatInput(input: ChatInputLike): ChatInput {
  return typeof input === "string" ? { text: input } : input
}

export function isImageAttachment(attachment: Pick<ChatAttachment, "mediaType">): boolean {
  return attachment.mediaType.startsWith("image/")
}

/** Image bytes for transcript previews, in attachment order, without file bodies. */
export function chatInputImages(input: ChatInputLike): readonly { readonly mediaType: string; readonly data: string }[] {
  return (normalizeChatInput(input).attachments ?? []).filter(isImageAttachment).map(({ mediaType, data }) => ({ mediaType, data }))
}

/** The model-facing content of one input. An image attachment is an image
 *  block; any other attachment is its text, named so the model can tell the
 *  file from the message around it. This is the one place attachment bytes
 *  become model content. */
export function chatInputContent(input: ChatInputLike): string | ChatInputContentBlock[] {
  const normalized = normalizeChatInput(input)
  if (!normalized.attachments || normalized.attachments.length === 0) return normalized.text
  return [
    { type: "text", text: normalized.text },
    ...normalized.attachments.map(attachmentBlock),
  ]
}

function attachmentBlock(attachment: ChatAttachment): ChatInputContentBlock {
  if (isImageAttachment(attachment)) return { type: "image", mediaType: attachment.mediaType, data: attachment.data }
  const name = attachment.name ?? attachment.marker
  const body = Buffer.from(attachment.data, "base64").toString("utf8")
  return { type: "text", text: `<attachment name="${name}" type="${attachment.mediaType}">\n${body}\n</attachment>` }
}
