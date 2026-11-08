import type { ConversationMessage } from "../agent-runtime/llm/types.js"
import { carriedTurnEndRecord, contextResetRecordId, type TurnInterruption } from "../session/conversation/turn-end-record.js"
import { redactMessage } from "../agent-runtime/agent-loop-history.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import { chatInputContent, normalizeChatInput } from "../../infra/chat-input.js"
import type { MutationEvidence } from "../../infra/mutation-evidence.js"
import { runInTaskSlices } from "../../infra/task-scheduling.js"
import type { RecallPort, RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import { buildSessionContextWork, type SessionContext } from "../session/conversation/conversation-tree-context.js"
import type { CompactionEntry, ConversationEntry } from "../session/conversation/conversation-entry-types.js"
import { createConversationTree, tryOpenConversationTree } from "../session/conversation/conversation-tree-handle.js"
import { dropQueuedUserInput as dropQueuedInput, holdQueuedUserInput as holdQueuedInput, personMessageKey, type QueuedUserInputCell, type QueuedUserInputCommitResult } from "../session/conversation/queued-user-inputs.js"
import { conversationPersonMessage, type PersonMessageRecord } from "../session/conversation/person-message-ledger.js"
import { dropQueuedBackgroundNotification, holdQueuedBackgroundNotification, type HeldBackgroundNotification } from "../session/conversation/queued-background-notifications.js"
import { createConversationTreeWriter, type ConversationTreeWriter } from "../session/conversation/conversation-tree-writer.js"
import { createConversationTreeProjection, type ConversationTreeProjectionState } from "../session/conversation/conversation-projection.js"
import { createConversationMessageEntry, type ContextOpening, type ConversationTree } from "../session/conversation/conversation-tree.js"
import type { FinalizedCheckpointSwap, RecordCompaction } from "../agent-runtime/agent-loop-types.js"
import { recoverFinalizedToolResultCheckpoints } from "../session/finalized-tool-result-checkpoint.js"
import type { HeldRetainedOperation } from "../module-seams.js"
import { noteBackgroundNotificationHeld } from "../session/reply-waits.js"

interface ConversationTreeWriterDeps {
  conversationId: string
  sessionId: string
  /** The workflow whose agent this conversation is: its commits also retire
   *  the cells in which the workflow held their messages. */
  workflowId?: string
  projectRoot: string
  store: AsyncEventStateReadSurface
  projectionReader: AsyncEventStateReadSurface
  writer: AsyncEventWriter
  recall?: RecallPort
  /** A member's input owner commits its cells after seeding the canonical task. */
  ownsQueuedUserInput?: (key: string) => boolean
}

/** Caller-supplied metadata for a compaction recording (`RecordCompaction`).
 *  The supplied measurement counts the exact prepared post-compaction
 *  prompt. */
type CompactionRecordInput = Parameters<RecordCompaction>[0]

interface CompactionRecordResult {
  entryId: string
  messages: ReadonlyArray<ConversationMessage>
  /** Token estimate of the whole next prompt after compaction, prefix
   *  included; also persisted on the compaction entry so the historical
   *  transcript renders the same report the context gauge agrees with. */
  tokensAfter: number
}

/** A transcript-only notice with a bounded evidence root. `displayOnly` excludes
 * the message from rebuilt model context, recall, and FTS. */
interface SystemMessageInput {
  content: string
  mutationEvidence?: MutationEvidence
  displayOnly?: boolean
}

/**
 * Owns the durable conversation-tree writer for one conversation; a chat
 * session's chat, or the conversation of one agent of a workflow. The
 * `chat.tree.created` header is written when the conversation is created
 * (chat at `manager.create`, agent before its first turn), so the writer
 * opens lazily after that; `commitUserTurn`/`buildContext` are the first
 * call sites that observe the header on disk and trigger the open.
 *
 * Callers drive the save-point discipline at four turn boundaries:
 *   - commitUserTurn(text): durable user entry before the provider request
 *   - beginTurn(): subsequent in-turn enqueues buffer
 *   - flushSavePoint(): drain pending writes as a single batch inside the turn
 *   - endTurn(): the last drain, after which commits append directly again
 *
 * Disposal awaits a final flush so output/budget/transcript close on a
 * coherent tree.
 */
export interface ConversationTreeWriterController {
  /** Commit explicit human delivery. System-produced prompts use commitSystemTurn. */
  commitUserTurn(input: ChatInputLike, entryId?: string): Promise<string | null>
  /** Commit original held input under its cell key at an idle boundary. Rejects
   * active turns and storage failures; reports exact-cell contention without delivery. */
  commitQueuedUserInput(cell: QueuedUserInputCell): Promise<QueuedUserInputCommitResult>
  acceptRetainedOperation(operation: HeldRetainedOperation): Promise<void>
  /** Commit a SYSTEM-PRODUCED user-role turn (background/subagent notification,
   *  continuation nudge, assembled brief) outside a running agent loop.
   *  Routes through redactMessage so masking and the origin="system" provenance
   *  stamp stay one invariant at one boundary, mirroring the in-loop
   *  pushMessage path. Human-typed input uses commitUserTurn. */
  commitSystemTurn(text: string, idempotencyKey?: string): Promise<string | null>
  /** Commit one held background notification without changing human-turn
   *  semantics. A keyed notification the conversation already committed
   *  commits nothing again: its entry id answers, and a cell a repeat left
   *  under its key is retired. */
  commitBackgroundNotification(notification: HeldBackgroundNotification): Promise<string | null>
  /** Commit a transcript-only system message. It appends immediately while
   *  idle and queues behind the current turn while foreground work is active.
   *  A structured input additionally persists the review evidence under the
   *  summary; a bare string is the same message with no evidence. */
  commitSystemMessage(message: string | SystemMessageInput): Promise<string | null>
  /** Durably record that the running turn was interrupted by a person or by
   *  the runtime. The record queues behind the turn's last save point, so it
   *  lands after every result the cut turn committed, and it says a tool call
   *  was cut only when one of those results is marked interrupted. It is
   *  model-visible so every later request, live or after a restart, knows
   *  what stopped the turn; the returned message is that record, for a live
   *  loop to hold the same history the tree does. A planned replacement's cut
   *  is saved as the runtime's interrupt, marked planned. Every caller (chat,
   *  agent of a workflow, subagent) records through here, so none
   *  decides the text itself. */
  commitTurnEnd(by: TurnInterruption): Promise<ConversationMessage>
  beginTurn(): void
  /** The turn owner's declaration that the turn is over: the last save-point
   *  drain, releasing every notice held behind the turn, after which idle
   *  commits append directly and may run interruption recovery. */
  endTurn(): Promise<void>
  recordCanonicalMessage(message: ConversationMessage, entryId?: string): Promise<void>
  reserveMessageId(): Promise<string>
  releaseMessageId(id: string): void
  suspendPending(): void
  /** Settle a turn suspended on a person's question at session end.
   *  The results its other calls finished land after the ask, so the
   *  question stays the open exchange the next activation offers, and
   *  nothing records the turn as ended: it waits for the answer. Call after
   *  suspendPending. */
  settleSuspendedTurn(): Promise<void>
  /** Durably hold a mid-turn queued message at dispatch, the person's or
   *  another session's, under the key its entry takes. Returns the dispatch
   *  id the enqueued input must carry so the save-point flush that commits
   *  its message retires the cell, or null when the store cannot hold
   *  in-flight state. */
  holdQueuedUserInput(input: ChatInputLike): Promise<string | null>
  /** Where this conversation already holds the person's message keyed
   *  `key` (`personMessageKey`): an entry, a commit this writer holds behind
   *  the running turn, or a held cell. Undefined when it holds none. */
  recordedPersonMessage(key: string): Promise<PersonMessageRecord | undefined>
  /** Commits one held message between turns under its cell key, retiring
   *  the cell: the input carries that key as its one dispatch id. */
  commitHeldMessage(input: ChatInputLike): Promise<string | null>
  /** Durably hold and canonicalize produced background input before mailbox
   *  admission. Nothing for a keyed notification the conversation already
   *  committed, whose repeat then reaches no turn; a cell a repeat left under
   *  its key is retired. */
  holdBackgroundNotification(text: string, notificationKey?: string): Promise<HeldBackgroundNotification | undefined>
  /** Resolves only after the keyed entry commits. A failed flush or disposal
   * rejects the wait; the durable hold remains the recovery authority. */
  waitForBackgroundNotification(key: string): Promise<void>
  /** Whether this writer held the notification under `key` on its way to
   *  its own live input, which commits it; an adopter of the conversation's
   *  held cells leaves such a cell to that input. */
  holdsBackgroundNotification(key: string): boolean
  /** Retire held queued inputs whose dispatch was taken back (the user
   *  recalled the message into the editor). */
  dropQueuedUserInputs(dispatchIds: readonly string[]): Promise<void>
  /** Names the held queued inputs that a live reader of this conversation
   *  still owns: an input in its queue, or one a recall withdraws. The
   *  recovery that an idle commit runs leaves those cells to that reader,
   *  which commits or retires each one. The reader registers once, before
   *  its first commit. */
  ownQueuedUserInputs(owns: (key: string) => boolean): void
  flushSavePoint(protectedToolUseIds?: ReadonlySet<string>, finalizedCheckpointSwaps?: readonly FinalizedCheckpointSwap[]): Promise<void>
  /** Build the model-visible context from the active branch. Lazily opens
   *  the tree if no turn has run yet so a freshly-resumed chat sees the
   *  prior history before its first provider request. */
  buildContext(options?: { allowAssistantTail?: boolean }): Promise<SessionContext>
  /** Capture one validated committed branch for a child fork. Pending turn
   *  output is excluded; external committed appends are included by refresh. */
  captureCommittedForkMessages(): Promise<ConversationMessage[]>
  /** Detached committed and held context before adjacency repair. Does not
   * flush pending messages or recover unfinished work. */
  captureRawLiveMessages(): Promise<ConversationMessage[]>
  /** Persist a context-reset compaction entry. Flushes pending in-turn writes
   *  FIRST so the source boundary is the post-flush leaf. The caller supplies
   *  `tokensBefore` from its own running token counter. Returns the rebuilt
   *  working history for the loop. */
  recordCompaction(input: CompactionRecordInput): Promise<CompactionRecordResult | null>
  /** Refreshed leaf read for the provider-request audit tree pointer.
   *  Returns null before the tree is opened (no turn has run). */
  getLeafId(): Promise<string | null>
  /** The committed tree as the storage this controller writes holds it,
   *  refreshed once. A reader beside the controller reads it here instead of
   *  folding a second copy of the conversation. */
  getState(): Promise<ConversationTreeProjectionState>

  /** Ranked, scoped retrieval over this conversation's durable history.
   *  Interactive owners inject the executor lane; named offline owners inject
   *  their construction-time local capability. */
  recall(input: RecallInput): Promise<RecallResult>
  dispose(): Promise<void>
}

interface ResolvedWriter {
  writer: ConversationTreeWriter
  tree: ConversationTree
}

export function createConversationTreeWriterController(
  deps: ConversationTreeWriterDeps,
): ConversationTreeWriterController {
  let resolved: ResolvedWriter | null = null
  let disposed = false
  const liveNotificationKeys = new Set<string>()
  const notificationCommits = new Map<string, PromiseWithResolvers<void>>()
  let liveQueuedInputOwner: ((key: string) => boolean) | undefined

  function releaseNotification(key: string): void {
    liveNotificationKeys.delete(key)
    notificationCommits.get(key)?.resolve()
    notificationCommits.delete(key)
  }

  function rejectNotificationCommits(cause: unknown): void {
    for (const pending of notificationCommits.values()) pending.reject(cause)
    notificationCommits.clear()
  }

  async function ensureResolved(): Promise<ResolvedWriter> {
    if (resolved) return resolved
    const handle = { conversationId: deps.conversationId, sessionId: deps.sessionId, ...(deps.workflowId ? { workflowId: deps.workflowId } : {}), projectRoot: deps.projectRoot, store: deps.projectionReader, writer: deps.writer }
    const tree = await tryOpenConversationTree(handle) ?? await createConversationTree(handle)
    const writer = createConversationTreeWriter({
      tree,
      ownsQueuedUserInput: (key) => deps.ownsQueuedUserInput?.(key) === true || liveQueuedInputOwner?.(key) === true,
      ownsBackgroundNotification: (key) => liveNotificationKeys.has(key),
      releaseBackgroundNotification: releaseNotification,
      abandonBackgroundNotification: (key) => {
        liveNotificationKeys.delete(key)
        notificationCommits.get(key)?.reject(new Error("Background notification turn was discarded before commit"))
        notificationCommits.delete(key)
      },
      recoverFinalizedToolResults: () => recoverFinalizedToolResultCheckpoints({
        conversationId: deps.conversationId,
        sessionId: deps.sessionId,
        store: deps.projectionReader,
        writer: deps.writer,
        tree,
        projectRoot: deps.projectRoot,
      }),
    })
    resolved = { writer, tree }
    return resolved
  }

  /** Durable delivery of an accepted message: model-visible content plus the
   *  invocation display metadata the transcript projector renders from. A
   *  message from another session keeps its producer and claims no human
   *  origin. The dispatch ids ride along so the committing append retires
   *  their cells. */
  function toUserMessage(input: ChatInputLike): Extract<ConversationMessage, { kind: "user" }> {
    const normalized = normalizeChatInput(input)
    return {
      kind: "user",
      content: chatInputContent(input),
      ...(normalized.producer?.kind === "session" ? { producer: normalized.producer } : { origin: "human" as const }),
      ...(normalized.invocation ? { invocation: normalized.invocation } : {}),
      ...(normalized.submissionIds?.length ? { submissionIds: normalized.submissionIds } : {}),
      ...(normalized.dispatchIds && normalized.dispatchIds.length > 0 ? { dispatchIds: normalized.dispatchIds } : {}),
    }
  }

  async function commitUserTurn(input: ChatInputLike, entryId?: string): Promise<string | null> {
    const { writer } = await ensureResolved()
    return writer.commitUserTurn(toUserMessage(input), entryId)
  }

  async function commitQueuedUserInput(cell: QueuedUserInputCell): Promise<QueuedUserInputCommitResult> {
    const { writer } = await ensureResolved()
    return writer.commitQueuedUserInput(cell)
  }

  async function acceptRetainedOperation(operation: HeldRetainedOperation): Promise<void> {
    const { writer } = await ensureResolved()
    await writer.acceptRetainedOperation(operation)
  }

  async function commitSystemTurn(text: string, idempotencyKey?: string): Promise<string | null> {
    const { writer } = await ensureResolved()
    return writer.commitUserTurn(redactMessage({ kind: "user", content: text }, false), idempotencyKey)
  }

  /** Whether the notification held under `key` is committed already. A cell
   *  a repeat left under that key is retired, so it never reaches a turn. */
  async function committedNotification(key: string): Promise<boolean> {
    const entry = disposed
      ? (await createConversationTreeProjection(deps.projectionReader, deps.conversationId).replay()).entriesById[key]
      : await (await ensureResolved()).tree.getEntry(key)
    if (entry === undefined) return false
    await dropQueuedBackgroundNotification(deps.writer, deps.sessionId, key)
    releaseNotification(key)
    return true
  }

  async function commitBackgroundNotification(notification: HeldBackgroundNotification): Promise<string | null> {
    if (notification.key !== undefined && await committedNotification(notification.key)) return notification.key
    const { writer } = await ensureResolved()
    return writer.commitUserTurn({
      kind: "user",
      content: notification.text,
      origin: "system",
      ...(notification.key ? { backgroundNotificationIds: [notification.key] } : {}),
      replyRequired: true,
    }, notification.key)
  }

  async function commitSystemMessage(message: string | SystemMessageInput): Promise<string | null> {
    const { writer } = await ensureResolved()
    const input = typeof message === "string" ? { content: message } : message
    return writer.commitUserTurn({ kind: "system", ...input })
  }

  async function commitTurnEnd(by: TurnInterruption): Promise<ConversationMessage> {
    // An attached writer takes the record in the caller's tick, so a record
    // asked for while the turn runs is queued when this call returns.
    const { writer } = resolved ?? await ensureResolved()
    return writer.commitTurnEnd(by)
  }

  function beginTurn(): void {
    resolved?.writer.beginTurn()
  }

  async function endTurn(): Promise<void> {
    if (!resolved) return
    try { await resolved.writer.endTurn() }
    catch (error) { rejectNotificationCommits(error); throw error }
  }

  async function reserveMessageId(): Promise<string> {
    return (await ensureResolved()).tree.getStorage().allocateId()
  }

  function releaseMessageId(id: string): void {
    if (!resolved) throw new Error("Tree writer is not attached before releasing a message identity")
    resolved.tree.getStorage().releaseId(id)
  }

  async function recordCanonicalMessage(message: ConversationMessage, entryId?: string): Promise<void> {
    if (!resolved) {
      throw new Error("ConversationTreeWriterController.recordCanonicalMessage called before the session tree was opened")
    }
    await resolved.writer.enqueueMessage(message, entryId)
  }

  async function flushSavePoint(protectedToolUseIds?: ReadonlySet<string>, finalizedCheckpointSwaps?: readonly FinalizedCheckpointSwap[]): Promise<void> {
    if (!resolved) return
    try { await resolved.writer.flushSavePoint(protectedToolUseIds, finalizedCheckpointSwaps) }
    catch (error) { rejectNotificationCommits(error); throw error }
  }

  function suspendPending(): void {
    resolved?.writer.suspendPending()
  }

  async function settleSuspendedTurn(): Promise<void> {
    // No turn ever ran through this controller when the writer is unresolved,
    // so there is nothing to record.
    if (!resolved) return
    await resolved.writer.settleSuspendedTurn()
  }

  async function holdQueuedUserInput(input: ChatInputLike): Promise<string | null> {
    // A message from another session and a person's message with one
    // submission take their own key; only another person's message
    // reserves a fresh one, which it gives back when nothing is held.
    const keyed = normalizeChatInput(input).producer?.kind === "session" || personMessageKey(input) !== undefined
    const reserved = keyed ? undefined : await reserveMessageId()
    try {
      const held = await holdQueuedInput(deps.writer, deps.sessionId, { target: "conversation", conversationId: deps.conversationId }, input, reserved)
      if (held === null && reserved !== undefined) releaseMessageId(reserved)
      return held
    } catch (error) {
      if (reserved !== undefined) releaseMessageId(reserved)
      throw error
    }
  }

  async function recordedPersonMessage(key: string): Promise<PersonMessageRecord | undefined> {
    if (resolved?.writer.holdsCommit(key)) return "entry"
    return conversationPersonMessage(deps.projectionReader, { sessionId: deps.sessionId, conversationId: deps.conversationId, kind: "chat" }, key)
  }

  async function commitHeldMessage(input: ChatInputLike): Promise<string | null> {
    const { writer } = await ensureResolved()
    const message = toUserMessage(input)
    return writer.commitUserTurn(message, message.dispatchIds?.length === 1 ? message.dispatchIds[0] : undefined)
  }

  async function holdBackgroundNotification(text: string, notificationKey?: string): Promise<HeldBackgroundNotification | undefined> {
    if (notificationKey !== undefined && await committedNotification(notificationKey)) return undefined
    const held = await holdQueuedBackgroundNotification(deps.writer, deps.sessionId, deps.conversationId, text, notificationKey)
    if (held.key !== undefined) {
      liveNotificationKeys.add(held.key)
      noteBackgroundNotificationHeld(deps.projectionReader, deps.sessionId, held.key)
    }
    return held
  }

  function waitForBackgroundNotification(key: string): Promise<void> {
    const existing = notificationCommits.get(key)
    if (existing) return existing.promise
    const pending = Promise.withResolvers<void>()
    notificationCommits.set(key, pending)
    // Install before reading: a concurrent save point can commit during the read.
    void committedNotification(key).then((committed) => {
      if (!committed && disposed) throw new Error("Conversation writer disposed before background notification commit")
    }).catch((cause: unknown) => {
      if (notificationCommits.get(key) !== pending) return
      notificationCommits.delete(key)
      pending.reject(cause)
    })
    return pending.promise
  }

  async function dropQueuedUserInputs(dispatchIds: readonly string[]): Promise<void> {
    for (const dispatchId of dispatchIds) {
      await dropQueuedInput(deps.writer, deps.sessionId, dispatchId)
      resolved?.tree.getStorage().releaseId(dispatchId)
    }
  }

  async function buildContext(options?: { allowAssistantTail?: boolean }): Promise<SessionContext> {
    const { tree } = await ensureResolved()
    return tree.buildContext(options)
  }

  async function captureCommittedForkMessages(): Promise<ConversationMessage[]> {
    const { tree } = await ensureResolved()
    return tree.captureCommittedForkMessages()
  }

  async function captureRawLiveMessages(): Promise<ConversationMessage[]> {
    const { writer } = await ensureResolved()
    return writer.captureRawLiveMessages()
  }

  async function recordCompaction(input: CompactionRecordInput): Promise<CompactionRecordResult | null> {
    const { writer, tree } = await ensureResolved()
    // Flush pending in-turn writes BEFORE observing the leaf. Without this,
    // the source boundary and compaction parent could be selected from a stale
    // branch, letting in-between writes re-enter context after the reset.
    await writer.flushSavePoint()
    const branch = await tree.getBranch()
    const leaf = branch.at(-1)
    if (!leaf) return null
    const carriedTurnEnd = input.carryTurnEnd === true ? carriedTurnEndRecord(branch) : undefined
    // A reset that no request follows answers its own exchange: its opening
    // messages are settled records, so the chat reads as it did before it.
    const opening: ContextOpening[] = [
      ...(carriedTurnEnd ? [carriedTurnEnd] : []),
      ...input.additions.map((message) => input.after === "park" ? { message, id: contextResetRecordId() } : { message }),
    ]
    const rebuilt = await rebuildCompacted(branch, {
      parentId: leaf.id,
      mode: "reset",
      sourceLeafId: leaf.id,
      tokensBefore: input.tokensBefore,
    }, opening)
    const tokensAfter = input.measureTokensAfter(rebuilt.messages)
    const entryId = await tree.appendCompaction({
      sourceLeafId: leaf.id,
      tokensBefore: input.tokensBefore,
      tokensAfter,
      opening,
    }, input.signal)
    return { entryId, messages: rebuilt.messages, tokensAfter }
  }

  async function getLeafId(): Promise<string | null> {
    return resolved?.tree.getLeafId() ?? null
  }

  async function getState(): Promise<ConversationTreeProjectionState> {
    return (await ensureResolved()).tree.getState()
  }



  function recall(input: RecallInput): Promise<RecallResult> {
    if (!deps.recall) throw new Error("Conversation recall is unavailable for this controller")
    return deps.recall(input)
  }

  async function dispose(): Promise<void> {
    disposed = true
    rejectNotificationCommits(new Error("Conversation writer disposed before background notification commit"))
    if (!resolved) {
      liveNotificationKeys.clear()
      return
    }
    const { writer, tree } = resolved
    resolved = null
    try {
      await writer.endTurn()
    } finally {
      liveNotificationKeys.clear()
      tree.getStorage().dispose()
    }
  }

  return { commitUserTurn, commitQueuedUserInput, acceptRetainedOperation, commitSystemTurn, commitBackgroundNotification, commitSystemMessage, commitTurnEnd, beginTurn, endTurn, recordCanonicalMessage, reserveMessageId, releaseMessageId, suspendPending, settleSuspendedTurn, holdQueuedUserInput, recordedPersonMessage, commitHeldMessage, holdBackgroundNotification, waitForBackgroundNotification, holdsBackgroundNotification: (key) => liveNotificationKeys.has(key), dropQueuedUserInputs, ownQueuedUserInputs: (owns) => { liveQueuedInputOwner = owns }, flushSavePoint, buildContext, captureCommittedForkMessages, captureRawLiveMessages, recordCompaction, getLeafId, getState, recall, dispose }
}

/** Post-compaction working history, computed from a hypothetical rebuild BEFORE
 *  the entry and its opening messages are appended. buildSessionContext reads none of
 *  id/timestamp/tokensAfter, so the pre-append rebuild is the post-append
 *  context; `tokensAfter: 0` in the hypothetical exists only to satisfy the
 *  entry type and is replaced by the measured value on append. */
async function rebuildCompacted(
  branch: ReadonlyArray<ConversationEntry>,
  entry: Omit<Extract<CompactionEntry, { mode: "reset" }>, "kind" | "id" | "timestamp" | "tokensAfter">,
  opening: readonly ContextOpening[],
) {
  const hypothetical: CompactionEntry = {
    kind: "compaction",
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
    tokensAfter: 0,
  }
  const opened = opening.map(({ message }, index) =>
    createConversationMessageEntry(message, `${hypothetical.id}-opening-${index}`, index === 0 ? hypothetical.id : `${hypothetical.id}-opening-${index - 1}`, hypothetical.timestamp))
  const rebuilt = await runInTaskSlices("conversation:compaction-context", buildSessionContextWork([...branch, hypothetical, ...opened], { allowAssistantTail: true }))
  return { messages: [...rebuilt.messages] }
}

