import { Deferred, Effect } from "effect";
import {
  compactInput,
  type AgentLoopInput,
  type AgentLoopMessageOrigin,
  type InputWaitReservation,
  type InputSource,
  messageInput,
  producerOrigin,
  resumeInput,
  sameProducer,
} from "../../infra/agent-loop-events.js";
import { normalizeChatInput, type ChatInput, type ChatInputLike } from "../../infra/chat-input.js";

type WaiterWake = "input" | "cancelled";
interface MessageQueueItem {
  kind: "message";
  input: ChatInput;
  /** Absent for a visible runtime nudge. */
  origin?: AgentLoopMessageOrigin;
  /** The durable hold this notification already has; see `enqueue`. */
  backgroundNotificationId?: string;
  /** Input the workflow accepted for its running agent, whose cell the next
   *  agent adopts when this agent ends before it reads it. */
  accepted?: true;
  /** Another session's message that the wake hop limit holds: a parked
   *  loop folds it into history and starts no turn. */
  held?: true;
  /** A runtime notice about the agent's own waits and work; see `enqueueRuntimeNotice`. */
  runtimeNotice?: true;
}

type QueueItem = MessageQueueItem | { kind: "compact" } | { kind: "resume" };

function isAcceptedHumanMessage(item: QueueItem): boolean {
  return item.kind === "message" && item.accepted === true && item.origin === "human" && item.input.producer?.kind !== "session";
}

interface DrainResult {
  message: string;
  input: ChatInput;
  /** One origin for every drained item. `silent-system` is backend-only and
   *  never surfaced to the UI; absent is a visible runtime nudge. */
  origin?: AgentLoopMessageOrigin;
  backgroundNotificationIds?: readonly string[];
  held?: true;
  runtimeNotice?: true;
}

/**
 * The input queue of one running agent of a workflow. Producers (subagent
 * completion batches, observer chain, handoff watchdog, accepted messages)
 * all enqueue here; the agent's loop drains it via the `InputSource`
 * contract. Each agent that runs has its own queue, so agents that run at the
 * same time never read one another's input.
 */
export class WorkflowInjectionQueue implements InputSource {
  private readonly queue: QueueItem[] = [];
  private readonly order = new WeakMap<QueueItem, number>();
  private nextOrder = 0;
  private waiter: Deferred.Deferred<WaiterWake> | null = null;
  private observeDrain: ((result: DrainResult) => void) | null = null;
  private handingOff = false;

  /** The admitted stream-start boundary closes every input channel for this agent. */
  handoffStarted(): boolean {
    if (this.handingOff) return false;
    this.handingOff = true;
    return true;
  }

  get isHandingOff(): boolean { return this.handingOff; }

  /** Set a hook that observes each drain (used by the runtime adapter to
   *  emit `agent.message.injected` events and clear the subagent pending
   *  bucket). Returns an unsubscribe function. */
  onDrain(handler: (result: DrainResult) => void): () => void {
    this.observeDrain = handler;
    return () => { if (this.observeDrain === handler) this.observeDrain = null; };
  }

  /** A runtime nudge: visible, or `silent` for a notice only the model reads.
   *  `backgroundNotificationId` names the in-flight cell that already holds
   *  this notification durably; the message commits under it and retires it. */
  enqueue(text: string, opts: { silent?: boolean; backgroundNotificationId?: string } = {}): boolean {
    return this.enqueueItem({
      kind: "message",
      input: { text },
      ...(opts.silent ? { origin: "silent-system" as const } : {}),
      ...(opts.backgroundNotificationId ? { backgroundNotificationId: opts.backgroundNotificationId } : {}),
    });
  }

  /** An accepted message: the person's, or another session's when its
   *  producer names one. `held` marks a message that the wake hop limit
   *  holds (`heldAtWakeLimit`). */
  enqueueMessage(input: ChatInputLike, options: { readonly held?: boolean } = {}): void {
    const normalized = normalizeChatInput(input);
    this.enqueueItem({ kind: "message", input: normalized, origin: producerOrigin(normalized.producer), accepted: true, ...(options.held ? { held: true as const } : {}) });
  }

