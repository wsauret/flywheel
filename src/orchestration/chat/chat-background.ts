import { emitToolExecutionOutput, emitBackgroundCommandRecorded, emitToolExecutionOutputRecorded } from "../agent-runtime/emit.js"
import type { createEmit } from "../../infra/event-bus.js"
import type { RuntimeEvent } from "../../infra/runtime-event-types.js"
import { createBackgroundExecutionOwner } from "../agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../agent-runtime/background-work.js"
import { createChatNotificationDelivery } from "../runner/background-notification-delivery.js"
import type { ChatSessionDeps } from "./session.js"
import type { ChatTurnMailbox } from "./turn-mailbox.js"

/** A chat's background work: subagent and workflow dispatches and
 *  backgrounded commands. It is session-scoped: it survives runner respawns
 *  and turn interrupts, so the session owns it, not the runner. The owner is
 *  its only blanket kill switch; it closes once, at session end, where an
 *  executor that heard a planned replacement's handoff hands its running
 *  commands to the next build instead. Every completion reaches the chat
 *  through `deliver`, as a background notification under its key. */
export function createChatBackground(input: {
  readonly deps: ChatSessionDeps
  readonly emit: ReturnType<typeof createEmit>
  readonly mailbox: Pick<ChatTurnMailbox, "hasPending">
  readonly awaitDurableFacts: () => Promise<void>
  readonly admitsInput: () => boolean
  readonly deliver: (text: string, notificationKey: string | undefined) => Promise<boolean>
}) {
  const { deps, emit, mailbox } = input
  const { sessionId } = deps
  // Background render events bypass the per-turn isLiveTurn gate: a subagent
  // outliving its dispatching turn must still paint its terminal state.
  const onBackgroundEvent = (event: RuntimeEvent): void => { emit(event.type, { sessionId, data: event.data }) }
  const notifications = createChatNotificationDelivery({
    conversation: deps.treeWriter, admitsInput: input.admitsInput,
    submit: (held) => input.deliver(held.text, held.key),
  })
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({
    kind: "chat",
    pendingInput: () => mailbox.hasPending || deps.rootChatCompletion?.hasPendingInput === true,
    enqueueNotification: notifications.enqueue,
    settleNotificationAdmission: notifications.settle,
    onChange: (commands) => deps.updateEntry({ activeBackgroundCommands: commands }),
    onExecutionOutput: (toolUseId, output, identity) => {
      emitToolExecutionOutput(onBackgroundEvent, toolUseId, output, identity)
    },
    onExecutionOutputRecorded: (toolUseId, output, identity, edits) => {
      emitToolExecutionOutputRecorded(onBackgroundEvent, toolUseId, output, identity, edits)
      return input.awaitDurableFacts()
    },
    onCommandRecorded: (record) => { emitBackgroundCommandRecorded(onBackgroundEvent, record) },
  }), deps.commandHandover ? {
    authority: deps.commandHandover, sessionId, conversationId: deps.conversationId, holder: "conversation",
    // A completion found at adoption reaches the chat as any completion does.
    deliver: async (completion) => { await input.deliver(completion.text, completion.key) },
  } : undefined, {
    // The chat's own turns, the only agent purpose `interactive-chat`, run
    // this owner's commands. Its learning review shares the owner but runs
    // no shell command.
    processorExempt: true,
  })
  return { background, notifications, onBackgroundEvent }
}
