import { errorMessage } from "../../../infra/error-message.js";
import { PersistenceWriteRefused } from "../../../infra/event-store-types.js";
import { Log } from "../../../infra/log.js";
import { createOrderedLane } from "../../../infra/ordered-lane.js";
import { runInTaskSlices } from "../../../infra/task-scheduling.js";
import type { PausedBy } from "../../../infra/output-blocks.js";
import type { ConversationMessage } from "../../agent-runtime/llm/types.js";
import { repairToolAdjacencyWork } from "./conversation-tool-adjacency.js";
import type { ConversationTree } from "./conversation-tree.js";
import type { FinalizedCheckpointSwap } from "../../agent-runtime/agent-loop-types.js";
import type { QueuedUserInputCell, QueuedUserInputCommitResult } from "./queued-user-inputs.js";
import { cutRunningToolCall, interruptedTurnMessage, type TurnEndEntry } from "./turn-end-record.js";
import type { HeldRetainedOperation } from "../../module-seams.js";

const log = Log.create({ service: "conversation-tree-writer" });

interface ConversationTreeWriterDeps {
  tree: ConversationTree;
  recoverFinalizedToolResults?: () => Promise<void>;
  /** A live mailbox owns these cells until its copy commits or is discarded. */
  ownsBackgroundNotification?: (key: string) => boolean;
  ownsQueuedUserInput?: (key: string) => boolean;
  releaseBackgroundNotification?: (key: string) => void;
  abandonBackgroundNotification?: (key: string) => void;
}

/** Whether a turn of this process is running. Only the turn owner moves it:
 *  `beginTurn` opens, and `endTurn` or `suspendPending` close. A save point
 *  never changes it, because an empty buffer mid-turn (the assistant barrier committed the tool calls and
 *  the tools are still running) is not the end of the turn. Inferring idle
 *  from the buffer once let a mid-turn notice run crash recovery over a live
 *  turn's finalized-result cells, and the turn's own commit then failed its
 *  exact-raw swap. */
type WriterPhase = "idle" | "in_turn";

/**
 * Buffer in front of `ConversationTree`. While idle, writes flow
 * straight through and become durable immediately; during a turn they queue
 * until the next save point so partial provider output never ends up in the
 * authoritative branch. Single source of truth for buffered pending writes;
 * the chat session never holds its own copy.
 *
 * The buffer is memory. An interrupted turn is reported to the next context
 * from the facts its tool calls and file changes already wrote, so buffering
 * costs no durable write (ARCH-SUBSTRATE-024). The one
 * exception is the user's own queued words, which nothing can re-derive: each
 * queued input is held as an in-flight cell at dispatch, and the save-point
 * flush that commits its message retires the cell in the same commit unit.
 */
