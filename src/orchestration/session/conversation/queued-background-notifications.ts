import { randomUUID } from "node:crypto"
import type { AsyncEventStateReadSurface, AsyncEventWriter, InFlightRecord, InFlightSwap, InFlightWrite } from "../../../infra/event-store-types.js"
import { redactMessage } from "../../agent-runtime/agent-loop-history.js"
import type { ConversationMessage } from "../../agent-runtime/llm/types.js"
import type { QueuedUserInputDestination } from "./queued-user-inputs.js"

export const QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND = "chat.queued_background_notification"

export interface QueuedBackgroundNotification {
  readonly key: string
  readonly text: string
}

export interface HeldBackgroundNotification {
  readonly text: string
  readonly key?: string
  readonly completionRunIds?: readonly string[]
}

/** Where a held notice waits: one conversation, or the next step of a
 *  workflow, as a held message does. A workflow sender gets its returned
 *  messages at its next step, because the step that sent them can have
 *  ended. */
export type HeldNotificationDestination = QueuedUserInputDestination

function conversation(conversationId: string): HeldNotificationDestination {
  return { target: "conversation", conversationId }
}

/** The cell that holds `text` for `destination`, redacted as the
 *  conversation stores it. */
function heldPayload(destination: HeldNotificationDestination, text: string) {
  const message = redactMessage({ kind: "user", content: text }, false)
  if (message.kind !== "user" || typeof message.content !== "string") {
    throw new Error("Background notification redaction produced an invalid message")
  }
  return destination.target === "workflow"
    ? { target: "workflow" as const, text: message.content }
    : { conversationId: destination.conversationId, text: message.content }
}

/** Holds produced notification text before it enters the process-local mailbox. */
export async function holdQueuedBackgroundNotification(
  writer: AsyncEventWriter,
  sessionId: string,
  conversationId: string,
  text: string,
  notificationKey: string = randomUUID(),
): Promise<HeldBackgroundNotification> {
  const payload = heldPayload(conversation(conversationId), text)
  if (!writer.putInFlight) return { key: notificationKey, text: payload.text }
  await writer.putInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, notificationKey, payload)
  return { key: notificationKey, text: payload.text }
}

/** The notice that a hold of `text` under `key` keeps, as a run that reads
 *  it now takes it. */
export function heldBackgroundNotification(destination: HeldNotificationDestination, text: string, key: string): HeldBackgroundNotification & { readonly key: string } {
  return { key, text: heldPayload(destination, text).text }
}

/** The write that holds `text` for `destination` under `key`, carried by a
 *  caller's own append or written alone. A repeat of the same notice
 *  overwrites its hold, so a retried write converges on one notice. */
export function heldBackgroundNotificationPut(destination: HeldNotificationDestination, text: string, key: string): Extract<InFlightWrite, { op: "put" }> {
  return { op: "put", kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, key, payload: heldPayload(destination, text) }
}

/** The guarded write that holds `text` for `conversationId` under `key`
 *  only where no hold stands, for a caller that retires other in-flight state
 *  in the same step and so is the one writer of the hold. */
export function heldBackgroundNotificationSwap(conversationId: string, text: string, key: string): InFlightSwap {
  return { op: "swap", kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, key, expectedRaw: null, payload: heldPayload(conversation(conversationId), text) }
}

/** Retires the cell held under `key`, for a notification whose entry the
 *  conversation already committed. */
export async function dropQueuedBackgroundNotification(writer: AsyncEventWriter, sessionId: string, key: string): Promise<void> {
  await writer.dropInFlight?.(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, key)
}

export function decodeQueuedBackgroundNotification(
  row: InFlightRecord,
  conversationId: string,
): QueuedBackgroundNotification | null {
  if (row.kind !== QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND) return null
  if (row.payload.conversationId !== conversationId || typeof row.payload.text !== "string") return null
  return { key: row.key, text: row.payload.text }
}

/** The notices held for conversation `conversationId` of `sessionId`, in
 *  the store's insertion order, without consuming them. */
export async function readConversationBackgroundNotifications(store: AsyncEventStateReadSurface, sessionId: string, conversationId: string): Promise<QueuedBackgroundNotification[]> {
  const notices: QueuedBackgroundNotification[] = []
  for (const row of await store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)) {
    const notice = decodeQueuedBackgroundNotification(row, conversationId)
    if (notice) notices.push(notice)
  }
  return notices
}

/** The notices held for the next agent of workflow `sessionId`, in the
 *  store's insertion order, without consuming them. */
export async function readWorkflowBackgroundNotifications(store: AsyncEventStateReadSurface, sessionId: string): Promise<QueuedBackgroundNotification[]> {
  const notices: QueuedBackgroundNotification[] = []
  for (const row of await store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)) {
    if (row.payload.target === "workflow" && typeof row.payload.text === "string") notices.push({ key: row.key, text: row.payload.text })
  }
  return notices
}

export function queuedBackgroundNotificationMessage(
  notification: QueuedBackgroundNotification,
): Extract<ConversationMessage, { kind: "user" }> {
  return {
    kind: "user",
    content: notification.text,
    origin: "system",
    backgroundNotificationIds: [notification.key],
    replyRequired: true,
  }
}

export function queuedBackgroundNotificationDrops(keys: readonly string[]): InFlightWrite[] {
  return keys.map((key) => ({ op: "drop", kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, key }))
}
