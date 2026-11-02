import type { ConversationMessage } from "../../agent-runtime/llm/types.js";
import { hasInterruptedWork, interruptedTurnEntryId, interruptedWorkMessage, readInterruptedWork, type InterruptedTurnReason } from "./interrupted-turn-summary.js";
import { chatTurnEndOf, endsAtTurnEnd, isPlannedCut, questionExchangeOf } from "./turn-end-record.js";
import { isRecoveredToolResultEntryId } from "../finalized-tool-result-checkpoint.js";
import { decodeQueuedUserInput, QUEUED_USER_INPUT_IN_FLIGHT_KIND, queuedInputDrops, queuedInputMessage, type QueuedUserInputCell, type QueuedUserInputCommitResult } from "./queued-user-inputs.js";
import { decodeQueuedBackgroundNotification, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, queuedBackgroundNotificationDrops, queuedBackgroundNotificationMessage, type QueuedBackgroundNotification } from "./queued-background-notifications.js";
import { replyWaitRetirements } from "./reply-wait-cells.js";
import type { ConversationInputCapture, ConversationTreeStorage } from "./conversation-tree-storage.js";
import { InFlightSwapConflictError, type EventStoreAppend, type InFlightWrite } from "../../../infra/event-store-types.js";
import { runInTaskSlices, type TaskSliceScheduling } from "../../../infra/task-scheduling.js";
import type { ConversationTreeProjectionState } from "./conversation-projection.js";
import type { BranchSummaryEntry, CompactionEntry, MessageEntry, ConversationEntry } from "./conversation-entry-types.js";
import { AssistantPrefillSessionContextError, buildCommittedForkMessagesWork, buildSessionContextWork, reconstructRawSessionMessages, type BuildSessionContextOptions, type SessionContext } from "./conversation-tree-context.js";


