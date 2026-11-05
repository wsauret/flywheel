import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import { errorMessage } from "../../infra/error-message.js"
import { readCapturedFacts, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../infra/event-store-types.js"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { Log } from "../../infra/log.js"
import { authDir } from "../../infra/paths.js"
import { containSessionReads } from "../../infra/session-read-containment.js"
import { createSessionUsageSettlement, recoverSessionUsageSettlements, USAGE_SETTLEMENT_IN_FLIGHT_KIND } from "../agent-runtime/usage-settlement.js"
import { createHeadlessUsageAuthorityOwner } from "../headless/headless-usage-authority.js"
import { recoverSessionHistory } from "../modules.js"
import { installedChildSessionHistory } from "../session/module-session-operations.js"
import { reconcileAgentInput } from "../session/agent-input-reconciliation.js"
import { parseConversationTreeFact } from "../session/conversation/conversation-facts.js"
import { readReplyWaits } from "../session/conversation/reply-wait-cells.js"
import { tryOpenConversationTree, readReconciledTranscript } from "../session/conversation/conversation-tree-handle.js"
import { FILE_MUTATION_IN_FLIGHT_KIND } from "../session/file-mutation-fact-writers.js"
import { loadSessionPendingFileMutations, reconcilePendingFileMutations } from "../session/file-mutation-recovery.js"
import { FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, recoverFinalizedToolResultCheckpoints, retireLegacyFinalizedToolResultCheckpoints } from "../session/finalized-tool-result-checkpoint.js"
import { createSessionManager, type SessionManager } from "../session/manager.js"
import { isSessionOwnerGone } from "../session/pid-lock.js"
import { workflowRunReader } from "../module-catalog.js"
import { workflowMembershipReader } from "../session/workflow-membership.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"
import { createSessionToolExecutionStore, repairInterruptedToolExecutions } from "../session/tool-execution-store.js"
import { reconcileChildSessionCompletions } from "../session/child-session-reconciliation.js"
import { recordCutEpisode } from "../session-store/duration.js"
import { PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, readPlannedSessionContinuationAsync, recordOwedPersonInterrupt } from "../session/planned-session-continuation.js"
import {
  CHILD_SESSION_DELETION_IN_FLIGHT_KIND,
  childSessionDeletionPlan,
  decodeRetainedChildSessionDeletion,
  executeChildSessionDeletionPlan,
} from "../session/child-session-deletion.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import { loadQueueSnapshotFromReader } from "../../workflows/view/view-store.js"
import { liveWorkflowConversations } from "../../workflows/view/live-conversations.js"
import { createMutationEvidenceRecovery } from "../session/mutation-evidence-recovery.js"
import { createSessionRecoveryGate, settlingGuardReads, type OwedRecovery, type SessionRecoveryGate } from "./session-recovery-gate.js"
import { createProjectStateSessionsService } from "./project-state-sessions.js"

const log = Log.create({ service: "project-state-recovery" })

/** One per session that a dead owner left and whose recovery has not finished. */
export const SESSION_RECOVERY_OWED_IN_FLIGHT_KIND = "session.recovery_owed"

/** The conversations of a workflow's settled attempts. Only the follow-up, or
 *  the attempts in flight before one exists, can hold a turn their dead owner
 *  left unfinished, and parallel agents can be in flight at once. A settled
 *  attempt ends at its handoff's result with no reply after it, and the
 *  session's later work lies past its last reply, which a sweep there would
 *  claim as an unexpected exit of an attempt that finished. */
function settledAttemptConversations(queue: WorkflowView | null): ReadonlySet<string> {
  if (!queue) return new Set()
  const live = new Set(liveWorkflowConversations(queue))
  return new Set(queue.attempts.flatMap((attempt) => attempt.lastConversationId !== undefined && !live.has(attempt.lastConversationId) ? [attempt.lastConversationId] : []))
}

/** Which sessions a claim may take. A generation close claims every active
 *  session and every in-flight cell: this process's executor held them all.
 *  A process start claims only those whose owner process is proven gone,
 *  because a service on another lane may hold the rest of the project; an
 *  owner it cannot prove gone keeps its session as it is. */
type ProjectRecoveryScope = "closed-generation" | "ownerless"

type Degraded = { sessionId: string; error: string }

/** The state Worker's one projection reader over its store. It normalizes
 *  historical mutation evidence once, and each of its sequence reads settles
 *  the session it names first (see settlingGuardReads). The projection
 *  registry holds folds by reader identity, so every owner in the Worker must
 *  read through this one object: a second wrapper over the same store folds
 *  the same history again from its start, and holds a second copy of it. */
function projectStateReadSurface(gate: Pick<SessionRecoveryGate, "settle">) {
  return (reader: AsyncEventStateReadSurface, writer: Pick<AsyncEventWriter, "stageSessionContentNodes" | "swapInFlight">): AsyncEventStateReadSurface =>
    settlingGuardReads(createMutationEvidenceRecovery(reader, writer).reader, gate)
}

type ProjectStateOwners = ReturnType<typeof createProjectStateOwners>

/** The state Worker's whole session composition, in the two steps its store
 *  runtime forces. `readSurface` builds the store's one projection reader,
 *  which the runtime constructs; `open` then builds the owners over the reader
 *  and writer that the runtime hands back, with the recovery gate they share.
 *  The gate's reads settle only sessions that `owe` named, and those come from
 *  the claim that `open` returns, so no recovery runs before `open`. */
export function projectStateComposition(input: {
  readonly directories: ProjectDirectories
  readonly executionCwd: string
  /** Handoff predecessors proven no longer serving: a clean claim, cleared
   * holders, or this pid's previous image before startup admits session work. */
  readonly predecessorPids?: readonly number[]
}) {
  let owners: ProjectStateOwners | undefined
  const gate = createSessionRecoveryGate(async (owed) => {
    if (!owners) throw new Error(`session ${owed.sessionId} owes recovery before the project state owners exist`)
    await owners.recover(owed)
  })
  return {
    readSurface: projectStateReadSurface(gate),
    open(projectionReader: AsyncEventStateReadSurface, writer: AsyncEventWriter): ProjectStateOwners & { readonly gate: SessionRecoveryGate } {
      owners = createProjectStateOwners({ ...input, projectionReader, writer })
      return { ...owners, gate }
    },
  }
}

/** The state Worker's session owners, which all read through its one
 *  projection reader: the sole session manager, the session work the Worker
 *  serves beside it, and project recovery. */
function createProjectStateOwners(input: {
  readonly directories: ProjectDirectories
  readonly executionCwd: string
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly predecessorPids?: readonly number[]
}) {
  const { directories, projectionReader: reader, writer } = input
  const manager = createSessionManager({ projectRoot: directories.projectRoot, executionCwd: input.executionCwd, projectionReader: reader, writer })
  const sessions = createProjectStateSessionsService(manager, {
    recoverOrphanedRuns: () => recoverOrphanedChildRuns({ directories, reader, writer, manager }),
    // The account asks this while no executor holds the project, so this
    // Worker's writer is the conversation's one writer.
    interruptOwed: (sessionId) => recordOwedPersonInterrupt({ reader, projectionReader: reader, writer, manager, sessionId }),
  })
  return { manager, sessions, ...createProjectRecovery({ directories, reader, writer, manager, predecessorPids: input.predecessorPids }) }
}

/** Recovery of the sessions a dead owner left, in two halves. `claim` finds
 *  them without reading any history: the sessions left active and the
 *  sessions holding an in-flight cell another process must finish, among
 *  those the scope claims, plus the sessions an earlier pass claimed and did
 *  not finish. It records a `session.recovery_owed` cell for each one and then
 *  pauses the sessions left active, so a crash between the two leaves every
 *  claimed session findable. `recover` repairs one owed session and retires
 *  its cell. The state Worker runs `claim` before it serves, and `recover` for
 *  each owed session before that session's next write and in the background
 *  after clients connect (ARCH-SUBSTRATE-032). Every other session recovers lazily at its
 *  own load, so a project with a long history reopens in the time its cut
 *  sessions take. Domain owners publish recovery evidence without invoking
 *  tools. Indeterminate file mutations settle without attribution and retire
 *  their cells. A session whose history this release cannot read is reported and left
 *  paused; it never holds the project, a sibling session, or a later append
 *  (ARCH-SUBSTRATE-013). */
function createProjectRecovery(input: {
  readonly directories: ProjectDirectories
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly manager: SessionManager
  readonly predecessorPids?: readonly number[]
}) {
  const { reader: projectionReader, writer, manager, directories } = input
  const owedCells = requireInFlightWrites(writer)
  const runReader = workflowRunReader(projectionReader)
  const sweepChildren = (parentSessionId: string) => reconcileChildSessionCompletions({
    parentSessionId, reader: projectionReader, projectionReader, writer,
  })

  /** `interruptedSessionIds` names the sessions a person was interrupting
   *  when the account ended the closed generation to stop them: the turn it
   *  cut is the person's interrupt, not an unexpected exit (PI-INTERACTION-101). */
  async function claim(scope: ProjectRecoveryScope, interruptedSessionIds: readonly string[] = []): Promise<{ readonly owed: readonly OwedRecovery[]; readonly degraded: readonly Degraded[] }> {
    const interruptedByPerson = new Set(interruptedSessionIds)
    // Each candidate's owner kind is read on its own: listing every workflow
    // the project ever ran would make the start grow with its history.
    const ownerGone = (sessionId: string, kind: "workflow" | "session"): boolean =>
      scope !== "ownerless" || isSessionOwnerGone(sessionId, directories.projectRoot, kind, input.predecessorPids)
    const claimed = async (sessionIds: readonly string[]): Promise<string[]> => {
      const candidates = await Promise.all(sessionIds.map(async (sessionId) =>
        ({ sessionId, kind: (await runReader.read(sessionId)) ? "workflow" as const : "session" as const })))
      return candidates.filter(({ sessionId, kind }) => ownerGone(sessionId, kind)).map(({ sessionId }) => sessionId)
    }
    const degraded = await recoverRetainedDeletions({ ...input, claimed })
    const active = await manager.listActive()
    // The catalog lists sessions only, never a workflow.
    const live = active.sessions.filter((session) => ownerGone(session.id, "session"))
    const [earlier, ...inFlightSessions] = await Promise.all([
      projectionReader.sessionsWithInFlight(SESSION_RECOVERY_OWED_IN_FLIGHT_KIND),
      projectionReader.sessionsWithInFlight(USAGE_SETTLEMENT_IN_FLIGHT_KIND),
      projectionReader.sessionsWithInFlight(FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND),
      projectionReader.sessionsWithInFlight(FILE_MUTATION_IN_FLIGHT_KIND),
      projectionReader.sessionsWithInFlight(PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND),
    ])
    // A workflow is claimed only for its own in-flight cells. A stopped
    // workflow has no owner process, so "owner gone" holds for every workflow
    // the project ever ran: claiming each one re-read it and its parent at
    // every start. Its cut agents are live sessions, and a parked parent
    // reconciles its children when its runner starts.
    // Claimed before deactivation: closing a session removes its owner record.
    const sessionIds = new Set([
      ...live.map((session) => session.id),
      ...await claimed([...new Set(inFlightSessions.flat())]),
    ])
    const earlierCauses = new Map<string, OwedRecovery["cause"]>()
    for (const sessionId of await claimed(earlier)) earlierCauses.set(sessionId, await readOwedCause(projectionReader, sessionId))
    const owed: OwedRecovery[] = [
      ...[...earlierCauses].map(([sessionId, cause]) => ({ sessionId, cause })),
      ...[...sessionIds].filter((sessionId) => !earlierCauses.has(sessionId)).map((sessionId): OwedRecovery => ({ sessionId, cause: interruptedByPerson.has(sessionId) ? "interrupted" : "crash" })),
    ]
    for (const { sessionId, cause } of owed) if (!earlierCauses.has(sessionId)) await owedCells.putInFlight(sessionId, SESSION_RECOVERY_OWED_IN_FLIGHT_KIND, OWED_KEY, { cause })
    for (const session of live) await recordCutEpisodeOf(projectionReader, writer, session.id)
    for (const session of live) await manager.updateLifecycleState(session.id, "inactive")
    log.info("project recovery claimed", { owed: owed.length, earlier: earlierCauses.size, degraded: degraded.length })
    return { owed, degraded }
  }

  /** Repairs one owed session and retires its cell. Returns the error that
   *  degraded it, or null. */
  async function recover({ sessionId, cause }: OwedRecovery): Promise<string | null> {
    const startedAt = performance.now()
    const workflow = (await runReader.read(sessionId)) ?? undefined
    const owner = workflow ? { kind: "workflow" as const, workflowId: sessionId } : { kind: "session" as const, sessionId }
    const row = workflow ? undefined : (await manager.listForIds([sessionId])).sessions[0]
    const facts = createSessionFactWriter({ owner, writer })
    const errors: unknown[] = []
    try {
      const usage = {
        owner, reader: projectionReader, writer: facts,
        async acquireAuthority(profileId: string) {
          const profileDir = authDir(directories.userDataRoot, profileId)
          const authority = createHeadlessUsageAuthorityOwner({ id: profileId, directory: profileDir })
          const lease = await authority.acquire({ profileId, profileDir })
          return { ...lease, async release() { await lease.release(); await authority.settled() } }
        },
      }
      await recoverSessionUsageSettlements(usage, createSessionUsageSettlement(usage))
      const pendingFiles = await loadSessionPendingFileMutations(projectionReader, sessionId)
      errors.push(...pendingFiles.unreadableCells.map((cell) => new Error(`File mutation ${cell.key}: ${cell.reason}`)))
      const reconcileErrors = await reconcilePendingFileMutations({ sessionId, store: projectionReader, writer, initial: pendingFiles })
      errors.push(...reconcileErrors)
      if (!workflow) {
        const settled = row?.kind === "workflow-agent" && await isSettledMember(projectionReader, row.workflowMembership.workflowId, sessionId)
        await recoverSessionConversations(sessionId, cause, row?.conversationId, settled)
      }
    } catch (error) {
      errors.push(error)
    } finally {
      facts.dispose()
    }
    // The recovery of a claimed child and the repairs above change what the
    // reconciliation of this session and its parent reads.
    for (const parentSessionId of new Set([...(workflow ? [] : [sessionId]), ...(workflow ? [workflow.launchedFrom.parentSessionId] : row?.parentSessionId ? [row.parentSessionId] : [])])) {
      try {
        await sweepChildren(parentSessionId)
      } catch (error) {
        log.warn("child completion recovery degraded; the parent stays paused", { sessionId: parentSessionId, error: errorMessage(error) })
      }
    }
    await owedCells.dropInFlight(sessionId, SESSION_RECOVERY_OWED_IN_FLIGHT_KIND, OWED_KEY)
    log.info("owed session recovered", { sessionId, cause, degraded: errors.length > 0, durationMs: Math.round(performance.now() - startedAt) })
    if (errors.length === 0) return null
    const error = errors.map(errorMessage).join("; ")
    log.warn("session recovery degraded; the session stays paused and its bytes are untouched", { sessionId, error })
    return error
  }

  async function recoverSessionConversations(sessionId: string, cause: OwedRecovery["cause"], fallbackConversationId: string | undefined, settledMember: boolean): Promise<void> {
    const owner = { kind: "session" as const, sessionId }
    const facts = createSessionFactWriter({ owner, writer })
    const tools = createSessionToolExecutionStore({ sessionId, projectionReader })
    try {
      const conversationIds = new Set((await readCapturedFacts(projectionReader, { sessionId, types: ["chat.tree.created"] })).map((event) =>
        parseProjectionFact(event, parseConversationTreeFact).payload.conversationId))
      await retireLegacyFinalizedToolResultCheckpoints({
        sessionId, store: projectionReader, writer, conversationIds,
        openConversation: (conversationId) => tryOpenConversationTree({ sessionId, conversationId, store: projectionReader, writer }),
      })
      // A workflow's launching call waits for its child, which can run on
      // after the parent's owner is gone, so its missing result is no crash.
      // Reconciliation names the calls whose child has not ended, as it does
      // when a chat runner starts, and the repair below leaves them waiting.
      // It also records the result of each call whose child has ended and
      // holds that child's notification. So the crash record below never
      // names the call as unfinished, and it restores the held notification
      // after itself, as it restores all queued input of a dead owner.
      const childWorkflows = await sweepChildren(sessionId)
      // The predecessor of a planned replacement still holds the session's
      // continuation row, and its successor continues the cut wait with its
      // deadline. With no row, the dead owner held that wait last.
      const cutsRestoredWait = await readPlannedSessionContinuationAsync(projectionReader, sessionId) === null
      const openReplyWaits = new Set((await readReplyWaits(projectionReader, sessionId)).map((wait) => wait.toolUseId))
      const protectedToolUseIds = new Set(childWorkflows.linkedNonterminalWorkflowToolUseIds)
      for (const conversationId of conversationIds) {
        const options = { conversationId, sessionId, store: projectionReader, writer, projectRoot: directories.projectRoot }
        const tree = await tryOpenConversationTree({ ...options, store: projectionReader })
        if (!tree) continue
        try {
          await recoverFinalizedToolResultCheckpoints({ ...options, store: projectionReader, tree })
          const interaction = await reconcileAgentInput({ ...options, projectionReader, interactionScope: "conversation" })
          for (const id of interaction.protectedToolUseIds) protectedToolUseIds.add(id)
          if (!interaction.protectedPending && !settledMember) {
            await readReconciledTranscript({ ...options, store: projectionReader })
            // The owner is gone, so an unanswered message is a turn it never
            // finished: recorded here, it is what Resume continues.
            await tree.recordInterruptedTurn(cause, { ownerDead: true, cutsRestoredWait, holdsWait: (id) => openReplyWaits.has(id) })
          }
        } finally { tree.getStorage().dispose() }
      }
      await recoverSessionHistory({ sessionId, reader: projectionReader, projectionReader, writer, projectRoot: directories.projectRoot, fallbackConversationId, protectedToolUseIds })
      await repairInterruptedToolExecutions(tools, facts, protectedToolUseIds)
    } finally {
      tools.dispose()
      facts.dispose()
    }
  }

  return { claim, recover }
}

/** Whether a workflow agent's attempt settled before its owner died: its
 *  conversation then ends at its handoff, and a sweep would claim a finished
 *  attempt as an unexpected exit. */
async function isSettledMember(reader: AsyncEventStateReadSurface, workflowId: string, sessionId: string): Promise<boolean> {
  const settled = settledAttemptConversations(await loadQueueSnapshotFromReader(reader, workflowId))
  return (await workflowMembershipReader(reader).list(workflowId)).some((member) => member.sessionId === sessionId && settled.has(member.conversationId))
}

const OWED_KEY = "recovery"

/** The cause an earlier pass recorded. A cell this build cannot read is named
 *  in a warning and recovers as an unexpected exit, the cause every pass
 *  assumes when no person's interrupt is known. */
async function readOwedCause(reader: AsyncEventStateReadSurface, sessionId: string): Promise<OwedRecovery["cause"]> {
  const payload = (await reader.readInFlight(sessionId, SESSION_RECOVERY_OWED_IN_FLIGHT_KIND)).find((row) => row.key === OWED_KEY)?.payload
  const cause = typeof payload === "object" && payload !== null && "cause" in payload ? payload.cause : undefined
  if (cause === "crash" || cause === "interrupted") return cause
  log.warn("owed recovery cell has a shape this build cannot read; the session recovers as an unexpected exit", { sessionId })
  return "crash"
}

function requireInFlightWrites(writer: AsyncEventWriter): Required<Pick<AsyncEventWriter, "putInFlight" | "dropInFlight">> {
  const { putInFlight, dropInFlight } = writer
  if (!putInFlight || !dropInFlight) throw new Error("project recovery needs a writer that writes in-flight cells")
  return { putInFlight, dropInFlight }
}

/** A session left active may have been cut inside an episode, and the
 *  active time of that episode reached no record. The fold is bookkeeping:
 *  a failure is recorded and never degrades the session's recovery. */
async function recordCutEpisodeOf(reader: AsyncEventStateReadSurface, writer: AsyncEventWriter, sessionId: string): Promise<void> {
  try {
    const cutMs = await recordCutEpisode(reader, writer, sessionId)
    if (cutMs > 0) log.info("cut episode folded into the session duration", { sessionId, cutMs })
  } catch (cause) {
    log.warn("cut episode could not be folded; the session keeps its recorded duration", { sessionId, error: errorMessage(cause) })
  }
}

/** Finishes each retained deletion that the pass claims. A deletion that
 *  cannot finish, because its cell does not read or its owner refuses a
 *  target, keeps its cell and is reported once as degraded. It never stops
 *  the project's open or another deletion (ARCH-SUBSTRATE-013). One deletion can finish
 *  only after another: a parent's admitted edge to a child that was unlinked
 *  is complete once the child's own deletion ends. So the pass tries the
 *  refused deletions again while a round still finishes one, and the order of
 *  the cells does not matter. */
async function recoverRetainedDeletions(input: {
  readonly directories: ProjectDirectories
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly manager: SessionManager
  readonly claimed: (sessionIds: readonly string[]) => Promise<string[]>
}): Promise<{ sessionId: string; error: string }[]> {
  const { reader, manager } = input
  let pending = await input.claimed(await reader.sessionsWithInFlight(CHILD_SESSION_DELETION_IN_FLIGHT_KIND))
  const refused = new Map<string, string>()
  while (pending.length > 0) {
    const retry: string[] = []
    for (const rootSessionId of pending) {
      try {
        const rows = await reader.readInFlight(rootSessionId, CHILD_SESSION_DELETION_IN_FLIGHT_KIND)
        if (rows.length > 1) throw new Error(`Session ${rootSessionId} has multiple recursive deletion operations`)
        const row = rows.at(0)
        // Another deletion of this pass already deleted the root with its cell.
        if (row) {
          await executeChildSessionDeletionPlan({
            projectRoot: input.directories.projectRoot,
            reader,
            projectionReader: reader,
            writer: input.writer,
            read: manager.read,
            finalizeDeletionTarget: manager.finalizeDeletionTarget,
          }, childSessionDeletionPlan(decodeRetainedChildSessionDeletion(row.payload, rootSessionId)))
        }
        refused.delete(rootSessionId)
      } catch (cause) {
        refused.set(rootSessionId, errorMessage(cause))
        retry.push(rootSessionId)
      }
    }
    if (retry.length === pending.length) break
    pending = retry
  }
  for (const [sessionId, error] of refused) {
    log.warn("retained session deletion degraded; its operation is kept and the project opens", { sessionId, error })
  }
  return [...refused].map(([sessionId, error]) => ({ sessionId, error }))
}

/** Settles the child runs a process that is gone left open. A child whose
 *  session is inactive, whose owner is proven gone, and whose latest run was created
 *  and never settled or authorized to continue is not running: a run starts
 *  in the same append that activates its session, so an inactive session with
 *  an open run is a record an earlier process never closed. The pass records
 *  it interrupted by the restart, which makes it resumable (ARCH-SESSIONS-018), through
 *  the history recovery a session's own load runs. It runs on the deferred
 *  stale-session pass after readiness, never on the startup path. One targeted
 *  child-history read finds open runs, then one aggregate metadata read confirms
 *  each candidate. Returns how many runs it settled. */
export async function recoverOrphanedChildRuns(input: {
  readonly directories: ProjectDirectories
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly manager: Pick<SessionManager, "read">
}): Promise<number> {
  const { reader: projectionReader, writer, directories } = input
  const history = installedChildSessionHistory()
  const events = await readCapturedFacts(projectionReader, { types: history.factTypes })
  const eventsBySession = new Map<string, (typeof events)[number][]>()
  for (const event of events) {
    const sessionEvents = eventsBySession.get(event.sessionId)
    if (sessionEvents) sessionEvents.push(event)
    else eventsBySession.set(event.sessionId, [event])
  }
  // One session whose run history this build cannot read keeps its run open
  // and does not stop the pass for the others.
  const runReads = containSessionReads(log, "recover orphaned child run")
  let settled = 0
  for (const [sessionId, sessionEvents] of eventsBySession) {
    const run = await runReads.read(sessionId, async () => history.loadRuns(sessionEvents).at(-1), undefined)
    if (run?.status !== "created") continue
    const session = await input.manager.read(sessionId)
    if (session?.kind !== "subagent" || session.lifecycleState !== "inactive") continue
    if (!isSessionOwnerGone(sessionId, directories.projectRoot) || await readPlannedSessionContinuationAsync(projectionReader, sessionId)) continue
    try {
      await recoverSessionHistory({ sessionId, reader: projectionReader, projectionReader, writer, projectRoot: directories.projectRoot, fallbackConversationId: session.conversationId })
      settled += 1
      log.info("orphaned child run settled as interrupted", { sessionId })
    } catch (cause) {
      log.warn("orphaned child run could not be settled; it stays open and blocks nothing", { sessionId, error: errorMessage(cause) })
    }
  }
  return settled
}
