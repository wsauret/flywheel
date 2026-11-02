import { randomUUID } from "node:crypto"
import type { AsyncEventStateReadSurface, AsyncEventWriter, InFlightRecord, InFlightWrite } from "../../../infra/event-store-types.js"
import { SESSION_RELATIONS } from "../../../infra/chat-input-schema.js"
import { chatInputContent, normalizeChatInput, type ChatAttachment, type ChatInput, type ChatInputLike, type ChatInvocation, type SessionMessageEnvelope, type UserInputProducer } from "../../../infra/chat-input.js"
import { Log } from "../../../infra/log.js"
import type { ConversationMessage } from "../../agent-runtime/llm/types.js"
import { recoverSessionMessageProducer, sessionMessageSources, type SessionMessageSources } from "../session-message-sources.js"

/** The in-flight kind a queued-but-not-yet-durable user input is held under.
 *
 *  A message the user sends mid-turn waits in memory (the turn mailbox, then
 *  the tree writer's pending buffer) until the next save point commits it.
 *  That wait can span a whole provider request, and the words are the user's:
 *  losing them to a crash leaves no way to rewrite what only they knew. So
 *  dispatch writes the one live value here, the save-point flush retires it
 *  in the commit that makes the message durable, and crash recovery restores
 *  whatever was never committed (ARCH-SUBSTRATE-024). */
export const QUEUED_USER_INPUT_IN_FLIGHT_KIND = "chat.queued_user_input"
export const RETAINED_INPUT_GAP_IN_FLIGHT_KIND = "chat.retained_input_gap"

const log = Log.create({ service: "queued-user-inputs" })

export interface QueuedUserInput extends ChatInput {
  readonly retainedGap?: true
  /** Absent on held input written before explicit human provenance. */
  readonly origin?: "human"
  /** The in-flight cell key, minted at dispatch. Doubles as the recovered
   *  entry's id so racing recoveries settle on one committed copy. */
  readonly key: string
}

/** Where a held message waits: one conversation, or the next agent of a
 *  workflow, which picks its conversation when the agent starts. */
export type QueuedUserInputDestination =
  | { readonly target: "conversation"; readonly conversationId: string }
  | { readonly target: "workflow" }

/** A decoded cell retains its destination and exact stored bytes for guarded
 *  transfer. A cell for the workflow's next agent names the workflow that
 *  holds it, because each agent commits it into a conversation of its own
 *  session and that commit retires the workflow's cell. */
export type QueuedUserInputCell = QueuedUserInput & { readonly raw: string } & (
  | { readonly target: "conversation"; readonly conversationId: string }
  | { readonly target: "workflow"; readonly workflowId: string }
)

/** A canonical entry is durable, or the exact held cell changed before its append. */
export type QueuedUserInputCommitResult = "committed" | "contended"

/** The stored form of one held input: its text, its provenance, its
 *  attachments, its invocation, and its submission ids. Every held-input
 *  cell family writes it, and `decodeHeldInput` reads it. */
export function queuedInputPayload(input: ChatInputLike) {
  const normalized = normalizeChatInput(input)
  const producer = normalized.producer
  return {
    text: normalized.text,
    ...(!producer || producer.kind === "human" ? { origin: "human" as const } : {}),
    ...(producer ? { producer } : {}),
    ...(normalized.attachments && normalized.attachments.length > 0 ? { attachments: normalized.attachments } : {}),
    ...(normalized.invocation ? { invocation: normalized.invocation } : {}),
    ...(normalized.submissionIds?.length ? { submissionIds: normalized.submissionIds } : {}),
  }
}

/** The cell key of one accepted message, which its conversation entry also
 *  takes. A message from another session is keyed by its sending call, and
 *  a person's message by its one submission identity, so a replay of either
 *  delivery converges on one cell and one entry: a client sends a person's
 *  message again under the same identity when its connection lost the answer
 *  (ARCH-SESSIONS-030). A person's message with no identity, or a merge of several,
 *  gets a fresh key. */
export function queuedUserInputKey(producer: UserInputProducer | undefined, submissionIds: readonly string[] | undefined): string {
  if (producer?.kind === "session") return `msg:${producer.sessionId}:${producer.toolUseId}`
  return personKey(submissionIds) ?? randomUUID()
}

