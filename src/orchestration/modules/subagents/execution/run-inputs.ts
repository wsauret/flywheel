import type { TurnParkState } from "../../../../infra/agent-loop-events.js";
import type { ChatInput } from "../../../../infra/chat-input.js";
import { createHeldCellClaims, type QueuedUserInputCell } from "../../../session/conversation/queued-user-inputs.js";
import { heldAtWakeLimit, type DeliveryOutcome, type LiveSessionControl } from "../../../session/live-session-control.js";
import { WorkflowInjectionQueue } from "../../../workflow-host/injection-queue.js";

/** The one consumer of the messages a subagent run accepts. Every
 *  message is durable in its cell before it arrives here. A resumed run
 *  adopts its held cells at its start, and a live delivery adds each later
 *  message. Each path reports the message to `onDelivered`, which shows it
 *  in the child's live transcript until the run commits it. A delivery can find the run live after the adoption already took
 *  its cell, so each cell reaches the run once, by whichever path sees it
 *  first. Once the loop returns, the run reads no message, so a delivery is
 *  refused and takes its hold back. While the loop is parked, a delivery
 *  decides from how it parked, so the wake limit holds a message to a run
 *  that waits on its background work, by the one rule for every session
 *  kind. */
export interface SubagentRunInputs {
  /** The loop's input source. */
  readonly queue: WorkflowInjectionQueue;
  adopt(cells: readonly QueuedUserInputCell[]): void;
  /** The run's loop parked as its `TurnParkedContext.park` states. */
  parked(state: TurnParkState): void;
  /** The run's loop left its park. */
  resumed(): void;
  handoffStarted(): boolean;
  state: LiveSessionControl["state"];
  recallQueuedMessage(): Promise<ChatInput | null>;
  withInputAdmission: NonNullable<LiveSessionControl["withInputAdmission"]>;
  deliver: LiveSessionControl["deliver"];
  /** Gives a held notice to the running loop. Once the loop returns, the
   *  notice stays held for the next run. */
  notify: LiveSessionControl["notify"];
  /** Called once, when the loop returns. */
  close(): Promise<void>;
}

export function createSubagentRunInputs(onDelivered: (message: ChatInput) => void, recall?: () => Promise<ChatInput | null>): SubagentRunInputs {
  const queue = new WorkflowInjectionQueue();
  const claims = createHeldCellClaims();
  let reading = true;
  let recallSettlement: Promise<void> = Promise.resolve();
  let admissionSettlement: Promise<void> = Promise.resolve();
  // How the loop parked, undefined while its turn runs.
  let park: TurnParkState | undefined;
  return {
    queue,
    adopt(cells) {
      if (queue.isHandingOff || !reading) return;
      for (const cell of cells) {
        if (!claims.claim(cell.key)) continue;
        const message: ChatInput = {
          text: cell.text,
          ...(cell.attachments ? { attachments: cell.attachments } : {}),
          ...(cell.invocation ? { invocation: cell.invocation } : {}),
          ...(cell.submissionIds ? { submissionIds: cell.submissionIds } : {}),
          ...(cell.producer ? { producer: cell.producer } : {}),
          dispatchIds: [cell.key],
        };
        queue.enqueueMessage(message);
        onDelivered(message);
      }
    },
    parked(state) { park = state; },
    resumed() { park = undefined; },
    handoffStarted: () => queue.handoffStarted(),
    state: async () => queue.isHandingOff ? "handing_off" : park ?? "running",
    recallQueuedMessage() {
      if (!reading || queue.isHandingOff || !recall) return Promise.resolve(null);
      const result = recall();
      recallSettlement = Promise.all([recallSettlement, result.then(() => {}, () => {})]).then(() => {});
      return result;
    },
    withInputAdmission(admit) {
      if (!reading || queue.isHandingOff) return Promise.resolve({ status: "refused", reason: "handing_off" });
      const result = admit();
      admissionSettlement = Promise.all([admissionSettlement, result.then(() => {}, () => {})]).then(() => {});
      return result;
    },
    async deliver(message, decide): Promise<DeliveryOutcome> {
      if (queue.isHandingOff) return { status: "refused", reason: "handing_off" };
      if (!reading) return { status: "refused", reason: "settled" };
      const outcome = decide(park ?? "running");
      if (outcome.status === "refused") return outcome;
      if (!claims.claimMessage(message)) return outcome;
      queue.enqueueMessage(message, { held: heldAtWakeLimit(outcome) });
      onDelivered(message);
      return outcome;
    },
    async notify({ key, text }) {
      if (!reading || queue.isHandingOff) return false;
      if (key !== undefined && !claims.claim(key)) return true;
      queue.enqueue(text, { silent: true, ...(key ? { backgroundNotificationId: key } : {}) });
      return true;
    },
    async close() {
      reading = false;
      await Promise.all([recallSettlement, admissionSettlement]);
    },
  };
}
