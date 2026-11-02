import type { RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import { probeLoopUnit, trackLoopSpan } from "../../../../infra/event-loop-lag.js";
import { createBackgroundExecutionOwner } from "../../../agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type ActiveBackgroundCommandDescriptor } from "../../../agent-runtime/background-work.js";
import type { CommandHandoverScope } from "../../../agent-runtime/command-handover.js";
import { emitBackgroundCommandRecorded, emitToolExecutionOutput, emitToolExecutionOutputRecorded } from "../../../agent-runtime/emit.js";
import type { ConversationTreeWriterController } from "../../../chat/tree-writer.js";
import { createBackgroundNotificationDelivery } from "../../../runner/background-notification-delivery.js";
import type { WorkflowInjectionQueue } from "../../../workflow-host/injection-queue.js";

/** Builds the background execution of one child run (ARCH-SESSIONS-006, ARCH-SESSIONS-010): `owner`, the
 *  owner the child's shell, nested dispatches, and reply waits run in;
 *  `adoptHandedOver`, which the
 *  child awaits before its first request; and `close`, which closes the owner
 *  and then settles the notifications it delivered. A granted child consumes
 *  its grandchildren's completion batches through its own injection queue,
 *  exactly like an agent of a workflow. The registry gates handoff until every
 *  grandchild result commits to the child's conversation. The
 *  dispatch closes this when the child settles, so no grandchild outlives the
 *  child that started it. Every child gets an owner, since every child can
 *  wait on a reply, and with `handover` its owner hands the child's running
 *  commands to the next build when a planned replacement pauses the child, and
 *  the resumed child adopts them. */
export function createChildBackgroundExecution(input: {
  readonly conversation: Pick<ConversationTreeWriterController, "holdBackgroundNotification" | "waitForBackgroundNotification" | "commitBackgroundNotification">;
  readonly queue: WorkflowInjectionQueue;
  readonly abort: () => void;
  readonly onChildEvent: (event: RuntimeEvent) => void;
  /** Acknowledges accepted runtime facts or rejects their persistence failure. */
  readonly awaitDurableFacts: () => Promise<void>;
  /** The child's running background commands, each time they change. */
  readonly onCommandsChanged: (commands: readonly ActiveBackgroundCommandDescriptor[]) => void;
  readonly handover?: CommandHandoverScope;
  /** Initial delivery retry delay; tests shorten it to observe owner shutdown. */
  readonly notificationRetryMs?: number;
}) {
  const notifications = createBackgroundNotificationDelivery({ conversation: input.conversation, queue: input.queue, abort: input.abort });
  const owner = createBackgroundExecutionOwner(createBackgroundWorkRegistry({
    kind: "workflow",
    enqueueNotification: notifications.enqueue,
    settleNotificationAdmission: notifications.settle,
    notificationRetryMs: input.notificationRetryMs,
    onChange: input.onCommandsChanged,
    onExecutionOutput: (toolUseId, output, identity) => emitToolExecutionOutput(input.onChildEvent, toolUseId, output, identity),
    onExecutionOutputRecorded: (toolUseId, output, identity, edits) => {
      emitToolExecutionOutputRecorded(input.onChildEvent, toolUseId, output, identity, edits);
      return input.awaitDurableFacts();
    },
    onCommandRecorded: (record) => { emitBackgroundCommandRecorded(input.onChildEvent, record); },
  }), input.handover && {
    ...input.handover,
    holder: "conversation",
    // Adoption runs before the child's first request, which then reads it.
    deliver: async (completion) => { await input.conversation.commitBackgroundNotification(completion); },
  });
  return {
    owner,
    adoptHandedOver: () => owner.adoptHandedOver(),
    async close() {
      const endOwner = trackLoopSpan("subagent-teardown", "background-owner.close");
      try {
        await probeLoopUnit("subagent-teardown", "background-owner.close", () => owner.close());
      } finally {
        endOwner();
        const endNotifications = trackLoopSpan("subagent-teardown", "notifications.settle");
        try {
          await probeLoopUnit("subagent-teardown", "notifications.settle", () => notifications.settle());
        } finally {
          endNotifications();
        }
      }
    },
  };
}