/** The ledger key of a person's message that carries exactly one
 *  submission identity, undefined for any other input. Every path that
 *  records a person's message keys its entry and its held cell by it, and
 *  reads the ledger under it before it records anything. */
export function personMessageKey(input: ChatInputLike): string | undefined {
  const normalized = normalizeChatInput(input)
  return normalized.producer?.kind === "session" ? undefined : personKey(normalized.submissionIds)
}

function personKey(submissionIds: readonly string[] | undefined): string | undefined {
  return submissionIds?.length === 1 ? `person:${submissionIds[0]}` : undefined
}

/** The in-flight write that holds one accepted message under `key`, for a
 *  caller that commits it beside other writes in one append. */
export function queuedUserInputPut(key: string, destination: QueuedUserInputDestination, input: ChatInputLike): Extract<InFlightWrite, { op: "put" }> {
  const place = destination.target === "workflow" ? { target: "workflow" as const } : { conversationId: destination.conversationId }
  return { op: "put", kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key, payload: { ...place, ...queuedInputPayload(input) } }
}

/** Durably holds one accepted message, from a person or from another
 *  session, before any loop reads it. Resolves to the cell key the input must
 *  carry (as its message's dispatchId) so the commit of its entry retires the
 *  cell, or null when the store cannot hold in-flight state - the caller
 *  proceeds without the durability, exactly as read-only stores always have. */
export async function holdQueuedUserInput(
  writer: AsyncEventWriter,
  sessionId: string,
  destination: QueuedUserInputDestination,
  input: ChatInputLike,
  entryId?: string,
): Promise<string | null> {
  if (!writer.putInFlight) return null
  const normalized = normalizeChatInput(input)
  const key = entryId ?? queuedUserInputKey(normalized.producer, normalized.submissionIds)
  const put = queuedUserInputPut(key, destination, input)
  await writer.putInFlight(sessionId, put.kind, put.key, put.payload)
  return key
}

/** Retires one cell outside an append: the user recalled the queued message
 *  back into the editor, so there is no commit for the retirement to ride. */
export async function dropQueuedUserInput(writer: AsyncEventWriter, sessionId: string, key: string, retainedGap = false): Promise<void> {
  await writer.dropInFlight?.(sessionId, retainedGap ? RETAINED_INPUT_GAP_IN_FLIGHT_KIND : QUEUED_USER_INPUT_IN_FLIGHT_KIND, key)
}

/** Decodes one queued human input without accepting another in-flight kind. */
export function decodeQueuedUserInput(
  row: InFlightRecord,
  sessionId: string,
  conversationId: string,
): QueuedUserInputCell | null {
  const cell = decodeQueuedUserInputCell(row, sessionId)
  return cell?.target === "conversation" && cell.conversationId === conversationId ? cell : null
}

/** Decode this held-input family once, preserving original input, provenance, and swap token.
 * Historical untagged conversation cells remain readable without inventing human provenance. */
export function decodeQueuedUserInputCell(row: InFlightRecord, sessionId: string): QueuedUserInputCell | null {
  if (row.kind !== QUEUED_USER_INPUT_IN_FLIGHT_KIND) return null
  const target = row.payload.target === "workflow"
    ? { target: "workflow" as const, workflowId: sessionId }
    : row.payload.target === undefined && typeof row.payload.conversationId === "string"
      ? { target: "conversation" as const, conversationId: row.payload.conversationId }
      : null
  if (!target) return null
  const input = decodeHeldInput(row)
  if ("unreadable" in input) {
    log.warn(input.unreadable === "text" ? "unreadable queued user input skipped" : "queued user input producer is unreadable", { sessionId, key: row.key })
    return null
  }
  return { ...target, raw: row.raw, ...input }
}

/** Decodes the input that one held cell of any family stores in the form
 *  that `queuedInputPayload` writes, under the cell's key, or names the
 *  field that is unreadable. The caller decides how to report it. */