export interface ConversationTreeWriter {
  /** Append a user-initiated entry. When idle, this writes immediately and
   *  returns the durable entry id so the caller can prove the provider request
   *  starts after the user turn landed. When already in a turn (the user sent
   *  a follow-up before the previous turn settled), it queues like any other
   *  completion-dependent message, lands at the next save point alongside the
   *  assistant response, and returns null because no durable id exists yet. */
  commitUserTurn(message: ConversationMessage, id?: string): Promise<string | null>;
  /** Append the live owner's record that `by` interrupted its own turn. Like
   *  `commitUserTurn` it queues mid-turn, but at idle it skips the sweep for
   *  a dead process's unfinished turn: the turn it ends is this process's
   *  own, parked, and its work since the last answer is that turn's, which
   *  this record accounts for.
   *
   *  The record's text is decided where it lands, from the turn's results
   *  ahead of it: it says a tool call was cut only when one of them is marked
   *  interrupted. A queued record therefore also reads results the cut turn
   *  enqueues after this call, as a runtime cut's settling tools do. The
   *  returned message is the record as the conversation reads now, which is
   *  what lands unless more of the turn arrives first; a parked loop, which
   *  has already enqueued all of its turn, holds it as its own history. */
  commitTurnEnd(by: PausedBy, id: string): Promise<ConversationMessage>;
  /** Commit held input only while idle, after finalized-result and interruption
   * recovery. Active turns reject rather than buffer. Append failures propagate. */
  commitQueuedUserInput(cell: QueuedUserInputCell): Promise<QueuedUserInputCommitResult>;
  /** Order module-owned durable work after the turn: it commits when the
   *  turn ends, or at once while the writer is idle, after the same recovery
   *  a person's message gets. It never commits behind a tool call awaiting
   *  results, so a question that waits for the person holds it, past the
   *  turn's end if a stop leaves that question open. A refused operation
   *  lands its notice and retires its cell in one batch; one whose commit
   *  throws is dropped from this writer and recorded, and never fails the
   *  save point. One that a concurrent change retained stays held, and the
   *  next commit point tries it again: the turn's end, or any acceptance
   *  while the writer is idle, a repeat of the same operation (a Resume)
   *  included. */
  acceptRetainedOperation(operation: HeldRetainedOperation): Promise<void>;
  /** Mark the writer as in-turn. Subsequent enqueueMessage calls buffer. */
  beginTurn(): void;
  /** The turn owner's declaration that no more in-turn writes will arrive:
   *  drains the buffer as the turn's last save point, releases every held
   *  notice, and returns the writer to idle once that batch commits. */
  endTurn(): Promise<void>;
  /** Buffer a completion-dependent message (assistant, tool_result, queued
   *  user). Flushes only at the next save point; the caller is responsible
   *  for invoking `flushSavePoint` at the appropriate boundary. The message
   *  also joins the tree's held turn, which is what lets a continuing turn in
   *  this process see its own unflushed output. */
  enqueueMessage(message: ConversationMessage, id?: string): Promise<void>;
  /** Whether a commit this writer holds behind the running turn names entry
   *  `id`: a message `commitUserTurn` took mid-turn, which no store holds
   *  until the turn's next save point. */
  holdsCommit(id: string): boolean;
  /** Drop the in-memory turn. */
  suspendPending(): void;
  /** Settle a turn suspended on a person's question at session end.
   *  The results its other calls finished land after the ask, so the
   *  question stays the open exchange the next activation offers, and
   *  nothing records the turn as ended: it waits for the answer. Call after
   *  suspendPending. */
  settleSuspendedTurn(): Promise<void>;
  /** Drain all pending messages as one SQLite fact. The caller invokes this
   *  at every save point inside a turn; the phase is untouched.
   *
   *  A save point is the moment where pending session writes become durable.
   *  The turn loop reaches it after the assistant message and any tool results have been
   *  observed in full, and before the next provider request is dispatched.
   *  Flushing here is what keeps the authoritative branch coherent: only
   *  completed turn fragments are persisted, never partial provider output.
   *  Notices held mid-turn ride the batch only when it leaves no tool call
   *  awaiting results, so they never split a tool exchange. */
  flushSavePoint(
    protectedToolUseIds?: ReadonlySet<string>,
    finalizedCheckpointSwaps?: readonly FinalizedCheckpointSwap[],
  ): Promise<void>;
  pendingCount(): number;
  /** Detached current context, including held messages and unresolved calls.
   * Does not flush, repair adjacency, or run recovery. */
  captureRawLiveMessages(): Promise<ConversationMessage[]>;
}