  /** A notice another session held for the workflow, such as its returned
   *  messages, which the running agent reads only the model sees. */
  enqueueAcceptedNotice(text: string, backgroundNotificationId: string): void {
    this.enqueueItem({ kind: "message", input: { text }, origin: "silent-system", backgroundNotificationId, accepted: true });
  }

  /** A silent runtime notice about the agent's own waits and children: a child's completion, stop, or runtime
   *  interrupt, or a reply wait's end without a reply, from the background work registry, or a wait's expiry or empty
   *  result. The drained message carries `runtimeNotice`, so a route may deliver it with the parked tool results it
   *  follows; see runtime-notifications.ts. `backgroundNotificationId` is as in `enqueue`. */
  enqueueRuntimeNotice(text: string, backgroundNotificationId?: string): boolean {
    return this.enqueueItem({
      kind: "message",
      input: { text },
      origin: "silent-system",
      runtimeNotice: true,
      ...(backgroundNotificationId ? { backgroundNotificationId } : {}),
    });
  }

  enqueueCompact(): void {
    this.enqueueItem(compactInput());
  }

  /** A person's Resume of the interrupted agent: the parked worker's
   *  authorizing input, which continues the agent in its own conversation. */
  enqueueResume(): void {
    this.enqueueItem(resumeInput());
  }

  /** Whether the accepted message held under the cell `key` still waits
   *  here, which means the agent has not read it. */
  holdsMessage(key: string): boolean {
    return this.queue.some((item) => item.kind === "message" && item.accepted === true && item.input.dispatchIds?.includes(key) === true);
  }

  /** Takes back the accepted message held under the cell `key`, before the
   *  agent reads it. Null when the agent read it already. */
  takeMessage(key: string): ChatInput | null {
    const index = this.queue.findIndex((item) => item.kind === "message" && item.accepted === true && item.input.dispatchIds?.includes(key) === true);
    const [item] = index === -1 ? [] : this.queue.splice(index, 1);
    return item?.kind === "message" ? item.input : null;
  }

  /** Withdraws the latest unread person's input before a consumer can take it.
   * Restore preserves its place even when other input is consumed while storage awaits. */
  withdrawHuman(): { readonly input: ChatInput; restore(): void } | null {
    const index = this.queue.findLastIndex(isAcceptedHumanMessage);
    const item = this.queue[index];
    if (item?.kind !== "message") return null;
    this.queue.splice(index, 1);
    // SAFETY: every queued item entered through enqueueItem, which records its order.
    const ordinal = this.order.get(item)!;
    return {
      input: item.input,
      restore: () => {
        // SAFETY: every queued item entered through enqueueItem, which records its order.
        const next = this.queue.findIndex((queued) => this.order.get(queued)! > ordinal);
        this.queue.splice(next < 0 ? this.queue.length : next, 0, item);
        this.wakeWaiter();
      },
    };
  }

  discardPending(): void {
    this.queue.splice(0);
  }

  private enqueueItem(item: QueueItem): boolean {
    if (this.handingOff) return false;
    this.order.set(item, this.nextOrder++);
    this.queue.push(item);
    this.wakeWaiter();
    return true;
  }

  private wakeWaiter(reason: WaiterWake = "input"): void {
    if (reason === "input" && this.nextPendingIndex() < 0) return;
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    Effect.runSync(Deferred.succeed(waiter, reason));
  }

  private nextPendingIndex(): number {
    return this.handingOff || this.queue.length === 0 ? -1 : 0;
  }