export function decodeHeldInput(row: InFlightRecord): QueuedUserInput | { readonly unreadable: "text" | "producer" } {
  if (typeof row.payload.text !== "string") return { unreadable: "text" }
  // A cell held before attachments had a name for text files spelled the
  // field `images`; it decodes as the same attachments.
  const attachments = decodeAttachments(row.payload.attachments ?? row.payload.images)
  const invocation = decodeInvocation(row.payload.invocation)
  const submissionIds = Array.isArray(row.payload.submissionIds)
    ? row.payload.submissionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : []
  const producer = decodeProducer(row.payload.producer)
  if (row.payload.producer !== undefined && !producer) return { unreadable: "producer" }
  return {
    key: row.key,
    text: row.payload.text,
    ...(row.payload.origin === "human" ? { origin: row.payload.origin } : {}),
    ...(producer ? { producer } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(invocation ? { invocation } : {}),
    ...(submissionIds.length > 0 ? { submissionIds } : {}),
  }
}

function decodeProducer(value: unknown): UserInputProducer | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) return undefined
  if (value.kind === "human") return { kind: "human" }
  if (value.kind === "session") {
    const sessionId = "sessionId" in value ? value.sessionId : undefined
    const conversationId = "conversationId" in value ? value.conversationId : undefined
    const toolUseId = "toolUseId" in value ? value.toolUseId : undefined
    const hop = "hop" in value ? value.hop : undefined
    if (!nonEmpty(sessionId) || !nonEmpty(conversationId) || !nonEmpty(toolUseId) || typeof hop !== "number" || !Number.isInteger(hop) || hop < 0) return undefined
    // A cell held before the message tool carries no envelope.
    if (!("envelope" in value)) return { kind: "session", sessionId, conversationId, toolUseId, hop }
    const envelope = decodeEnvelope(value.envelope)
    return envelope ? { kind: "session", sessionId, conversationId, toolUseId, hop, envelope } : undefined
  }
  // A cell held before session messages names a parent's message with a
  // `parent-agent` producer. It reads as the session producer of that parent
  // with hop 0. Remove this conversion after 2027-04-03, when no store holds
  // such a cell.
  if (value.kind !== "parent-agent") return undefined
  const parentSessionId = "parentSessionId" in value ? value.parentSessionId : undefined
  const parentConversationId = "parentConversationId" in value ? value.parentConversationId : undefined
  const authorizingToolCallId = "authorizingToolCallId" in value ? value.authorizingToolCallId : undefined
  if (!nonEmpty(parentSessionId) || !nonEmpty(parentConversationId) || !nonEmpty(authorizingToolCallId)) return undefined
  return { kind: "session", sessionId: parentSessionId, conversationId: parentConversationId, toolUseId: authorizingToolCallId, hop: 0 }
}

function decodeEnvelope(value: unknown): SessionMessageEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const name = "name" in value ? value.name : undefined
  const relation = SESSION_RELATIONS.find((candidate) => "relation" in value && value.relation === candidate)
  const waits = "waits" in value ? value.waits : undefined
  const personWords = "personWords" in value ? value.personWords : undefined
  if (typeof name !== "string" || !relation || typeof waits !== "boolean" || (personWords !== undefined && !nonEmpty(personWords))) return undefined
  return { name, relation, waits, ...(personWords === undefined ? {} : { personWords }) }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Read only workflow-owned cells in the store's insertion order, without consuming them. */
export async function readWorkflowQueuedUserInputs(store: AsyncEventStateReadSurface, sessionId: string): Promise<Extract<QueuedUserInputCell, { target: "workflow" }>[]> {
  const inputs: Extract<QueuedUserInputCell, { target: "workflow" }>[] = []
  const sources = await sessionMessageSources(store).replay()
  for (const row of await store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)) {
    const input = decodeQueuedUserInputCell(row, sessionId)
    if (input?.target === "workflow") inputs.push(recoveredInput(input, sources))
  }
  return inputs
}

/** Every message a session accepted and has not read, in insertion order:
 *  the held cells of each of its conversations and of the next agent of its
 *  workflow. Settle and delete read this to return what nobody read. */
