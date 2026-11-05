import { producerOrigin } from "../../infra/agent-loop-events.js"
import { normalizeChatInput, type ChatInputLike } from "../../infra/chat-input.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter, InFlightWrite } from "../../infra/event-store-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { readWorkflowControlStatuses } from "../../workflows/vm/control-status.js"
import type { WorkflowRunRecord } from "../workflow-host/run-record.js"
import { readPendingTurnEnd, workflowInteractionRefusal, workflowStopRefusal } from "./chat-session-run-evidence.js"
import { workflowRunReader, workflowRunOwner } from "../module-catalog.js"
import { readChildSessionRunEvidence, type ChildSessionRunEvidence } from "./child-session-run-evidence.js"
import { tryOpenConversationTree } from "./conversation/conversation-tree-handle.js"
import { heldBackgroundNotification, heldBackgroundNotificationPut, type HeldNotificationDestination } from "./conversation/queued-background-notifications.js"
import { ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, addressedWorkflowMessagePayload, holdAddressedWorkflowMessage, readUnreadSessionMessages, retireAddressedWorkflowMessages, WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "./conversation/addressed-workflow-messages.js"
import {
  dropQueuedUserInput,
  holdQueuedUserInput,
  personMessageKey,
  QUEUED_USER_INPUT_IN_FLIGHT_KIND,
  queuedUserInputKey,
  queuedUserInputPut,
  type QueuedUserInputCell,
  type QueuedUserInputDestination,
} from "./conversation/queued-user-inputs.js"
import { conversationPersonMessage, holdPersonMessageOnce, recordPersonMessageReceipt, workflowPersonMessage, type PersonMessageRecord } from "./conversation/person-message-ledger.js"
import { liveSessionControl, liveWorkflowControl, messageDisposition, type DeliveryOutcome, type RecipientState, type LiveSessionControl } from "./live-session-control.js"
import { endReplyWaitsByMessage, observeSessionChanged } from "./reply-waits.js"
import type { ReplayedSession } from "./schemas.js"
import { readToolExecutions } from "./tool-execution-projection.js"
import { returnUnreadHumanInput } from "./composer-returns.js"

const log = Log.create({ service: "session-input-delivery" })

export interface SessionInputDeliveryDeps {
  readonly manager: { read(sessionId: string): Promise<ReplayedSession | null> }
  /** The project's event reader, which also keys the live-session registry. */
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
}

/** Delivers one accepted message into a session: from a person, or from
 *  another session when the input names a session producer. The message is
 *  durable in its cell before any loop reads it, and a live session
 *  takes it through its control. A message the recipient cannot read now
 *  stays held; a refused one leaves nothing behind.
 *
 *  Workflow direction enters through deliverWorkflowInput, never this path. */
export async function deliverSessionInput(
  deps: SessionInputDeliveryDeps,
  recipientSessionId: string,
  message: ChatInputLike,
): Promise<DeliveryOutcome> {
  const input = normalizeChatInput(message)
  const producer = input.producer?.kind === "session" ? input.producer : undefined
  const decide = (state: RecipientState): DeliveryOutcome => messageDisposition({
    state,
    origin: producerOrigin(input.producer),
    hop: producer?.hop ?? 0,
    self: producer?.sessionId === recipientSessionId,
    ...(producer?.envelope ? { relation: producer.envelope.relation } : {}),
  })
  const record = (outcome: DeliveryOutcome): DeliveryOutcome => {
    log.debug("session input delivery decided", {
      senderSessionId: producer?.sessionId ?? "person",
      recipientSessionId,
      status: outcome.status,
      ...(outcome.status === "delivered" ? { startsTurn: outcome.startsTurn } : { reason: outcome.reason }),
      bytes: Buffer.byteLength(input.text),
      hop: producer?.hop ?? 0,
      waits: producer?.envelope?.waits ?? false,
    })
    return outcome
  }

  const recipient = await deps.manager.read(recipientSessionId)
  // A person's message that the recipient already holds under its
  // submission is a copy a client sent again after its connection lost the
  // answer. It is answered before any refusal, so a child that settled
  // since never refuses what it took, and it records nothing (ARCH-SESSIONS-030).
  const personKey = personMessageKey(input)
  const place = recipient && recipient.kind !== "workflow" ? { sessionId: recipientSessionId, conversationId: recipient.conversationId, kind: recipient.kind } : undefined
  const recorded = personKey === undefined || place === undefined ? undefined : await conversationPersonMessage(deps.projectionReader, place, personKey)
  const before = await recipientState(deps, recipientSessionId, recipient)
  if (recorded !== undefined) {
    // A held cell in an interrupted recipient still waits for its reader,
    // so the receipt says so, and the owner starts the recipient again as
    // it does for the first copy.
    const confirmedSubmissionIds = recordPersonMessageReceipt(recipientSessionId, input, recorded)
    // Returned input is confirmed by its parent transcript notice, not this
    // receipt: early retirement would erase the sender's claim identity.
    return record(recorded === "cell" && before === "interrupted" ? { status: "held", reason: "interrupted", confirmedSubmissionIds } : { status: "delivered", startsTurn: false, confirmedSubmissionIds })
  }
  // A live recipient decides from its own state, but no state of it admits
  // a sender that a running one refuses, such as the recipient itself. So
  // that refusal comes here, before anything is held.
  const admitted = decide(before === "live" ? "running" : before)
  if (admitted.status === "refused" || !recipient) return record(admitted)

  const holdAndDeliver = async (): Promise<DeliveryOutcome> => {
    const destination = destinationOf(recipient)
    let key: string | null
    if (personKey !== undefined && place !== undefined) {
      // Two copies that arrive together hold one cell, and a copy whose
      // earlier copy a reader committed meanwhile finds that entry.
      const put = queuedUserInputPut(personKey, destination, input)
      const held = await holdPersonMessageOnce(deps.eventWriter, { sessionId: recipientSessionId, kind: put.kind, key: personKey, payload: put.payload }, () => conversationPersonMessage(deps.projectionReader, place, personKey).then((found) => found === "cell" ? undefined : found))
      if (held !== null && held !== "held") return receipt(recipientSessionId, input, held)
      key = held === null ? null : personKey
    } else {
      key = await holdQueuedUserInput(deps.eventWriter, recipientSessionId, destination, input)
    }
    if (!key) throw new Error(`Session ${recipientSessionId} cannot hold an accepted message durably`)
    const drop = () => dropQueuedUserInput(deps.eventWriter, recipientSessionId, key)
    // The recipient can settle while the hold commits; a refusal then takes
    // the hold back, so no settled run keeps a message it will never read.
    const after = await recipientState(deps, recipientSessionId, await deps.manager.read(recipientSessionId))
    if (after !== "live" && decide(after).status === "refused") {
      await drop()
      return decide(after)
    }
    // The message is durable in the recipient now, so each wait of the
    // recipient on its sender ends (PI-INTERACTION-136). Its cell goes
    // before the recipient can read the message.
    if (producer) await endReplyWaitsByMessage({ reader: deps.projectionReader, writer: deps.eventWriter }, producer.sessionId, recipientSessionId)
    const control = after === "live" ? liveSessionControl(deps.projectionReader, recipientSessionId) : undefined
    const outcome = control
      ? await control.deliver({ ...input, dispatchIds: [...(input.dispatchIds ?? []), key] }, decide)
      : decide(after === "live" ? "at_rest" : after)
    if (outcome.status === "refused") await drop()
    return outcome
  }
  const control = liveSessionControl(deps.projectionReader, recipientSessionId)
  return record(await (control?.withInputAdmission ? control.withInputAdmission(holdAndDeliver) : holdAndDeliver()))
}

/** Reads aggregate admission without manufacturing a session row. */
export async function readWorkflowRecipientState(deps: Pick<SessionInputDeliveryDeps, "projectionReader">, workflowId: string): Promise<RecipientState> {
  const run = await workflowRunReader(deps.projectionReader).read(workflowId)
  if (!run) return await workflowRunOwner().deleted(deps.projectionReader, workflowId) ? "deleted" : "not_found"
  if (await workflowStopRefusal(deps.projectionReader, run.launchedFrom) || workflowInteractionRefusal((await readWorkflowControlStatuses(deps.projectionReader, [workflowId])).get(workflowId))) return "settled"
  return await liveWorkflowControl(deps.projectionReader, workflowId)?.state() ?? "interrupted"
}

/** Admission for listed runs. Their registrations are already current; control
 *  advances once, and launching-call evidence is batched per owning chat. */
export async function readWorkflowRecipientStates(deps: Pick<SessionInputDeliveryDeps, "projectionReader">, runs: readonly { readonly workflowId: string; readonly run: WorkflowRunRecord }[]): Promise<readonly { readonly workflowId: string; readonly run: WorkflowRunRecord; readonly state: RecipientState }[]> {
  const reader = deps.projectionReader
  const statuses = await readWorkflowControlStatuses(reader, runs.map(({ workflowId }) => workflowId))
  const callsByParent = Map.groupBy(runs, ({ run }) => run.launchedFrom.parentSessionId)
  const stopped = new Set<string>()
  await Promise.all([...callsByParent].map(async ([parentId, children]) => {
    const calls = await readToolExecutions(reader, parentId, children.map(({ run }) => run.launchedFrom.toolUseId))
    for (const { workflowId, run } of children) {
      const outcome = calls.get(run.launchedFrom.toolUseId)?.resultOutcome
      if (outcome === "stopped" || outcome === "cancelled") stopped.add(workflowId)
    }
  }))
  return Promise.all(runs.map(async ({ workflowId, run }) => ({
    workflowId,
    run,
    state: stopped.has(workflowId) || workflowInteractionRefusal(statuses.get(workflowId))
      ? "settled" as const : await liveWorkflowControl(reader, workflowId)?.state() ?? "interrupted" as const,
  })))
}

/** Parent/person input is addressed direction. Peer input has exactly one reader.
 *  Accepted cells remain workflow-owned until read or returned at settlement. */
export async function deliverWorkflowInput(deps: SessionInputDeliveryDeps, workflowId: string, message: ChatInputLike, targets?: WorkflowDeliveryAddress): Promise<DeliveryOutcome> {
  const input = normalizeChatInput(message)
  const run = await workflowRunReader(deps.projectionReader).read(workflowId)
  const producer = input.producer?.kind === "session" ? input.producer : undefined
  const parent = producer?.sessionId === run?.launchedFrom.parentSessionId
  const direction = !producer || parent
  if (targets && !direction) throw new Error("Only the launching parent can address workflow direction")
  const decide = (state: RecipientState): DeliveryOutcome => messageDisposition({
    state, origin: producerOrigin(input.producer), hop: producer?.hop ?? 0, self: false,
    ...(parent ? { relation: "parent" } : producer?.envelope ? { relation: producer.envelope.relation } : {}),
  })
  const before = decide(await readWorkflowRecipientState(deps, workflowId))
  if (before.status === "refused") return before
  const held = direction
    ? await holdAddressed(deps, workflowId, input, targets ?? WHOLE_WORKFLOW)
    : { key: await holdQueuedUserInput(deps.eventWriter, workflowId, { target: "workflow" }, input), address: undefined }
  if ("recorded" in held) return receipt(workflowId, input, held.recorded)
  const { key, address } = held
  if (!key) throw new Error(`Workflow ${workflowId} cannot hold an accepted message durably`)
  const drop = () => address ? retireAddressedWorkflowMessages(deps.eventWriter, workflowId, [key]) : dropQueuedUserInput(deps.eventWriter, workflowId, key)
  const state = await readWorkflowRecipientState(deps, workflowId)
  const admitted = decide(state)
  if (admitted.status === "refused") { await drop(); return admitted }
  const outcome = await liveWorkflowControl(deps.projectionReader, workflowId)?.deliver({ ...input, dispatchIds: [...(input.dispatchIds ?? []), key] }, decide, address) ?? admitted
  if (outcome.status === "refused") await drop()
  log.debug("workflow input delivery decided", { workflowId, senderSessionId: producer?.sessionId ?? "person", status: outcome.status, direction, bytes: Buffer.byteLength(input.text) })
  return outcome
}

/** Holds a message to a workflow under the key that a queued input of the
 *  same producer would take, so the agent that reads it live writes its entry
 *  under the same key and the workflow records it once. A person's message
 *  that the workflow holds or recorded already answers that record. */
async function holdAddressed(deps: SessionInputDeliveryDeps, recipientSessionId: string, input: ReturnType<typeof normalizeChatInput>, address: WorkflowDeliveryAddress): Promise<{ readonly key: string | null; readonly address: WorkflowDeliveryAddress } | { readonly recorded: PersonMessageRecord }> {
  const key = queuedUserInputKey(input.producer, input.submissionIds)
  if (personMessageKey(input) === undefined) return { key: await holdAddressedWorkflowMessage(deps.eventWriter, recipientSessionId, key, input, address) ? key : null, address }
  const held = await holdPersonMessageOnce(deps.eventWriter, { sessionId: recipientSessionId, kind: ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, key, payload: addressedWorkflowMessagePayload(input, address) },
    () => workflowPersonMessage(deps.projectionReader, recipientSessionId, key).then((found) => found === "cell" ? undefined : found))
  if (held === null) return { key: null, address }
  return held === "held" ? { key, address } : { recorded: held }
}

/** The answer to a person's message that the ledger already holds: its
 *  receipt, which records nothing and starts no turn. */
function receipt(sessionId: string, input: ChatInputLike, where: PersonMessageRecord): DeliveryOutcome {
  return { status: "delivered", startsTurn: false, confirmedSubmissionIds: recordPersonMessageReceipt(sessionId, input, where) }
}

/** The state a message to `sessionId` would meet now, read without
 *  delivering anything. A live session reports its own state. */
export async function readRecipientState(deps: Pick<SessionInputDeliveryDeps, "projectionReader">, sessionId: string, session: ReplayedSession | null): Promise<RecipientState> {
  const state = await recipientState(deps, sessionId, session)
  if (state !== "live") return state
  const control = liveSessionControl(deps.projectionReader, sessionId)
  if (!control) return "at_rest"
  return await control.state()
}

function destinationOf(recipient: ReplayedSession): QueuedUserInputDestination {
  if (recipient.kind === "workflow") throw new Error("Historical workflow metadata is not a session input target")
  return { target: "conversation", conversationId: recipient.conversationId }
}

/** The durable state of a recipient, or `live` when a control of it runs in
 *  this process and so decides from its own live state. */
async function recipientState(
  deps: Pick<SessionInputDeliveryDeps, "projectionReader">,
  sessionId: string,
  recipient: ReplayedSession | null,
): Promise<RecipientState | "live"> {
  if (!recipient) return await deps.projectionReader.aggregateSeq(`session:${sessionId}`) > 0 ? "deleted" : "not_found"
  const control: LiveSessionControl | undefined = liveSessionControl(deps.projectionReader, sessionId)
  switch (recipient.kind) {
    case "chat": return control ? "live" : "at_rest"
    case "subagent": {
      const evidence = await readChildSessionRunEvidence(deps.projectionReader, sessionId)
      const { run } = evidence
      if (!run || childRunEnded(run)) return "settled"
      if (run.status !== "created") return "interrupted"
      if (control?.child) return "live"
      return evidence.continuationAuthorized ? "planned_cut" : "at_rest"
    }
    case "workflow-agent": {
      const membership = recipient.workflowMembership
      if (membership.kind !== "attempt") return "settled"
      const attempt = await workflowRunReader(deps.projectionReader).readAttempt(membership.workflowId, membership.attemptId)
      if (!attempt || attempt.conversationId !== recipient.conversationId || attempt.state._tag !== "running") return "settled"
      if (control) return "live"
      const cut = await readPendingTurnEnd(deps.projectionReader, recipient.conversationId)
      return cut?.reason === "paused" ? "interrupted" : recipient.lifecycleState === "inactive" ? "settled" : "at_rest"
    }
    case "workflow": return "not_found"
  }
}

/** Whether a child's run reads no more input: it ended, and no Resume
 *  continues it. A paused or interrupted run reads its held input when it
 *  resumes. */
function childRunEnded(run: NonNullable<ChildSessionRunEvidence["run"]>): boolean {
  return run.status !== "created" && run.status !== "paused" && run.status !== "interrupted"
}

/** Why a sender gets its unread messages back. */
type UnreadReturnReason = "settled" | "deleted"

/** The recipient whose unread messages return, and why. */
interface UnreadReturn {
  readonly recipientSessionId: string
  readonly reason: UnreadReturnReason
}

/** The notice that gives a sender back the messages its recipient never
 *  read. The completion notice of a child carries the same section for its
 *  parent. */
function returnedMessagesNotice(recipientSessionId: string, reason: UnreadReturnReason, cells: readonly Pick<QueuedUserInputCell, "text">[]): string {
  const because = reason === "deleted" ? "was deleted" : "ended"
  return [
    `<returned_messages session_id="${recipientSessionId}" reason="${reason}">`,
    `Session ${recipientSessionId} ${because} before it read ${cells.length === 1 ? "this message" : "these messages"} from you:`,
    ...cells.map((cell) => `<message>\n${cell.text}\n</message>`),
    "</returned_messages>",
  ].join("\n")
}

/** The unread messages of one sender, in send order. */
interface UnreadMessagesOfSender {
  readonly senderSessionId: string
  readonly senderConversationId: string
  readonly cells: readonly QueuedUserInputCell[]
}

/** Splits the held cells of a recipient into the person's messages and the
 *  messages of each sending session. */
function splitUnreadMessages(cells: readonly QueuedUserInputCell[]) {
  const person: QueuedUserInputCell[] = []
  const senders = new Map<string, { senderSessionId: string; senderConversationId: string; cells: QueuedUserInputCell[] }>()
  for (const cell of cells) {
    if (cell.producer?.kind !== "session") {
      person.push(cell)
      continue
    }
    const key = `${cell.producer.sessionId}\n${cell.producer.conversationId}`
    const group = senders.get(key) ?? { senderSessionId: cell.producer.sessionId, senderConversationId: cell.producer.conversationId, cells: [] }
    group.cells.push(cell)
    senders.set(key, group)
  }
  return { person, senders: [...senders.values()] }
}

/** What a parent gets back with the end of its child. The end commit
 *  carries it, so the return and the end land together. */
interface ParentReturn {
  /** The completion content with the returned section after it. */
  completion(content: string): string
  /** Retires the returned cells, for an end that carries the completion. */
  readonly retirements: readonly InFlightWrite[]
  /** Holds the notice in the parent's conversation, for an end that carries
   *  no completion, such as a delete. A return that a crash cut can leave the
   *  same notice held, so the write overwrites it and never conflicts. */
  readonly notice: InFlightWrite
}

/** One returned-messages notice that a sender holds. The settlement only
 *  holds it; the process that runs the sender hands it to the live run
 *  (`wakeAfterSettlement`), and a sender with no live run reads it at its
 *  next run. */
export interface ReturnedNotice {
  readonly senderSessionId: string
  readonly notification: { readonly key: string; readonly text: string }
}

/** A returned notice as the settlement holds it, with where its sender reads it. */
interface HeldReturn extends ReturnedNotice {
  readonly destination: HeldNotificationDestination
}

function parentReturn(recipientSessionId: string, reason: UnreadReturnReason, group: UnreadMessagesOfSender, destination: HeldNotificationDestination): ParentReturn & { readonly held: HeldReturn } {
  const notice = returnedMessagesNotice(recipientSessionId, reason, group.cells)
  const key = returnedNoticeKey(recipientSessionId, group)
  return {
    completion: (content) => `${content}\n\n${notice}`,
    retirements: group.cells.map((cell) => ({ op: "drop", kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: cell.key })),
    notice: heldBackgroundNotificationPut(destination, notice, key),
    held: { senderSessionId: group.senderSessionId, notification: heldBackgroundNotification(destination, notice, key), destination },
  }
}

/** Returns private input to its original sending conversation, never a sibling. */
function returnDestination(group: UnreadMessagesOfSender): HeldNotificationDestination {
  return { target: "conversation", conversationId: group.senderConversationId }
}

/** The end of one recipient and the unread messages it settles (ARCH-SESSIONS-031). */
export type UnreadSettlement = {
  readonly recipientSessionId: string
  /** The parent of the recipient. Its unread messages ride the end commit. */
  readonly parent?: { readonly sessionId: string; readonly conversationId?: string }
  /** Commits the event that ends the recipient, with the parent's return
   *  when it has one. Resolves false when nothing was stored, such as a
   *  guarded append that a concurrent writer won; nothing then returns. */
  readonly end: (parentReturn: ParentReturn | undefined) => Promise<boolean>
} & (
  /** A run that settled: what it leaves held commits into its conversation
   *  (`commitHeld`). */
  | { readonly reason: "settled"; readonly commitHeld: CommitHeld; readonly humanReturn?: { readonly name: string } }
  /** The run of a recipient that a delete removes. Its end returns the
   *  parent's messages and commits what it leaves held, as a settle does.
   *  The delete's own settlement returns every other sender's messages with
   *  its tombstone, so each of those notices names the deletion. */
  | { readonly reason: "deleting"; readonly commitHeld: CommitHeld }
  /** A delete, whose end retires every cell of the recipient. */
  | { readonly reason: "deleted" }
)

/** Commits into the conversation of an ended run what the run leaves held
 *  for itself: the person's unread messages, which a later run or the
 *  deleted history keeps, then each notice that the run never read. A
 *  notice can come after the run stopped reading, and no later run of a
 *  settled recipient reads it, so a cell left held would wait for ever. */
type CommitHeld = (person: readonly QueuedUserInputCell[]) => Promise<void>

/** What a settlement did. `returned` lists the notices it held for senders
 *  that still read, which `wakeAfterSettlement` hands over where the
 *  sessions run. */
export type UnreadSettlementOutcome =
  | { readonly stored: false }
  | { readonly stored: true; readonly returned: readonly ReturnedNotice[] }

/** Why the notices of a settlement say that the recipient never read the messages. */
function returnReason(reason: UnreadSettlement["reason"]): UnreadReturnReason {
  return reason === "settled" ? "settled" : "deleted"
}

/** Ends a recipient and gives back every message it never read: the
 *  parent's with the end commit, and each other sender's in one notice,
 *  which the delete's own settlement gives when a delete ends the run. At
 *  the end of a run, what the run leaves held commits into the recipient's
 *  conversation last. The order is load-bearing: an idle commit in that conversation
 *  recovers every held message, so the returns go before it.
 *
 *  The settlement is durable work only. A delete runs it in the process that
 *  owns the project state, which runs no session, so it touches no live run:
 *  the caller passes the outcome to `wakeAfterSettlement` in the process
 *  where the sessions run. */
export async function settleUnreadMessages(
  store: { readonly reader: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter },
  input: UnreadSettlement,
): Promise<UnreadSettlementOutcome> {
  const { senders } = splitUnreadMessages(await readUnreadSessionMessages(store.reader, input.recipientSessionId))
  const { parent } = input
  const parentGroup = parent && senders.find((group) => group.senderSessionId === parent.sessionId
    && (parent.conversationId === undefined || group.senderConversationId === parent.conversationId))
  const others = senders.filter((group) => group !== parentGroup)
  // A delete's tombstone retires every cell, so each notice is held before
  // it: a delete that fails keeps the messages, and a retry converges on the
  // same notice keys.
  const returned = { recipientSessionId: input.recipientSessionId, reason: returnReason(input.reason) }
  const heldBeforeEnd = input.reason === "deleted" ? await returnUnreadMessages(store, returned, others, { retire: false }) : []
  const toParent = parentGroup && parentReturn(input.recipientSessionId, returned.reason, parentGroup, returnDestination(parentGroup))
  if (input.reason === "settled" && input.humanReturn) {
    const human = (await readUnreadSessionMessages(store.reader, input.recipientSessionId)).filter((cell) => cell.origin === "human" || cell.producer?.kind === "human")
    await returnUnreadHumanInput(store, { sessionId: input.recipientSessionId, name: input.humanReturn.name }, human)
  }
  if (!await input.end(toParent)) return { stored: false }
  if (parentGroup) logReturned(returned, parentGroup)
  // A settled parent reads its return with the completion; a delete
  // carries no completion, so the parent's notice reaches it like the others.
  if (input.reason === "deleted") return { stored: true, returned: await commitAtEndedSenders(store, [...heldBeforeEnd, ...toParent ? [toParent.held] : []]) }
  // Read again: a message accepted while the run ended holds its cell after
  // the first read, and it returns like the others. The cells of a run that
  // a delete ends stay for the delete's own settlement.
  const remaining = splitUnreadMessages(await readUnreadSessionMessages(store.reader, input.recipientSessionId))
  const returnedAtEnd = input.reason === "settled" ? await returnUnreadMessages(store, returned, remaining.senders, { retire: true }) : []
  await input.commitHeld(remaining.person)
  return { stored: true, returned: await commitAtEndedSenders(store, returnedAtEnd) }
}

/** Settles each held notice at a sender whose run ended: no later run of a
 *  settled child reads a held notice, so the notice commits into the
 *  sender's conversation, in the append that retires its cell. Resolves with
 *  the notices left for senders that still read.
 *
 *  The hold goes first and the sender's run is read after it. A run that
 *  ends records its end before it commits the notices that it holds, so
 *  either that commit reads this hold, or this read sees the run ended. Both
 *  commits converge on the key of the notice. */
async function commitAtEndedSenders(
  store: { readonly reader: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter },
  held: readonly HeldReturn[],
): Promise<ReturnedNotice[]> {
  const reading: ReturnedNotice[] = []
  for (const { senderSessionId, notification, destination } of held) {
    const tree = await endedSenderConversation(store, senderSessionId, destination)
    if (!tree) {
      reading.push({ senderSessionId, notification })
      continue
    }
    try {
      await tree.commitQueuedBackgroundNotification(notification)
    } finally {
      await tree.getStorage().dispose()
    }
    log.info("a returned-messages notice commits into the conversation of its ended sender", { senderSessionId, key: notification.key })
  }
  return reading
}

/** The conversation of a sender whose run ended, or null for a sender that
 *  still reads: a chat, a workflow, or a child whose run can resume. */
async function endedSenderConversation(
  store: { readonly reader: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter },
  senderSessionId: string,
  destination: HeldNotificationDestination,
) {
  if (destination.target !== "conversation") return null
  const { run } = await readChildSessionRunEvidence(store.reader, senderSessionId)
  if (!run || !childRunEnded(run)) return null
  return await tryOpenConversationTree({ conversationId: destination.conversationId, sessionId: senderSessionId, store: store.reader, writer: store.writer })
}

/** The live part of a settlement, run in the process where the sessions run,
 *  which keys their controls and reply waits by `reader`. Each returned
 *  notice reaches the live run of its sender; a sender with no live run here
 *  reads it at its next run. Then each wait on the ended recipient ends
 *  (PI-INTERACTION-136, PI-INTERACTION-137): a recipient that an interrupt paused or a
 *  delete removed has no live run to report its end, so its waits learn of
 *  it only here. */
export async function wakeAfterSettlement(reader: AsyncEventStateReadSurface, recipientSessionId: string, returned: readonly ReturnedNotice[]): Promise<void> {
  for (const { senderSessionId, notification } of returned) {
    try {
      await liveSessionControl(reader, senderSessionId)?.notify(notification)
    } catch (error) {
      log.warn("a returned-messages notice stays held for the next run of its sender", { senderSessionId, error: errorMessage(error) })
    }
  }
  await observeSessionChanged(reader, recipientSessionId)
}

function returnedNoticeKey(recipientSessionId: string, group: UnreadMessagesOfSender): string {
  return `returned:${recipientSessionId}:${group.cells[0]?.key ?? ""}`
}

/** Holds one notice for each sender where the sender reads it
 *  (`returnDestination`). Its key names the recipient and the first cell, so
 *  a repeat converges on one notice. A notice follows the completion-notice
 *  gate, so it starts no turn in an interrupted sender, and it never causes
 *  another notice. */
async function returnUnreadMessages(
  store: { readonly reader: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter },
  input: UnreadReturn,
  senders: readonly UnreadMessagesOfSender[],
  options: { readonly retire: boolean },
): Promise<HeldReturn[]> {
  const held: HeldReturn[] = []
  for (const group of senders) {
    const text = returnedMessagesNotice(input.recipientSessionId, input.reason, group.cells)
    const destination = returnDestination(group)
    const hold = heldBackgroundNotificationPut(destination, text, returnedNoticeKey(input.recipientSessionId, group))
    await store.writer.putInFlight?.(group.senderSessionId, hold.kind, hold.key, hold.payload)
    const notification = heldBackgroundNotification(destination, text, hold.key)
    if (options.retire) for (const cell of group.cells) await dropQueuedUserInput(store.writer, input.recipientSessionId, cell.key, cell.retainedGap)
    logReturned(input, group)
    held.push({ senderSessionId: group.senderSessionId, notification, destination })
  }
  return held
}

function logReturned(input: UnreadReturn, group: UnreadMessagesOfSender): void {
  log.info("unread messages returned", { senderSessionId: group.senderSessionId, recipientSessionId: input.recipientSessionId, reason: input.reason, count: group.cells.length })
}
