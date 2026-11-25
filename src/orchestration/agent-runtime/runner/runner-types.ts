import type { ChatInputLike } from "../../../infra/substrate/events/chat-input.js"
import type { OutputProjectionEvent } from "../../../infra/substrate/output/output-projection-events.js"

/** What a chat runner and a workflow runner both are. Controls whose shape
 *  differs between them, such as interrupt and resume, belong to each kind
 *  (`ChatRunner`, `WorkflowRunner`). */
export interface Runner {
  readonly sessionId: string
  /** Projects an already durable event without recording it again. */
  applyProjectionEvent(event: OutputProjectionEvent): void
  dispose(): Promise<void>
  /** Takes the person's latest unread queued message back for their editor.
   *  Resolves with it only after its hold is retired, and null when nothing
   *  unread is queued. Rejects with the store's error when the hold cannot
   *  be retired, which leaves the message queued. */
  recallQueuedMessage(): Promise<ChatInputLike | null>
  compact(): Promise<boolean>
  /** Reload runtime config, auth, and model listing from disk. Optional;
   *  workflow runners that complete in one shot may omit it. */
  refreshDeps?(): Promise<void>
}