export async function readUnreadMessages(store: AsyncEventStateReadSurface, sessionId: string): Promise<QueuedUserInputCell[]> {
  const cells: QueuedUserInputCell[] = []
  const sources = await sessionMessageSources(store).replay()
  for (const row of await store.readInFlight(sessionId, [QUEUED_USER_INPUT_IN_FLIGHT_KIND, RETAINED_INPUT_GAP_IN_FLIGHT_KIND])) {
    const cell = decodeQueuedUserInputCell(row.kind === RETAINED_INPUT_GAP_IN_FLIGHT_KIND ? { ...row, kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND } : row, sessionId)
    if (cell) cells.push(recoveredInput(row.kind === RETAINED_INPUT_GAP_IN_FLIGHT_KIND ? { ...cell, retainedGap: true } : cell, sources))
  }
  return cells
}

/** The held cells one reader took, by adoption at its start or by a live
 *  delivery. A delivery can reach a reader after its adoption already took
 *  the same cell, so each cell reaches the reader once, by whichever path
 *  sees it first. The claims live as long as the reader's acceptance does. */
export interface HeldCellClaims {
  /** Takes one cell; false when the reader already took it. */
  claim(key: string): boolean
  /** Takes every cell a delivered message carries in `dispatchIds`; false,
   *  and takes nothing, when the reader already took one of them. */
  claimMessage(message: ChatInput): boolean
  /** Forgets every claim, when the reader stops accepting. */
  clear(): void
}

export function createHeldCellClaims(): HeldCellClaims {
  const taken = new Set<string>()
  return {
    claim(key) {
      if (taken.has(key)) return false
      taken.add(key)
      return true
    },
    claimMessage(message) {
      const keys = message.dispatchIds ?? []
      if (keys.some((key) => taken.has(key))) return false
      for (const key of keys) taken.add(key)
      return true
    },
    clear() {
      taken.clear()
    },
  }
}

export async function readConversationQueuedUserInputs(
  store: AsyncEventStateReadSurface,
  sessionId: string,
  conversationId: string,
): Promise<Extract<QueuedUserInputCell, { target: "conversation" }>[]> {
  const inputs: Extract<QueuedUserInputCell, { target: "conversation" }>[] = []
  const sources = await sessionMessageSources(store).replay()
  for (const row of await store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)) {
    const input = decodeQueuedUserInputCell(row, sessionId)
    if (input?.target === "conversation" && input.conversationId === conversationId) inputs.push(recoveredInput(input, sources))
  }
  return inputs
}

function recoveredInput<T extends QueuedUserInputCell>(input: T, sources: SessionMessageSources): T {
  const producer = recoverSessionMessageProducer(input.producer, sources)
  return { ...input, ...(producer ? { producer } : {}) }
}

function decodeAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments: ChatAttachment[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const marker = "marker" in item ? item.marker : undefined
    const mediaType = "mediaType" in item ? item.mediaType : undefined
    const data = "data" in item ? item.data : undefined
    const name = "name" in item ? item.name : undefined
    if (typeof marker === "string" && typeof mediaType === "string" && typeof data === "string") {
      attachments.push({ marker, mediaType, data, ...(typeof name === "string" ? { name } : {}) })
    }
  }
  return attachments
}

function decodeInvocation(value: unknown): ChatInvocation | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const label = "label" in value ? value.label : undefined
  if (typeof label !== "string") return undefined
  const args = "args" in value ? value.args : undefined
  return { label, ...(typeof args === "string" ? { args } : {}) }
}

/** The durable user message a recovered input commits as: the user's own
 *  words, exactly as a normal idle send would have persisted them. */
export function queuedInputMessage(input: QueuedUserInput): Extract<ConversationMessage, { kind: "user" }> {
  return {
    kind: "user",
    content: chatInputContent(input),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.producer ? { producer: input.producer } : {}),
    ...(input.invocation ? { invocation: input.invocation } : {}),
    ...(input.submissionIds?.length ? { submissionIds: input.submissionIds } : {}),
  }
}

/** The retirements a commit carrying these dispatch ids must ride. A
 *  conversation of a workflow's agent also retires the cell under each key
 *  that the workflow held for its next agent. */
export function queuedInputDrops(keys: readonly string[], workflowId?: string): InFlightWrite[] | undefined {
  if (keys.length === 0) return undefined
  return keys.flatMap((key): InFlightWrite[] => [
    { op: "drop", kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key },
    ...(workflowId === undefined ? [] : [{ op: "drop" as const, kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key, sessionId: workflowId }]),
  ])
}
