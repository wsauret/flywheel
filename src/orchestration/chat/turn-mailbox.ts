/**
 * Chat input mailbox for the agent loop's queued-input channel.
 *
 * "Next-turn" here means the next drain point, not the end of the agent
 * turn: the loop drains this mailbox at loop top, after every tool batch,
 * and on wake from a park, so a message enqueued mid-turn rides into the
 * next model call once the in-flight batch completes. What does NOT exist
 * is in-flight injection (interrupting a running model stream or tool
 * batch to steer it); adding that without a caller would be
 * speculative. When a current-turn injector appears, add a second channel
 * alongside `nextTurn`.
 *
 * Implements the loop's `InputSource` contract; `drainPending` is the
 * non-blocking drain, and a wait reservation is the park primitive.
 */
import { Deferred, Effect } from "effect";
import {
  compactInput,
  holdInput,
  type AgentLoopInput,
  type AgentLoopMessageInput,
  type InputWaitReservation,
  type InputSource,
  messageInput,
  producerOrigin,
  requestContextInput,
  resumeInput,
  sameProducer,
  wakeInput,
} from "../../infra/agent-loop-events.js";
import { normalizeChatInput, type ChatAttachment, type ChatInput, type ChatInputLike } from "../../infra/chat-input.js";
import type { HeldBackgroundNotification } from "../session/conversation/queued-background-notifications.js";
import type { HumanInputQueue, QueuedInputWithdrawal } from "../session/queued-input-recall.js";

type WaiterWake = "input" | "cancelled";

/** Input the person gave: their message, their Resume, or their invocation.
 *  A message from another session is not the person's. */
function isUserInput(input: AgentLoopInput): boolean {
  return input.kind === "resume" || input.kind === "request-context" || isPersonMessage(input);
}

function isPersonMessage(input: AgentLoopInput): input is AgentLoopMessageInput {
  return input.kind === "message" && input.origin === "human";
}

function toChatInput(input: AgentLoopMessageInput): ChatInput {
  const { kind: _kind, origin: _origin, backgroundNotificationIds: _backgroundNotificationIds, ...chatInput } = input;
  return chatInput;
}

export class ChatTurnMailbox implements InputSource, HumanInputQueue {
  constructor(private readonly onInput?: () => void) {}
  private readonly nextTurn: AgentLoopInput[] = [];
  // Each item's admission order, so a withdrawn input returns to its place
  // and an observation can tell input admitted after it.
  private readonly ordinals = new WeakMap<AgentLoopInput, number>();
  private admitted = 0;
  private waiter: Deferred.Deferred<WaiterWake> | null = null;

  /** True while the agent loop owns a pending wait reservation between turns. */
  get parked(): boolean {
    return this.waiter !== null;
  }

  /** True when next-turn input is queued. The runner lifecycle checks this at
   *  turn teardown: input that arrived after the loop stopped draining has no
   *  live consumer and must trigger a respawn. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0;
  }

  /** The next delivery, without consuming controls the loop must execute. */
  get pendingInput(): AgentLoopInput | undefined {
    return this.nextTurn[0];
  }

  /** True when queued input includes an explicit user message. System-produced
   * input cannot authorize recovery from a terminal stall. */
  get hasPendingUserMessage(): boolean {
    return this.nextTurn.some(isUserInput);
  }

  /** Whether a queued input carries the dispatch id `key`: its held cell is
   *  this queue's to commit or retire. */
  holdsDispatchId(key: string): boolean {
    return this.nextTurn.some((input) => input.kind === "message" && input.dispatchIds?.includes(key) === true);
  }

  /** Observe authorizing input queued during an async reservation, excluding
   *  input that an earlier interrupt already left waiting. Input admitted
   *  before the observation never counts, including input that a failed
   *  recall put back. */
  observeUserInput(): () => boolean {
    const admittedBefore = this.admitted;
    return () => this.nextTurn.some((input) => (this.ordinals.get(input) ?? 0) > admittedBefore && isUserInput(input));
  }