export function createConversationTreeWriter(deps: ConversationTreeWriterDeps): ConversationTreeWriter {
  const { tree } = deps;
  // Ordered FIFO buffer of conversation-tree writes that arrived during an active
  // turn and must wait for a save point. Scoped to the single write kind
  // Flywheel currently emits.
  const pending: { readonly message: ConversationMessage; readonly id: Promise<string> }[] = [];
  // Transcript commits that arrived while a turn was running (a review
  // notice, the interrupt marker). They are not the turn's output, so they
  // never split a tool exchange: a save point, idle or not, releases them
  // only once its batch leaves no tool call awaiting results, and the turn's
  // end releases whatever is still held. Suspending the turn drops pending,
  // never these: they record what happened.
  // A turn-end record is held by who interrupted, not by text, because its
  // text depends on the results that land ahead of it.
  const held: HeldCommit[] = [];
  const heldOperations: HeldRetainedOperation[] = [];
  let phase: WriterPhase = "idle";
  // Set when work is accepted while a releasing drain runs, so the drain
  // that ends the turn commits it once the writer is idle.
  let acceptedDuringRelease = false;
  // Serializes drains: appendMessages is async, so two concurrent flushes would
  // each snapshot the same pending prefix and append it twice. The lane keeps a
  // single drain in flight; the next runs only after the prior splices. A
  // failed drain rejects to its caller and never stops the drains after it.
  const drains = createOrderedLane();

  async function prepareIdleCommit(): Promise<void> {
    await deps.recoverFinalizedToolResults?.();
    await tree.recordInterruptedTurn("crash", { ownsBackgroundNotification: deps.ownsBackgroundNotification, ownsQueuedUserInput: deps.ownsQueuedUserInput });
  }

  async function commitUserTurn(message: ConversationMessage, id?: string): Promise<string | null> {
    if (phase === "idle") {
      // Ahead of the turn, so a turn a dead process left unfinished is recorded
      // where it happened rather than after the message that resumes it. Idle
      // is the only branch that needs it: a mid-turn arrival means this process
      // is already running the turn.
      await prepareIdleCommit();
      const committedId = await tree.appendMessage(message, id);
      releaseNotifications([message]);
      return committedId;
    }
    held.push(id === undefined ? { message } : { message, id });
    return null;
  }

  async function commitTurnEnd(by: PausedBy, id: string): Promise<ConversationMessage> {
    // Held before the branch read, so held records keep the order they were
    // asked for: a person's interrupt of a turn the runtime cut is the last
    // turn end even when the cut's read of the branch is slower.
    const holding = phase !== "idle";
    if (holding) held.push({ turnEnd: by, id });
    const record = turnEndRecord(by, [...await tree.getBranch(), ...pending.map(({ message }) => tailEntry(message))]);
    if (!holding) await tree.appendMessage(record, id);
    return record;
  }

  async function commitQueuedUserInput(cell: QueuedUserInputCell): Promise<QueuedUserInputCommitResult> {
    if (phase !== "idle") throw new Error("Queued user input cannot commit during an active turn");
    await prepareIdleCommit();
    return tree.commitQueuedUserInput(cell);
  }

  async function acceptRetainedOperation(operation: HeldRetainedOperation): Promise<void> {
    // A repeat of held work, such as a Resume that read the same cell, adds
    // no second copy. On an idle writer it is still a commit point: work that
    // a concurrent change retained has no other trigger until a turn ends.
    if (!heldOperations.some((heldOperation) =>
      heldOperation.kind === operation.kind && heldOperation.key === operation.key)) heldOperations.push(operation);
    acceptedDuringRelease = true;
    if (phase === "idle") {
      // The settled record the operation commits moves the interruption
      // boundary, so a turn a dead process left unfinished is recorded first.
      await prepareIdleCommit();
      await chainDrain((drained) => drainSavePoint(drained, {}));
    }
  }

  function beginTurn(): void {
    phase = "in_turn";
  }

  function endTurn(): Promise<void> {
    return chainDrain((drained) => releaseTurn(drained, { release: true }));
  }

  /** Ends a turn and makes the writer idle inside the same drain. Work
   *  accepted while that drain ran found the writer busy and did not drain,
   *  so it commits here, as it would have on an idle writer. */
  async function releaseTurn(drained: number, options: DrainOptions): Promise<void> {
    acceptedDuringRelease = false;
    await drainSavePoint(drained, options);
    phase = "idle";
    if (!acceptedDuringRelease || heldOperations.length === 0) return;
    acceptedDuringRelease = false;
    await prepareIdleCommit();
    await drainSavePoint(pending.length, {});
  }

  async function enqueueMessage(message: ConversationMessage, id?: string): Promise<void> {
    const reservedId = id === undefined ? (async () => {
      const key = message.kind === "user" ? heldEntryKey(message) : undefined;
      if (key !== undefined) {
        const existing = pending.map((record) => record.id);
        if (!(await Promise.all(existing)).includes(key) && await tree.getEntry(key) === undefined) return key;
      }
      return tree.getStorage().allocateId();
    })() : Promise.resolve(id);
    pending.push({ message, id: reservedId });
    await tree.holdPendingMessage(message, await reservedId);
  }

  function suspendPending(): void {
    const abandoned = pending.splice(0);
    for (const { message } of abandoned) {
      if (message.kind !== "user") continue;
      for (const key of message.backgroundNotificationIds ?? []) deps.abandonBackgroundNotification?.(key);
    }
    // enqueueMessage owns any allocation failure; this follower only retires
    // allocations that succeeded after the turn was dropped.
    for (const record of abandoned) void record.id.then((id) => tree.getStorage().releaseId(id), () => {});
    tree.releasePendingMessages();
    phase = "idle";
  }

  async function settleSuspendedTurn(): Promise<void> {
    if (phase !== "idle") throw new Error("settleSuspendedTurn requires the pending turn to be suspended first");
    await deps.recoverFinalizedToolResults?.();
  }

  function flushSavePoint(
    protectedToolUseIds?: ReadonlySet<string>,
    finalizedCheckpointSwaps: readonly FinalizedCheckpointSwap[] = [],
  ): Promise<void> {
    const protectedIds = new Set(protectedToolUseIds);
    return chainDrain((drained) => drainSavePoint(drained, { protectedToolUseIds: protectedIds, finalizedCheckpointSwaps }));
  }

  /** Serializes one drain behind every earlier one. The owned prefix is
   *  measured now, so a message enqueued while an earlier drain is still
   *  committing waits for the next save point instead of riding this one. */
  function chainDrain(drain: (drained: number) => Promise<void>): Promise<void> {
    const drained = pending.length;
    return drains.run(() => drain(drained));
  }

  interface DrainOptions {
    readonly protectedToolUseIds?: ReadonlySet<string>;
    readonly finalizedCheckpointSwaps?: readonly FinalizedCheckpointSwap[];
    /** The turn is over: release held notices even behind a tool call
     *  awaiting results, because nothing will close that exchange, and
     *  commit held operations once that exchange is closed. */
    readonly release?: boolean;
  }

  async function drainSavePoint(drained: number, options: DrainOptions): Promise<void> {
    const owned = Math.min(drained, pending.length);
    const records = pending.slice(0, owned);
    const messages = records.map(({ message }) => message);
    const reservedIds = await Promise.all(records.map(({ id }) => id));
    const reservations = new Map(messages.map((message, index) => [message, reservedIds[index]]));
    const turnBatch = await repairSavePointExtension(tree, messages, options.protectedToolUseIds ?? new Set());
    // Idle is no exception: a question a stop left open is a tool call that
    // still awaits its result, and its answer must land right after it.
    const tail = turnBatch.at(-1) ?? await committedTail(tree);
    const releasing = options.release === true || !awaitsToolResults(tail);
    const released = releasing ? held.length : 0;
    const releasedHeld = held.slice(0, released);
    const batch = [...turnBatch];
    // Adjacency repair keeps original message objects and synthesizes only gap
    // records. An original keeps its reservation; a new gap gets a new id.
    const ids = turnBatch.map((message) => reservations.get(message));
    let committed: readonly TurnEndEntry[] | undefined;
    for (const notice of releasedHeld) {
      if ("turnEnd" in notice) {
        committed ??= await tree.getBranch();
        batch.push(turnEndRecord(notice.turnEnd, [...committed, ...batch.map((message, index) => tailEntry(message, ids[index]))]));
      } else {
        batch.push(notice.message);
      }
      ids.push(notice.id);
    }
    if (batch.length > 0) {
      const keyedIds = await notificationEntryIds(batch, ids);
      const outcome = await tree.appendMessages(batch, keyedIds, (options.finalizedCheckpointSwaps ?? []).map((swap) => ({
        op: "swap" as const,
        kind: swap.kind,
        key: swap.key,
        expectedRaw: swap.expectedRaw,
        payload: null,
      })));
      switch (outcome.kind) {
        case "committed":
          releaseNotifications(batch);
          pending.splice(0, owned);
          held.splice(0, released);
          break;
        case "notCommitted": {
          if (outcome.cause instanceof PersistenceWriteRefused) throw outcome.cause;
          const reason = errorMessage(outcome.cause);
          throw new Error(`Session tree batch was not committed: ${reason}`);
        }
      }
    }
    // Held work commits only once the turn releases: at its end, or while
    // the writer is idle. Its record settles the exchange it answers, so in
    // the middle of a turn it would sit between a tool result and the
    // model's answer, which the model would read as the person's words; its
    // cell is durable, so it can wait. Nor does it land behind a tool call
    // that awaits its result, not even at a turn's end, as a held notice
    // can: a stop that suspends a turn on a question ends the turn while the
    // question stays open, and the person's answer must follow the call.
    if (options.release !== true && phase !== "idle") return;
    if (awaitsToolResults(batch.at(-1) ?? tail)) return;
    while (heldOperations.length > 0) {
      const operation = heldOperations[0];
      if (!operation) return;
      // What follows once the operation's record is durable.
      let landed: (() => void | Promise<void>) | undefined;
      try {
        const result = await operation.commit();
        if (result.kind === "retained") return;
        if (result.kind === "refused") {
          const outcome = await tree.appendMessages([result.notice], [result.noticeId], [result.retire]);
          if (outcome.kind === "notCommitted") throw outcome.cause;
          landed = () => { operation.landed?.(); };
        } else {
          landed = async () => { await result.dispatch(); operation.landed?.(); };
        }
      } catch (error) {
        // A failure the module did not state as a refusal never fails the
        // save point: the turn still ends at idle, and no later drain retries
        // the operation forever. Its cell stays, so a later Resume can try
        // it again.
        log.error("held operation commit failed", { kind: operation.kind, key: operation.key, errorName: error instanceof Error ? error.name : typeof error });
      }
      heldOperations.shift();
      await landed?.();
    }
  }

  function releaseNotifications(messages: readonly ConversationMessage[]): void {
    for (const message of messages) {
      if (message.kind !== "user") continue;
      for (const key of message.backgroundNotificationIds ?? []) deps.releaseBackgroundNotification?.(key);
    }
  }

  /** Names the entry of each background notification and of each message
   *  from another session by its cell key, so a later delivery of the same
   *  input finds it committed and adds nothing.
   *  A key the tree or an earlier message of the batch already names keeps a
   *  fresh id: a notification the loop already read commits as it was read,
   *  and never fails the save point on a duplicate entry id. */
  async function notificationEntryIds(batch: readonly ConversationMessage[], ids: readonly (string | undefined)[]): Promise<(string | undefined)[]> {
    const named: (string | undefined)[] = [];
    for (const [index, message] of batch.entries()) {
      const key = message.kind === "user" ? heldEntryKey(message) : undefined;
      const fresh = key !== undefined && ids[index] === undefined && !named.includes(key) && await tree.getEntry(key) === undefined;
      named.push(fresh ? key : ids[index]);
    }
    return named;
  }

/** The cell key that names the entry of one held user message: the hold of
 *  its one background notification, or the hold of its one message from
 *  another session, so a replay of either delivery converges on one entry. */
function heldEntryKey(message: Extract<ConversationMessage, { kind: "user" }>): string | undefined {
  if (message.backgroundNotificationIds?.length === 1) return message.backgroundNotificationIds[0];
  if (message.dispatchIds?.length === 1) return message.dispatchIds[0];
  return undefined;
}

/** A commit held behind the running turn: a notice with its text, or a
 *  turn-end record whose text waits for the results that land ahead of it. */
type HeldCommit =
  | { readonly message: ConversationMessage; readonly id?: string }
  | { readonly turnEnd: PausedBy; readonly id: string };

function turnEndRecord(by: PausedBy, tail: readonly TurnEndEntry[]): ConversationMessage {
  return { kind: "user", content: interruptedTurnMessage(by, cutRunningToolCall(tail)), origin: "system" };
}

/** An uncommitted message as the turn-end readers see an entry. */
function tailEntry(message: ConversationMessage, id = ""): TurnEndEntry {
  return { kind: "message", id, message };
}

/** The shape both a pending message and a committed entry's message share,
 *  which is all the exchange-boundary test reads. */
interface MessageTail {
  readonly kind: string;
  readonly content: string | ReadonlyArray<{ readonly type: string }>;
}

/** A tool call whose results have not been committed yet: the one message a
 *  held notice must not follow, because the results must. */
function awaitsToolResults(message: MessageTail | undefined): boolean {
  return message?.kind === "assistant"
    && typeof message.content !== "string"
    && message.content.some((block) => block.type === "tool_use");
}

async function committedTail(conversationTree: ConversationTree): Promise<MessageTail | undefined> {
  const tail = (await conversationTree.getBranch()).at(-1);
  return tail?.kind === "message" ? tail.message : undefined;
}

async function repairSavePointExtension(
  conversationTree: ConversationTree,
  messages: readonly ConversationMessage[],
  protectedToolUseIds: ReadonlySet<string>,
): Promise<ConversationMessage[]> {
  const tail = (await conversationTree.getBranch()).at(-1);
  if (tail?.kind !== "message" || tail.message.kind !== "assistant" || typeof tail.message.content === "string") {
    return runInTaskSlices("conversation:repair-tool-adjacency", repairToolAdjacencyWork(messages, protectedToolUseIds));
  }
  const resultCount = messages.findIndex((message) => message.kind !== "toolResult");
  const leadingResults = messages.slice(0, resultCount < 0 ? messages.length : resultCount);
  const actualIds = leadingResults.flatMap((message) => message.kind === "toolResult" ? [message.toolUseId] : []);
  // A question a stop suspended has no result in its turn's batch: it is
  // answered later through its own durable facts, so the other calls'
  // results close the exchange without it (PI-INTERACTION-009).
  const expectedIds = tail.message.content.flatMap((block) =>
    block.type === "tool_use" && !(block.name === "ask_user" && !actualIds.includes(block.id)) ? [block.id] : []);
  const complete = expectedIds.length > 0
    && expectedIds.length === actualIds.length
    && new Set(expectedIds).size === expectedIds.length
    && new Set(actualIds).size === actualIds.length
    && expectedIds.every((id) => actualIds.includes(id));
  if (!complete) return runInTaskSlices("conversation:repair-tool-adjacency", repairToolAdjacencyWork(messages, protectedToolUseIds));
  return [...leadingResults, ...await runInTaskSlices("conversation:repair-tool-adjacency", repairToolAdjacencyWork(messages.slice(leadingResults.length), protectedToolUseIds))];
}

  return {
    commitUserTurn,
    commitTurnEnd,
    commitQueuedUserInput,
    acceptRetainedOperation,
    beginTurn,
    endTurn,
    enqueueMessage,
    holdsCommit: (id) => held.some((commit) => commit.id === id),
    suspendPending,
    settleSuspendedTurn,
    flushSavePoint,
    pendingCount: () => pending.length,
    captureRawLiveMessages: () => tree.captureRawLiveMessages(),
  };
}
