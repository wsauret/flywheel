import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { OrderedLane } from "../../infra/ordered-lane.js"
import type { ChatRunner } from "../chat/runner-types.js"
import { registerLiveSessionControl } from "../session/live-session-control.js"

/** The live input control of one chat session. It is registered while a
 *  runner is attached and removed when the session leaves this process. */
export interface ChatSessionControl {
  attach(): void
  vacate(): void
}

/** A message enters the session's ordered sections, as a send does, and
 *  reaches the runner that is attached when its section runs. With no runner
 *  attached, the chat is at rest, and the message stays in its cell. */
export function createChatSessionControl(input: {
  readonly store: AsyncEventStateReadSurface
  readonly sessionId: string
  /** The session's ordered sections. */
  readonly lane: OrderedLane
  readonly runner: () => ChatRunner | null | undefined
}): ChatSessionControl {
  let unregister: (() => void) | undefined
  return {
    attach() {
      unregister?.()
      unregister = registerLiveSessionControl(input.store, {
        sessionId: input.sessionId,
        get backgroundTasks() { return input.runner()?.backgroundTasks },
        state: async () => await input.runner()?.messageState() ?? "at_rest",
        recallQueuedMessage: async () => input.runner()?.recallQueuedMessage() ?? null,
        publishCommittedNotice: (notice) => input.runner()?.publishCommittedNotice?.(notice),
        deliver: (message, decide) => input.lane.run(async () => {
          const runner = input.runner()
          return runner ? await runner.deliverHeldMessage(message, decide) : decide("at_rest")
        }),
        notify: (notification) => input.lane.run(async () => await input.runner()?.deliverBackgroundNotification(notification) ?? false),
      })
    },
    // The registry removes only the control that this owner registered, so
    // a later call of a stale release is harmless.
    vacate() {
      unregister?.()
      unregister = undefined
    },
  }
}