  /** Combine adjacent messages with the same provenance into one delivery. */
  drain(): DrainResult | null {
    const index = this.nextPendingIndex();
    const first = this.queue[index];
    if (!first || first.kind !== "message") return null;
    const items: MessageQueueItem[] = [];
    // A held notification commits alone, so its entry id is its hold key. A
    // message held at the wake limit stays alone too, so it never folds a
    // message that may start a turn.
    for (;;) {
      const item = this.queue[index];
      if (
        item?.kind !== "message"
        || (items.length > 0 && (first.input.dispatchIds?.length || item.input.dispatchIds?.length))
        || (items.length > 0 && (first.backgroundNotificationId || item.backgroundNotificationId || first.held || item.held))
        || item.origin !== first.origin
        || item.runtimeNotice !== first.runtimeNotice
        || !sameProducer(item.input.producer, first.input.producer)
      ) break;
      items.push(item);
      this.queue.splice(index, 1);
    }
    const message = items.map((item) => item.input.text).join("\n\n");
    const result = {
      message,
      input: {
        text: message,
        attachments: items.flatMap((item) => item.input.attachments ?? []),
        dispatchIds: items.flatMap((item) => item.input.dispatchIds ?? []),
        submissionIds: items.flatMap((item) => item.input.submissionIds ?? []),
        ...(first.input.producer ? { producer: first.input.producer } : {}),
      },
      ...(first.origin ? { origin: first.origin } : {}),
      ...(first.backgroundNotificationId ? { backgroundNotificationIds: [first.backgroundNotificationId] } : {}),
      ...(first.held ? { held: true as const } : {}),
      ...(first.runtimeNotice ? { runtimeNotice: true as const } : {}),
    };
    this.observeDrain?.(result);
    return result;
  }

  drainPending(): AgentLoopInput | null {
    const index = this.nextPendingIndex();
    const control = this.queue[index];
    if (control?.kind === "compact" || control?.kind === "resume") {
      this.queue.splice(index, 1);
      return control.kind === "compact" ? compactInput() : resumeInput();
    }
    const result = this.drain();
    if (!result) return null;
    return messageInput(result.input, {
      ...(result.origin ? { origin: result.origin } : {}),
      ...(result.backgroundNotificationIds ? { backgroundNotificationIds: result.backgroundNotificationIds } : {}),
      ...(result.held ? { held: true } : {}),
      ...(result.runtimeNotice ? { runtimeNotice: true } : {}),
    });
  }

  prepareWaitForInput(signal?: AbortSignal): InputWaitReservation {
    const wake = this.nextPendingIndex() >= 0
      ? Promise.resolve<WaiterWake>("input")
      : signal?.aborted
        ? Promise.resolve<WaiterWake>("cancelled")
        : this.wait(signal);
    let finalized = false;
    const finalize = (): void => {
      if (finalized) throw new Error("WorkflowInjectionQueue: input wait reservation already finalized");
      finalized = true;
    };
    return {
      commit: async () => {
        finalize();
        return await wake === "cancelled" ? null : this.drainPending();
      },
      cancel: async () => {
        finalize();
        this.wakeWaiter("cancelled");
        await wake;
      },
    };
  }

  async waitForMessage(signal?: AbortSignal): Promise<DrainResult | null> {
    this.dropLeadingCompacts();
    const pending = this.drain();
    if (pending) return pending;

    if (signal?.aborted) return null;

    const wake = await this.wait(signal);
    if (wake === "cancelled") return null;

    this.dropLeadingCompacts();

    return this.drain();
  }

  private dropLeadingCompacts(): void {
    for (;;) {
      const index = this.nextPendingIndex();
      if (this.queue[index]?.kind !== "compact") return;
      this.queue.splice(index, 1);
    }
  }

  private async wait(signal?: AbortSignal): Promise<WaiterWake> {
    if (this.waiter !== null) {
      throw new Error(
        "WorkflowInjectionQueue: concurrent waitForMessage calls are not supported",
      );
    }

    const waiter = Deferred.makeUnsafe<WaiterWake>();
    this.waiter = waiter;

    if (signal) {
      const onAbort = () => {
        if (this.waiter === waiter) this.wakeWaiter("cancelled");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await Effect.runPromise(Deferred.await(waiter));
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }

    return await Effect.runPromise(Deferred.await(waiter));
  }
}
