import { requireGuardedEventAppender, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../../../infra/event-store-types.js"
import { liveChildRun, whenLiveChildRun, type LiveChildControl } from "../../../session/live-session-control.js"
import { readUnreadMessages, type QueuedUserInputCell } from "../../../session/conversation/queued-user-inputs.js"
import { readConversationBackgroundNotifications } from "../../../session/conversation/queued-background-notifications.js"
import { tryOpenConversationTree } from "../../../session/conversation/conversation-tree-handle.js"
import { readPlannedSessionContinuationAsync } from "../../../session/planned-session-continuation.js"
import { settleUnreadMessages, wakeAfterSettlement } from "../../../session/session-input-delivery.js"
import { readSubagentRuns } from "../history/subagent-run-projection.js"
import { buildSubagentCompleted } from "../history/subagent-run-fact-writers.js"
import { cancelledSubagentContent, stoppedSubagentContent } from "./result-resolver.js"
import { prepareSessionFactAppend } from "../../../session/session-fact-writer.js"
import { reconcileChildSessionCompletions } from "../../../session/child-session-reconciliation.js"
import { Log } from "../../../../infra/log.js"
import type { ChildStopAnswer, ParentNotificationDelivery } from "../../../module-seams.js"

const log = Log.create({ service: "subagent-control" })

interface SubagentEndInput {
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly projectRoot: string
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly deliverNotification?: ParentNotificationDelivery
}

/** How long a Stop waits for a run that is starting in this process to
 *  register its control. A dispatch or a Resume records the run as created a
 *  few store round trips before its control exists. A run that another
 *  process starts, such as a headless run's, never registers here. */
const STARTING_RUN_WAIT_MS = 5_000

/** The Stop of one subagent by a person or by its parent agent, the
 *  module's `childSession.stop`. A person's Stop records `stopped`, and the
 *  parent's records `cancelled`. A run that is live in this process stops
 *  through its own control, which records the completion and answers the
 *  parent as the run ends; the Stop resolves only after that run has
 *  settled, as a child deletion does. A run that is starting in this
 *  process is stopped the same way once its control registers. A run that
 *  an interrupt or an unexpected exit left waiting has no work to cut: the
 *  Stop records its completion here, guarded on the child's sequence so
 *  that a concurrent Resume or Stop wins once, and the parent's
 *  reconciliation gives the waiting call its one result. Any other run has
 *  ended, or a planned replacement's successor or another process owns it,
 *  and the Stop changes nothing. Terminal results still reconcile to the parent. */
export async function stopSubagentSession(input: SubagentEndInput & { readonly by: "person" | "agent" }): Promise<ChildStopAnswer> {
  const outcome = await endSubagentRun(input, input.by)
  const run = (await readSubagentRuns(input.projectionReader, input.childSessionId)).at(-1)
  if (!run) return { ok: false, error: "This child has no recorded run to stop." }
  if (run.status === "created" || run.status === "paused" || run.status === "interrupted") {
    return { ok: false, error: outcome === "contended"
      ? "This child's run changed during Stop. Cancellation was not confirmed. Inspect its status before acting again."
      : "This child has no terminal result after Stop. Cancellation was not confirmed." }
  }
  // A live run schedules reconciliation after settlement. Join its parent lane
  // before returning so a following Resume cannot race the inactive write.
  await reconcileParent(input)
  return { ok: true, status: run.status }
}

/** The settlement of a subagent child that a deletion removes, the module's
 *  `sessionDeletion`. Deleting a child stops it as a person's Stop does, so
 *  its parent's launching call gets one `stopped` result. Nothing continues a
 *  deleted child, so a run that only a planned successor or another process
 *  would continue is stopped too. The ended run settles its unread messages
 *  (ARCH-SESSIONS-031): the person's commit to its conversation, so the deleted history
 *  keeps what a person sent, and the parent's ride its `stopped` result. The
 *  parent is reconciled last, before the unlink, after which no
 *  reconciliation finds the child. */
export async function settleDeletedSubagent(input: SubagentEndInput & { readonly conversationId: string }): Promise<void> {
  const unread = await readUnreadMessages(input.projectionReader, input.childSessionId)
  await commitHeld(input, input.conversationId, unread.filter((cell) => cell.producer?.kind !== "session"))
  await endSubagentRun(input, "deletion")
  await reconcileParent(input)
}

/** Ends the child's current run as a Stop by `owner`, or for a deletion,
 *  which a person's Stop settles: through the control of a run live or
 *  starting in this process, which records its own completion, or by a
 *  guarded completion of a run that no process runs. `stored` when this
 *  call recorded that completion. */
async function endSubagentRun(input: SubagentEndInput, owner: "person" | "agent" | "deletion"): Promise<"live" | "stored" | "contended" | "nothing-waits"> {
  const live = liveChildRun(input.eventStore, input.childSessionId)
  if (live) return await stopLive(input, live, owner, "live")
  // The guard is read before the run, so a Resume or Stop that lands after
  // this read makes the append below contend instead of completing a run
  // that a later write already moved on.
  const expectedSeq = await input.projectionReader.aggregateSeq(`session:${input.childSessionId}`) + 1
  const run = (await readSubagentRuns(input.projectionReader, input.childSessionId)).at(-1)
  const planned = owner !== "deletion" && run?.status === "created" ? await readPlannedSessionContinuationAsync(input.projectionReader, input.childSessionId) : null
  const successorOwned = planned?.target.kind === "subagent" && planned.runId === run?.childRunId
  // A deletion settles the run where it stands: nothing continues a
  // deleted child, so it does not wait for one to start.
  if (owner !== "deletion" && run?.status === "created" && !successorOwned) {
    if (await input.projectionReader.aggregateSeq(`session:${input.childSessionId}`) + 1 !== expectedSeq) {
      log.info("subagent stop decision", { sessionId: input.childSessionId, owner, decision: "contended", status: run.status })
      return "contended"
    }
    const starting = await startingRunControl(input)
    if (starting) {
      if (await input.projectionReader.aggregateSeq(`session:${input.childSessionId}`) + 1 !== expectedSeq
        || starting.child.runId !== run.childRunId
        || liveChildRun(input.eventStore, input.childSessionId) !== starting) {
        log.info("subagent stop decision", { sessionId: input.childSessionId, owner, decision: "contended", status: run.status })
        return "contended"
      }
      return await stopLive(input, starting, owner, "starting")
    }
  }
  const ends = run !== undefined && (
    run.status === "paused"
    || (run.status === "interrupted" && run.interruptionReason === "runtime_restarted")
    || (owner === "deletion" && run.status === "created")
  )
  if (!run || !ends) {
    log.info("subagent stop decision", { sessionId: input.childSessionId, owner, decision: "nothing-waits", status: run?.status ?? "none" })
    return "nothing-waits"
  }
  // A run no process runs holds what arrived after it stopped reading. The
  // parent's messages ride the `stopped` result and retire with it, so they
  // return exactly once (ARCH-SESSIONS-031). A deletion leaves every other
  // sender's messages to its tombstone, whose notices name the deletion.
  const { conversationId } = run
  const outcome = await settleUnreadMessages({ reader: input.projectionReader, writer: input.writer }, {
    recipientSessionId: input.childSessionId,
    reason: owner === "deletion" ? "deleting" : "settled",
    parent: { sessionId: input.parentSessionId, ...(run.parentConversationId ? { conversationId: run.parentConversationId } : {}) },
    end: async (parentReturn) => {
      const content = owner === "agent" ? cancelledSubagentContent(run.agentType, run.description) : stoppedSubagentContent(run.agentType, run.description)
      const appended = await requireGuardedEventAppender(input.writer, "Subagent stop requires guarded append authority").appendBatchGuarded([{
        ...prepareSessionFactAppend(input.childSessionId, buildSubagentCompleted({
          childRunId: run.childRunId,
          status: owner === "agent" ? "cancelled" : "stopped",
          isError: true,
          content: parentReturn?.completion(content) ?? content,
          durationMs: 0,
        }), undefined, parentReturn?.retirements),
        expectedSeq,
      }])
      return appended.kind === "stored"
    },
    commitHeld: async (person) => { if (conversationId) await commitHeld(input, conversationId, person) },
  })
  if (outcome.stored) await wakeAfterSettlement(input.projectionReader, input.childSessionId, outcome.returned)
  const decision = outcome.stored ? "stored" : "contended"
  log.info("subagent stop decision", { sessionId: input.childSessionId, owner, decision, status: run.status })
  return decision
}

/** Commits what the child leaves held for its conversation: the person's
 *  unread messages, so a later run or the deleted history keeps what a
 *  person sent, then each notice that no run read. It commits through the
 *  tree itself, not an idle writer commit, which would also recover the
 *  messages of sessions that return to their senders. */
async function commitHeld(input: SubagentEndInput, conversationId: string, person: readonly QueuedUserInputCell[]): Promise<void> {
  const notices = await readConversationBackgroundNotifications(input.projectionReader, input.childSessionId, conversationId)
  if (person.length === 0 && notices.length === 0) return
  const tree = await tryOpenConversationTree({ conversationId, sessionId: input.childSessionId, store: input.projectionReader, writer: input.writer })
  if (!tree) return
  try {
    for (const cell of person) {
      if (cell.target === "conversation" && cell.conversationId === conversationId) await tree.commitQueuedUserInput(cell)
    }
    for (const notice of notices) await tree.commitQueuedBackgroundNotification(notice)
  } finally {
    await tree.getStorage().dispose()
  }
}

async function stopLive(input: SubagentEndInput, control: LiveChildControl, owner: "person" | "agent" | "deletion", decision: "live" | "starting"): Promise<"live"> {
  log.info("subagent stop decision", { sessionId: input.childSessionId, owner, decision })
  control.child.stop(owner)
  await control.settled
  return "live"
}

/** The control of a run that a dispatch or a Resume in this process starts,
 *  once it registers, or nothing when none registers within the bound. */
async function startingRunControl(input: SubagentEndInput): Promise<LiveChildControl | undefined> {
  const wait = whenLiveChildRun(input.eventStore, input.childSessionId)
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), STARTING_RUN_WAIT_MS) })
  try {
    if (await Promise.race([wait.active, bound]) === "timeout") return undefined
    return liveChildRun(input.eventStore, input.childSessionId)
  } finally {
    clearTimeout(timer)
    wait.cancel()
  }
}

/** Records the parent's one result and holds its notification, then hands
 *  the notification to the parent's attached runner, as a live run's own
 *  completion does. Without that delivery, a parent that waits on the child
 *  would never hear that a person ended it. */
async function reconcileParent(input: SubagentEndInput): Promise<void> {
  const { deliverNotification, parentSessionId } = input
  await reconcileChildSessionCompletions({
    parentSessionId,
    reader: input.eventStore,
    projectionReader: input.projectionReader,
    writer: input.writer,
    ...(deliverNotification ? { deliverNotification: (notification) => deliverNotification(parentSessionId, notification) } : {}),
  })
}