  /** Admit an accepted message: the person's, or another session's when its
   *  producer names one. Produced notifications use their own methods. */
  enqueueNextTurn(input: ChatInputLike): void {
    const normalized = normalizeChatInput(input);
    this.enqueue(messageInput(normalized, { origin: producerOrigin(normalized.producer) }));
  }

  /** Admits another session's message that the wake hop limit holds: the
   *  parked loop folds it into history and starts no turn. */
  enqueueHeldMessage(input: ChatInputLike): void {
    const normalized = normalizeChatInput(input);
    this.enqueue(messageInput(normalized, { origin: producerOrigin(normalized.producer), held: true }));
  }

  enqueueSilentSystem(text: string): void {
    this.enqueue(messageInput(text, { origin: "silent-system" }));
  }

  /** The loop's runtime-notice channel (`InputSource.enqueueRuntimeNotice`). */
  enqueueRuntimeNotice(text: string): void {
    this.enqueue(messageInput(text, { origin: "silent-system", runtimeNotice: true }));
  }

  /** A completion, interruption, or reply wait's end from the background work registry. It carries no runtime-notice
   *  label: a chat or a headless task runs its own engine process (ARCH-PROVIDERS-006), so no route delivers its input with
   *  parked tool results, and a held notification here does not say which kind of notice it is. */
  enqueueBackgroundNotification(notification: HeldBackgroundNotification): void {
    this.enqueue(messageInput(notification.text, {
      origin: "silent-system",
      ...(notification.key ? { backgroundNotificationIds: [notification.key] } : {}),
    }));
  }

  /** Atomically pairs the durable invocation boundary with private request-only context. */
  enqueueRequestWithContext(input: ChatInputLike, text: string): void {
    this.enqueue(requestContextInput(input, text));
  }

  enqueueCompact(source?: "idle"): void {
    this.enqueue(compactInput(source));
  }

  /** Withdraws a voluntary checkpoint that has not reached the loop yet. */
  cancelIdleCompaction(): void {
    for (let index = this.nextTurn.length - 1; index >= 0; index--) {
      const input = this.nextTurn[index];
      if (input?.kind === "compact" && input.source === "idle") this.nextTurn.splice(index, 1);
    }
  }

  enqueueWake(): void {
    this.enqueue(wakeInput());
  }

  /** A person's Resume of an interrupted turn. */
  enqueueResume(): void {
    this.enqueue(resumeInput());
  }

  enqueueHold(): void {
    this.enqueue(holdInput());
  }

  /** Takes back the person's queued messages. A message from another session
   *  stays for the next turn: it never returns to the person's editor. */
  drainUserMessages(): ChatInputLike[] {
    const drained: ChatInputLike[] = [];
    const retained: AgentLoopInput[] = [];
    for (const input of this.nextTurn) {
      if (isPersonMessage(input)) {
        drained.push(toChatInput(input));
      } else {
        retained.push(input);
      }
    }
    this.nextTurn.splice(0, this.nextTurn.length, ...retained);
    return drained;
  }

  /** Takes the person's latest unread message out of the queue. Its
   *  `restore` puts it back after the input admitted before it, with the
   *  effects of its first admission. */
  withdrawHuman(): QueuedInputWithdrawal | null {
    for (let i = this.nextTurn.length - 1; i >= 0; i--) {
      const item = this.nextTurn[i];
      if (!item || !isPersonMessage(item)) continue;
      this.nextTurn.splice(i, 1);
      const ordinal = this.ordinals.get(item) ?? 0;
      return {
        input: toChatInput(item),
        restore: () => {
          const at = this.nextTurn.findIndex((queued) => (this.ordinals.get(queued) ?? 0) > ordinal);
          this.admit(item, at < 0 ? this.nextTurn.length : at);
        },
      };
    }
    return null;
  }

  private enqueue(input: AgentLoopInput): void {
    this.ordinals.set(input, ++this.admitted);
    this.admit(input, this.nextTurn.length);
  }

  private admit(input: AgentLoopInput, at: number): void {
    if (input.kind !== "compact" || input.source !== "idle") this.cancelIdleCompaction();
    this.onInput?.();
    this.nextTurn.splice(at, 0, input);
    this.wakeWaiter();
  }