function persistedMessage(message: ConversationMessage): MessageEntry["message"] {
  switch (message.kind) {
    case "toolResult":
      // Tool output parts persist verbatim; schema validates the shape on load.
      return {
        kind: "toolResult",
        toolUseId: message.toolUseId,
        content: message.content,
        ...(message.isError ? { isError: true } : {}),
        ...(message.interrupted ? { interrupted: true } : {}),
        ...(message.blocked ? { blocked: true } : {}),
      };
    case "system":
      return {
        kind: "system",
        content: message.content,
        ...(message.mutationEvidence ? { mutationEvidence: message.mutationEvidence } : {}),
        ...(message.contentRepair ? { contentRepair: message.contentRepair } : {}),
      };
    case "compactionSummary":
      return { kind: "compactionSummary", content: message.content };
    case "assistant":
      return {
        kind: "assistant",
        content: message.content,
        ...(message.incomplete === true ? { incomplete: true } : {}),
        // Serving attribution travels with the content so the same-provider
        // replay gates still hold after a rebuild (a message without it is
        // treated as cross-provider and its opaque blocks are downgraded).
        ...(message.accessProvider ? { accessProvider: message.accessProvider } : {}),
        ...(message.provider ? { provider: message.provider } : {}),
        ...(message.api ? { api: message.api } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(message.responseId ? { responseId: message.responseId } : {}),
        ...(message.reasoningTokens !== undefined ? { reasoningTokens: message.reasoningTokens } : {}),
      };
    case "user":
      return {
        kind: "user",
        content: message.content,
        ...(message.origin ? { origin: message.origin } : {}),
        ...(message.producer ? { producer: message.producer } : {}),
        ...(message.invocation ? { invocation: message.invocation } : {}),
        ...(message.submissionIds?.length ? { submissionIds: message.submissionIds } : {}),
        ...(message.replyRequired === true ? { replyRequired: true } : {}),
        ...(message.runtimeNotice === true ? { runtimeNotice: true } : {}),
        ...(message.framing ? { framing: message.framing } : {}),
      };
  }
}

/** The display-only flag travels on the message but persists at the entry
 *  level, where every reader (context rebuild, recall, FTS) already checks it. */
function displayOnlyEntry(message: ConversationMessage): boolean {
  return message.kind === "system" && message.displayOnly === true;
}

export async function createConversationMessageEntries(
  messages: readonly ConversationMessage[],
  parentId: string | null,
  allocateId: () => string | Promise<string>,
  now: () => string,
): Promise<MessageEntry[]> {
  const entries: MessageEntry[] = [];
  let nextParentId = parentId;
  for (const message of messages) {
    const entry = createConversationMessageEntry(message, await allocateId(), nextParentId, now());
    nextParentId = entry.id;
    entries.push(entry);
  }
  return entries;
}

/** Prepares one canonical message for synchronous atomic recovery publication. */
export function createConversationMessageEntry(message: ConversationMessage, id: string, parentId: string | null, timestamp: string): MessageEntry {
  return { kind: "message", id, parentId, timestamp, message: persistedMessage(message), ...(displayOnlyEntry(message) ? { displayOnly: true } : {}) };
}

/** In-flight cells retired by the append that makes their messages durable,
 *  with the cells of the reply waits whose end notices those messages are. */
function queuedMessageDrops(messages: readonly ConversationMessage[], workflowId: string | undefined) {
  const userIds = messages.flatMap((message) => (message.kind === "user" ? message.dispatchIds ?? [] : []));
  const notificationIds = messages.flatMap((message) => (message.kind === "user" ? message.backgroundNotificationIds ?? [] : []));
  const drops = [...(queuedInputDrops(userIds, workflowId) ?? []), ...queuedBackgroundNotificationDrops(notificationIds), ...replyWaitRetirements(messages)];
  return drops.length > 0 ? drops : undefined;
}

interface BranchSummaryInput {
  summary: string;
}

/** `tokensBefore` and `tokensAfter` both estimate the whole next prompt,
 *  system prompt and tool schemas included, so the transcript's compaction
 *  report and the context gauge describe one quantity. */
type CompactionInput = {
  sourceLeafId: string;
  tokensBefore: number;
  tokensAfter: number;
  /** The messages that open the fresh context, chained after the reset in
   *  the same commit, so no reader ever sees the reset without them. A
   *  message with no `id` gets an allocated one. */
  opening: readonly ContextOpening[];
};

/** A message that opens a reset's fresh context: a carried turn-end record
 *  (`carriedTurnEndRecord`), the note listing, or the recovery text. */
export interface ContextOpening {
  readonly message: ConversationMessage;
  readonly id?: string;
}

/** Result of an in-turn message batch append. `committed` is the happy path
 *  and includes the assigned ids in input order. `notCommitted` surfaces a
 *  failed write so the caller (ConversationTreeWriter) can restore pending or
 *  escalate without inspecting error codes. SQLite appends are transactional,
 *  so a failed append leaves no partial bytes behind. */
type AppendMessagesOutcome =
  | { kind: "committed"; ids: string[] }
  | { kind: "notCommitted"; cause: unknown };

export class ConversationTree {
  private cachedContext: SessionContext | null = null;
  private cachedBranchLeaf: string | null | undefined = undefined;
  constructor(private readonly storage: ConversationTreeStorage, private readonly scheduling?: TaskSliceScheduling) {}

  getStorage(): ConversationTreeStorage {
    return this.storage;
  }

  getLeafId(): Promise<string | null> {
    return this.storage.getLeafId();
  }



  getEntry(id: string): Promise<ConversationEntry | undefined> {
    return this.storage.getEntry(id);
  }

  getState(): Promise<ConversationTreeProjectionState> {
    return this.storage.getState();
  }

  async getBranch(fromId?: string): Promise<ConversationEntry[]> {
    return fromId === undefined ? this.storage.getActiveBranch() : this.storage.getPathToRoot(fromId);
  }

  async buildContext(options?: { allowAssistantTail?: boolean }): Promise<SessionContext> {
    const input = await this.storage.captureInput();
    const { leafId, pending } = input;
    // The pending tip joins the key: a held turn extends the branch without
    // moving the durable leaf, so the leaf alone would serve a stale context.
    const branchKey = pending.length === 0 ? leafId : `${leafId ?? "root"}+${pending.at(-1)?.id ?? ""}`;
    const cacheKey = `${branchKey ?? "root"}:${input.degradedLength}:${options?.allowAssistantTail === true ? "assistant-tail" : "user-tail"}`;
    if (this.cachedContext !== null && this.cachedBranchLeaf === cacheKey) {
      return this.cachedContext;
    }
    const context = await runInTaskSlices("conversation:context", this.contextWork(input, options), this.scheduling);
    this.cachedContext = context;
    this.cachedBranchLeaf = cacheKey;
    return context;
  }

  private *contextWork(input: ConversationInputCapture, options?: BuildSessionContextOptions): Generator<void, SessionContext> {
    const branch = yield* this.storage.transcriptWork(input, true);
    return yield* buildSessionContextWork([...branch, ...input.pending], options);
  }

  /** Captures current model history, including held turn entries, before
   * adjacency repair. Unresolved tool calls remain unresolved. The detached
   * copy respects compaction and never flushes or changes the source tree. */
  async captureRawLiveMessages(): Promise<ConversationMessage[]> {
    const input = await this.storage.captureInput();
    return runInTaskSlices("conversation:raw-live-messages", this.rawLiveMessagesWork(input), this.scheduling);
  }

  private *rawLiveMessagesWork(input: ConversationInputCapture): Generator<void, ConversationMessage[]> {
    const branch = yield* this.storage.transcriptWork(input, true);
    const messages = yield* reconstructRawSessionMessages([...branch, ...input.pending]);
    const captured: ConversationMessage[] = [];
    for (const message of messages) {
      yield;
      captured.push(structuredClone(message));
    }
    return captured;
  }

  async captureCommittedForkMessages(): Promise<ConversationMessage[]> {
    const input = await this.storage.captureInput();
    return runInTaskSlices("conversation:fork-messages", this.committedForkMessagesWork(input), this.scheduling);
  }

  private *committedForkMessagesWork(input: ConversationInputCapture): Generator<void, ConversationMessage[]> {
    const branch = yield* this.storage.committedActiveBranchWork(input);
    if (branch.degraded) {
      throw new Error("Cannot fork a degraded conversation branch");
    }
    return yield* buildCommittedForkMessagesWork(branch.entries);
  }

  async appendMessage(message: ConversationMessage, id?: string): Promise<string> {
    if (id && await this.getEntry(id)) return id;
    const result = await this.appendMessages([message], [id]);
    if (result.kind !== "committed") {
      const cause = result.cause instanceof Error ? `: ${result.cause.message}` : "";
      throw new Error(`ConversationTree.appendMessage failed: ${result.kind}${cause}`);
    }
    const [committedId] = result.ids;
    if (committedId === undefined) throw new Error("ConversationTree.appendMessage: committed result missing id for single-message input");
    return committedId;
  }

  /** Prepares messages under the ids their caller chose, chained off the
   *  leaf, without publishing them. The caller commits the append in one
   *  store transaction with facts of other aggregates, such as a recovered
   *  result's evidence or a runtime call's invocation. A message whose id the
   *  tree already holds is skipped, so a retried preparation converges; empty
   *  when the tree holds every one. The append is guarded on the leaf it
   *  extends (`BranchExtension`). */
  async prepareMessagesAppend(
    messages: readonly { readonly id: string; readonly message: ConversationMessage }[],
  ): Promise<readonly EventStoreAppend[]> {
    return this.storage.prepareEntriesAppend(async (state) => {
      const absent = messages.filter(({ id }) => !state.entriesById[id]);
      if (absent.length === 0) return [];
      const entries = await this.createMessageEntries(absent.map(({ message }) => message), state.leafId, absent.map(({ id }) => id));
      return await this.rejectInvalidExtension(state.leafId, entries) ?? entries;
    });
  }

  /** Record what a turn that never reached its save point had already done,
   *  if any turn was, then restore any user messages the dead process had
   *  queued but never made durable.
   *
   *  Called at every idle commit, which is what makes it safe without a lock:
   *  only the process that owns this conversation commits, and an idle owner
   *  runs no turn. Its own last turn committed the results of its calls, as
   *  a turn parked on a wait does with no reply after them, so the actions
   *  above the boundary that this conversation's requests made and its
   *  branch does not answer belong to a turn that never reached its save
   *  point. The record is an ordinary entry, so it renders in the
   *  transcript, replays in its chronological place, and needs no special
   *  case in the context builder.
   *
   *  The actions are the whole of it. Tool calls and file changes commit as
   *  they happen, so they survive; the assistant's unfinished reply does not,
   *  and is the one part a resuming turn can write better with the results in
   *  hand (ARCH-SUBSTRATE-037).
   *
   *  `cutsRestoredWait` says that no successor holds the continuation of this
   *  conversation's session, so the dead owner was the last to hold a wait
   *  that a planned cut handed it. The exit is then recorded over that cut
   *  too, and the wait that the next attach restores parks only
   *  (`RestoredAgentWait.parkOnly`). `holdsWait` names the reply waits that
   *  are still open, because the tail alone cannot classify a reply wait. */
  async recordInterruptedTurn(reason: InterruptedTurnReason = "crash", options: { readonly ownerDead?: boolean; readonly cutsRestoredWait?: boolean; readonly holdsWait?: (toolUseId: string) => boolean; readonly ownsBackgroundNotification?: (key: string) => boolean; readonly ownsQueuedUserInput?: (key: string) => boolean } = {}): Promise<void> {
    const boundary = await this.storage.getInterruptionBoundary();
    const id = interruptedTurnEntryId(boundary, reason);
    if (!await this.storage.getEntry(id)) {
      const branch = await this.getBranch();
      // A result that recovery committed for a dead owner's turn answers its
      // call in the transcript, but that turn still ended in the crash.
      const answeredToolUseIds = new Set(branch.flatMap((entry) =>
        entry.kind === "message" && entry.message.kind === "toolResult" && !isRecoveredToolResultEntryId(entry.id) ? [entry.message.toolUseId] : []));
      const work = await readInterruptedWork(this.storage.getStore(), {
        sessionId: this.storage.getSessionId(),
        conversationId: this.storage.getConversationId(),
        answeredToolUseIds,
      }, boundary);
      // Only recovery over a dead owner may read an unanswered message as an
      // unfinished turn: a live writer commits a task and its held input at
      // consecutive idle boundaries with no request between them. For the
      // dead owner, a turn that died before its first tool call, or while
      // the calls of its last step ran, left no work facts after the
      // boundary, but its record is what lets Resume find it and the
      // transcript name the exit.
      const turnEnd = options.ownerDead === true ? chatTurnEndOf(branch, options.holdsWait) : undefined;
      const unfinished = turnEnd?.recorded === false;
      // A planned cut of a background wait hands the wait to its successor.
      // When that successor died with no successor of its own, its exit is
      // what last cut the wait. A newest record of any other cut already
      // makes the wait park only, so it gets no second record.
      const cutWait = options.cutsRestoredWait === true && turnEnd?.backgroundWait === true && isPlannedCut(turnEnd.end);
      // Work after a branch that ends at its turn-end record belongs to the
      // turn that record already ended: an earlier recovery pass closed a
      // call it made, and no request has run since. Work after a branch that
      // ends at a person's question, answered or not, is that question's
      // exchange: its turn was not interrupted.
      const unrecorded = hasInterruptedWork(work) && !endsAtTurnEnd(branch) && questionExchangeOf(branch) === undefined;
      if (unrecorded || unfinished || cutWait) {
        await this.appendMessage({ kind: "user", content: interruptedWorkMessage(work, reason), origin: "system" }, id);
      }
    }
    // A dead owner leaves its queued input for this record to restore,
    // whichever of a crash or a person's interrupt ended the process.
    await this.recoverQueuedMessages(options.ownsBackgroundNotification, options.ownsQueuedUserInput);
  }

  /** Restore process-local messages from their distinct durable checkpoints. */
  private async recoverQueuedMessages(ownsBackgroundNotification?: (key: string) => boolean, ownsQueuedUserInput?: (key: string) => boolean): Promise<void> {
    const store = this.storage.getStore();
    const sessionId = this.storage.getSessionId();
    const conversationId = (await this.storage.getState()).conversationId ?? "";
    const rows = await store.readInFlight(sessionId, [
      QUEUED_USER_INPUT_IN_FLIGHT_KIND,
      QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
    ]);
    for (const row of rows) {
      const userInput = decodeQueuedUserInput(row, sessionId, conversationId);
      const notification = decodeQueuedBackgroundNotification(row, conversationId);
      if (userInput) {
        if (ownsQueuedUserInput?.(userInput.key)) continue;
        if (await this.commitQueuedUserInput(userInput) === "contended") {
          throw new Error(`Queued user input recovery contended (${userInput.key}); later input cannot commit`);
        }
        continue;
      }
      if (notification && !ownsBackgroundNotification?.(notification.key)) await this.commitQueuedBackgroundNotification(notification);
    }
  }

  /** Commit the original held input under its canonical key, retiring only the
   * exact cell read. Existing entries converge; only a raw-swap conflict is
   * contention. Other append and storage failures propagate unchanged. */
  async commitQueuedUserInput(cell: QueuedUserInputCell): Promise<QueuedUserInputCommitResult> {
    if (await this.getEntry(cell.key)) return "committed";
    const outcome = await this.storage.appendEntryIfAbsent(cell.key, (state) => this.createMessageEntries([queuedInputMessage(cell)], state.leafId, cell.key), [{
      op: "swap",
      kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND,
      key: cell.key,
      expectedRaw: cell.raw,
      payload: null,
      ...(cell.target === "workflow" ? { sessionId: cell.workflowId } : {}),
    }]);
    if (outcome.kind === "notCommitted") {
      if (outcome.cause instanceof InFlightSwapConflictError) return "contended";
      throw outcome.cause;
    }
    this.invalidateCache();
    return "committed";
  }

  /** Commits one notice that this conversation holds under its key, in the
   *  same append that retires its cell. A notice already committed changes
   *  nothing. */
  async commitQueuedBackgroundNotification(notification: QueuedBackgroundNotification): Promise<void> {
    const { key } = notification;
    if (await this.getEntry(key)) return;
    const message = queuedBackgroundNotificationMessage(notification);
    const outcome = await this.storage.appendEntryIfAbsent(key, (state) => this.createMessageEntries([message], state.leafId, key), queuedMessageDrops([message], this.storage.getWorkflowId()));
    if (outcome.kind === "notCommitted") throw new Error("ConversationTree.recoverQueuedMessages failed", { cause: outcome.cause });
    this.invalidateCache();
  }

  /** Batched message append as one SQLite fact. Used by the save-point flush
   *  so a whole assistant/tool_result group becomes durable atomically. Returns
   *  the storage outcome so the writer can drain pending only on `committed`.
   *  Queued-input cells whose messages this batch carries retire in the same
   *  commit unit, so a message and its dispatch checkpoint never coexist. */
  async appendMessages(
    messages: readonly ConversationMessage[],
    /** Ids for the messages that name their own entry (a queued cell's key,
     *  a turn-end record); an absent id allocates one. */
    ids: ReadonlyArray<string | undefined> = [],
    guardedSwaps: readonly InFlightWrite[] = [],
  ): Promise<AppendMessagesOutcome> {
    if (messages.length === 0) return { kind: "committed", ids: [] };
    let entries: readonly MessageEntry[] = [];
    const outcome = await this.storage.extendBranch(async (state) => {
      entries = await this.createMessageEntries(messages, state.leafId, ids);
      return await this.rejectInvalidExtension(state.leafId, entries) ?? entries;
    }, [
      ...(queuedMessageDrops(messages, this.storage.getWorkflowId()) ?? []),
      ...guardedSwaps,
    ]);
    if (outcome.kind === "committed") {
      this.invalidateCache();
      return { kind: "committed", ids: entries.map((entry) => entry.id) };
    }
    return outcome;
  }

  /** Hold one message of the turn in progress, chained off the held tip (else
   *  the durable leaf).
   *
   *  Memory only. The held turn is what lets a continuing turn in this process
   *  see its own output before the save point commits it; a turn this process
   *  did not write is reported from its actions' own facts instead. */
  async holdPendingMessage(message: ConversationMessage, id?: string): Promise<void> {
    const reservedId = id ?? await this.storage.allocateId();
    const leafId = await this.storage.getLeafId();
    const pending = this.storage.getPendingEntries();
    const entry: MessageEntry = {
      kind: "message",
      id: reservedId,
      parentId: pending.at(-1)?.id ?? leafId,
      timestamp: new Date().toISOString(),
      message: persistedMessage(message),
      ...(displayOnlyEntry(message) ? { displayOnly: true } : {}),
    };
    this.storage.appendPending(entry);
    this.invalidateCache();
  }

  /** Drop the held turn without committing it. */
  releasePendingMessages(): void {
    this.storage.clearPending();
    this.invalidateCache();
  }

  /** Structural gate: an entry batch may extend the branch only if the
   *  extended branch still projects into a provider-valid context. Trailing
   *  assistant prefill is the expected mid-conversation state (the next user
   *  turn resolves it), so it passes. Any other violation - e.g. a lost user
   *  turn leaving two complete assistant messages adjacent - is refused
   *  before a byte lands; the writer keeps the batch pending instead of
   *  durably corrupting the branch. */
  private async rejectInvalidExtension(
    leafId: string | null,
    entries: readonly ConversationEntry[],
  ): Promise<Extract<AppendMessagesOutcome, { kind: "notCommitted" }> | null> {
    const input = await this.storage.captureInput();
    return runInTaskSlices("conversation:extension-check", this.extensionRejectionWork({ ...input, leafId }, entries), this.scheduling);
  }

  private *extensionRejectionWork(
    input: ConversationInputCapture,
    entries: readonly ConversationEntry[],
  ): Generator<void, Extract<AppendMessagesOutcome, { kind: "notCommitted" }> | null> {
    // A broken stored branch is a storage error, not a refused batch, so the walk stays outside the try.
    // The gate judges the recovered branch the provider receives, gaps
    // included: a gap stands where an unreadable turn was, so the readable
    // reply after it does not sit next to the reply before it.
    const recovered = yield* this.storage.transcriptWork(input, true);
    const branch = recovered.filter((entry): entry is ConversationEntry => entry.kind !== "degraded");
    try {
      yield* validateRawToolResultOwnership(branch, entries);
      yield* buildSessionContextWork([...recovered, ...entries]);
      return null;
    } catch (err) {
      if (err instanceof AssistantPrefillSessionContextError) return null;
      return { kind: "notCommitted", cause: err };
    }
  }

  private async createMessageEntries(messages: readonly ConversationMessage[], leafId: string | null, ids: string | ReadonlyArray<string | undefined> = []): Promise<MessageEntry[]> {
    const named = typeof ids === "string" ? [ids] : ids;
    let index = 0;
    return createConversationMessageEntries(
      messages,
      leafId,
      () => named[index++] ?? this.storage.allocateId(),
      () => new Date().toISOString(),
    );
  }

  /** Append a context-reset entry with its source boundary. The source leaf must exist
   *  and be on the current parent branch; without that ancestry guard,
   *  reconstruction would splice an unrelated branch and durably corrupt the
   *  model-visible context. */
  async appendCompaction(input: CompactionInput, signal?: AbortSignal): Promise<string> {
    const source = await this.storage.getEntry(input.sourceLeafId);
    if (!source) {
      throw new Error(`ConversationTree.appendCompaction: sourceLeafId ${input.sourceLeafId} is not in storage`);
    }
    return this.appendTyped(async (state) => {
      const parentBranch = await this.storage.getPathToRoot(state.leafId);
      if (!parentBranch.some((entry) => entry.id === input.sourceLeafId)) {
        throw new Error(`ConversationTree.appendCompaction: sourceLeafId ${input.sourceLeafId} is not an ancestor of parent leaf ${state.leafId ?? "root"}`);
      }
      const compaction = {
        kind: "compaction",
        id: await this.storage.allocateId(),
        parentId: state.leafId,
        timestamp: new Date().toISOString(),
        mode: "reset",
        sourceLeafId: input.sourceLeafId,
        tokensBefore: input.tokensBefore,
        tokensAfter: input.tokensAfter,
      } satisfies CompactionEntry;
      const opening: MessageEntry[] = [];
      for (const { message, id } of input.opening) {
        opening.push(createConversationMessageEntry(message, id ?? await this.storage.allocateId(), opening.at(-1)?.id ?? compaction.id, compaction.timestamp));
      }
      return [compaction, ...opening];
    }, signal);
  }

  async moveTo(targetId: string | null, summary?: BranchSummaryInput): Promise<string | undefined> {
    const moved = await this.storage.setLeafId(targetId);
    if (moved.kind !== "committed") {
      throw new Error(`ConversationTree.moveTo failed: ${moved.kind}`);
    }
    this.invalidateCache();
    if (!summary) return undefined;
    return this.appendTyped(async () => [{
      kind: "branch_summary",
      id: await this.storage.allocateId(),
      parentId: targetId,
      timestamp: new Date().toISOString(),
      fromId: targetId ?? "root",
      summary: summary.summary,
    } satisfies BranchSummaryEntry]);
  }

  /** Appends a typed entry (compaction, branch_summary) and the entries that
   *  `build` chains after it in the same commit; returns the typed entry's id. */
  private async appendTyped(build: (state: ConversationTreeProjectionState) => Promise<readonly [ConversationEntry, ...ConversationEntry[]]>, signal?: AbortSignal): Promise<string> {
    let entry: ConversationEntry | undefined;
    const outcome = await this.storage.extendBranch(async (state) => {
      const built = await build(state);
      // Typed entries (compaction, branch_summary) pass the same projection
      // gate as message batches; every durable extension of the branch flows
      // through one validity oracle.
      const rejected = await this.rejectInvalidExtension(built[0].parentId, built);
      if (rejected) {
        const cause = rejected.cause instanceof Error ? `: ${rejected.cause.message}` : "";
        throw new Error(`ConversationTree.appendTyped rejected ${built[0].kind} entry${cause}`);
      }
      entry = built[0];
      return built;
    }, undefined, signal);
    if (outcome.kind !== "committed" || !entry) {
      throw new Error(`ConversationTree.appendTyped failed: ${outcome.kind}`);
    }
    this.invalidateCache();
    return entry.id;
  }

  private invalidateCache(): void {
    this.cachedContext = null;
    this.cachedBranchLeaf = undefined;
  }
}

/** Validate only the new result run and the ancestor chain that owns it. This
 * keeps current writes strict without revalidating unrelated historical data. */
function* validateRawToolResultOwnership(
  branch: readonly ConversationEntry[],
  entries: readonly ConversationEntry[],
): Generator<void, void> {
  const byId = new Map<string, ConversationEntry>();
  for (const entry of [...branch, ...entries]) {
    yield;
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    yield;
    if (entry.kind !== "message" || entry.message.kind !== "toolResult") continue;
    const resultIds: string[] = [];
    let cursor: ConversationEntry | undefined = entry;
    while (cursor?.kind === "message" && (cursor.message.kind === "toolResult" || (cursor.message.kind === "system" && cursor.displayOnly === true))) {
      yield;
      if (cursor.message.kind === "toolResult" && (cursor === entry || cursor.displayOnly !== true)) resultIds.push(cursor.message.toolUseId);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    if (cursor?.kind !== "message" || cursor.message.kind !== "assistant" || !Array.isArray(cursor.message.content)) {
      throw new Error(`ConversationTree: tool result ${entry.message.toolUseId} has no preceding assistant tool_use message`);
    }
    const expectedIds = cursor.message.content.filter((block) => block.type === "tool_use").map((block) => block.id);
    const expected = new Set(expectedIds);
    const actual = new Set(resultIds);
    if (
      expected.size !== expectedIds.length
      || actual.size !== resultIds.length
      || resultIds.some((id) => !expected.has(id))
    ) {
      throw new Error(`ConversationTree: tool result ${entry.message.toolUseId} does not belong to the preceding assistant tool_use message`);
    }
  }
}