  private wakeWaiter(reason: WaiterWake = "input"): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    Effect.runSync(Deferred.succeed(waiter, reason));
  }

  /** Drain the next control item or contiguous next-turn text batch. */
  drainPending(): AgentLoopInput | null {
    if (this.nextTurn.length === 0) return null;
    const first = this.nextTurn.shift();
    if (!first) return null;
    if (first.kind !== "message") return first;

    // An invocation message never coalesces: its text is an expanded step
    // prompt whose transcript rendering (divider + raw args) depends on the
    // durable message staying exactly that prompt.
    const texts = [first.text];
    const attachments: ChatAttachment[] = first.attachments ? [...first.attachments] : [];
    const dispatchIds: string[] = first.dispatchIds ? [...first.dispatchIds] : [];
    const submissionIds: string[] = first.submissionIds ? [...first.submissionIds] : [];
    const backgroundNotificationIds: string[] = first.backgroundNotificationIds ? [...first.backgroundNotificationIds] : [];
    while (
      !first.invocation
      // A reserved input already owns a public row. Joining it would replace
      // several row identities with one conversation entry at the save point.
      && !first.dispatchIds?.length
      && !first.held
      && !first.backgroundNotificationIds?.length
      && this.nextTurn[0]?.kind === "message"
      && !this.nextTurn[0].invocation
      && !this.nextTurn[0].dispatchIds?.length
      && !this.nextTurn[0].held
      && !this.nextTurn[0].backgroundNotificationIds?.length
      && this.nextTurn[0].origin === first.origin
      && this.nextTurn[0].runtimeNotice === first.runtimeNotice
      && sameProducer(this.nextTurn[0].producer, first.producer)
    ) {
      const item = this.nextTurn.shift();
      if (item?.kind === "message") {
        texts.push(item.text);
        if (item.attachments) attachments.push(...item.attachments);
        if (item.dispatchIds) dispatchIds.push(...item.dispatchIds);
        if (item.submissionIds) submissionIds.push(...item.submissionIds);
        if (item.backgroundNotificationIds) backgroundNotificationIds.push(...item.backgroundNotificationIds);
      }
    }
    return messageInput({
      text: texts.join("\n\n"),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(first.invocation ? { invocation: first.invocation } : {}),
      ...(dispatchIds.length > 0 ? { dispatchIds } : {}),
      ...(submissionIds.length > 0 ? { submissionIds } : {}),
      ...(first.producer ? { producer: first.producer } : {}),
    }, {
      origin: first.origin,
      ...(backgroundNotificationIds.length > 0 ? { backgroundNotificationIds } : {}),
      ...(first.held ? { held: true } : {}),
      ...(first.runtimeNotice ? { runtimeNotice: true } : {}),
    });
  }

  prepareWaitForInput(signal?: AbortSignal): InputWaitReservation {
    if (this.waiter !== null) {
      throw new Error("ChatTurnMailbox: concurrent input wait reservations are not supported");
    }
    let cancelWake = (): void => {};
    const wake: Promise<WaiterWake> = this.nextTurn.length > 0
      ? Promise.resolve("input")
      : signal?.aborted
        ? Promise.resolve("cancelled")
        : (() => {
          const waiter = Deferred.makeUnsafe<WaiterWake>();
          this.waiter = waiter;
          cancelWake = () => {
            if (this.waiter === waiter) this.wakeWaiter("cancelled");
          };
          if (!signal) return Effect.runPromise(Deferred.await(waiter));
          const onAbort = () => { cancelWake(); };
          signal.addEventListener("abort", onAbort, { once: true });
          return Effect.runPromise(Deferred.await(waiter)).finally(() => {
            signal.removeEventListener("abort", onAbort);
          });
        })();
    let finalized = false;
    const finalize = (): void => {
      if (finalized) throw new Error("ChatTurnMailbox: input wait reservation already finalized");
      finalized = true;
    };
    return {
      commit: async () => {
        finalize();
        return await wake === "cancelled" ? null : this.drainPending();
      },
      cancel: async () => {
        finalize();
        cancelWake();
        await wake;
      },
    };
  }
}
