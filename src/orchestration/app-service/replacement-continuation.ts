import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { FrontendMutation, RuntimeClient } from "../../protocol/app-service-types.js"
import { commandHandoversForAsync } from "../session/command-handover.js"
import type { SessionManager } from "../session/manager.js"
import { attachChatOwners, type ChatHostAttach, type ExecutorCommandHandover } from "./executor-command-handover.js"
import { authorizePlannedSessionContinuation, continuationTargetId, plannedContinuationWork, plannedContinuationsFor, readPlannedSessionContinuationAsync, recordInterrupt, retirePlannedSessionContinuation, type ContinuationLanes, type PlannedSessionContinuation } from "../session/planned-session-continuation.js"
import type { WorkflowController } from "../workflow-host/controller.js"
import { readChatTurnEndEvidence } from "../session/chat-session-run-evidence.js"

const log = Log.create({ service: "replacement-continuation" })

interface ReplacementContinuationInput extends ChatHostAttach, Pick<ExecutorCommandHandover, "keep"> {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  /** The executor's continuation lanes, where each resume takes turns with
   *  a person's interrupt of its session. */
  readonly lanes: ContinuationLanes
  readonly dispatch: RuntimeClient["dispatch"]
  /** The internal successor path preserves person and parent parks in sibling attempts. */
  readonly resumePlannedWorkflow: (sessionId: string) => ReturnType<WorkflowController["resumeWorkflow"]>
  readonly handoffId: string
  /** Told once a session's continuation has settled, however it ended, so
   *  the status every surface shows follows it: a session whose resume was
   *  refused shows at rest again, with its Resume. */
  readonly settled: (sessionId: string) => void
}

/** The successor's half of a planned replacement in one project (ARCH-SESSIONS-039):
 *  each session continues its runtime-cut work, with nobody acting and
 *  nothing shown. A workflow keeps its person and parent parks.
 *
 *  Each row stays until its resume has settled, so every process reads the
 *  session as owed its continuation, and every surface shows it working,
 *  until then. Only work that still waits where the runtime interrupted it
 *  is resumed: its last turn end is the runtime's interrupt, normally the
 *  planned cut that the cut or the stop recorded, and no Resume has
 *  continued it since (`awaitsPlannedContinuation`). A Resume records that
 *  it began in the conversation before its first request, so a crash after
 *  a resume began leaves a turn that a person resumes, and the next attempt
 *  retires the row with no resume: no session resumes twice.
 *  A row whose session ended any other way, such as a turn a person
 *  interrupted after the cut, is retired and the session is left as it is
 *  (PI-REMOTE-020). A person's interrupt that arrives before the resume is
 *  dispatched wins, and the session is not resumed. A refused resume is
 *  reported and never holds the others, and neither does a session whose
 *  continuation evidence cannot be read: it keeps its row, and the others
 *  continue (AGENTS.md: unreadable bytes never block other sessions). The
 *  call then rejects with one AggregateError that names each such session,
 *  so the caller's duty tries the handoff again on its backoff. The rows
 *  that settled are gone by then, so the next attempt resumes only the
 *  sessions this one left, and the session shows working until one does.
 *
 *  Before any resume, every running command the handoff handed over gets a
 *  host here: the attached host of its chat, which adopts it, and for every
 *  other owner the keeper, from which the host a resume constructs takes it
 *  before its first request. So a resumed turn parks on the command as it
 *  parked before, and the command of work that is not resumed, such as a
 *  an agent of a workflow that a person paused, has Stop and a status row all the same. A
 *  chat that holds only a command is attached and not resumed.
 *
 *  A child under a chat resumes first: its parent is opened for it and keeps
 *  waiting, so the parent's own resume finds it running. A child under an
 *  agent of a workflow resumes last, through the agent that the workflow's
 *  resume re-entered. Returns the sessions it resumed. */
export async function continueAfterReplacement(input: ReplacementContinuationInput): Promise<readonly string[]> {
  await input.keep(await attachChatOwners(input, await commandHandoversForAsync(input.projectionReader, input.handoffId)))
  const continuations = await plannedContinuationsFor(input.projectionReader, input.handoffId)
  const failures: { readonly sessionId: string; readonly error: unknown }[] = []
  const ranked = (await Promise.all(continuations.map(async (continuation) => {
    try {
      return [{ continuation, ...await resumeOrder(input.manager, continuation) }]
    } catch (error) {
      failures.push({ sessionId: continuationTargetId(continuation.target), error })
      return []
    }
  }))).flat()
  const scheduled = new Set(ranked.map(({ continuation }) => continuationTargetId(continuation.target)))
  const resumed: string[] = []
  while (ranked.length > 0) {
    ranked.sort((left, right) => left.rank - right.rank)
    const nextIndex = ranked.findIndex((candidate) => !ranked.some((other) => continuationTargetId(other.continuation.target) === candidate.parentContinuationId))
    const [next] = ranked.splice(nextIndex, 1)
    if (!next) break
    const sessionId = continuationTargetId(next.continuation.target)
    try {
      const result = await input.lanes.resume(sessionId, (mayDispatch) => continueOne(input, sessionId, mayDispatch))
      if (result.resumed) resumed.push(sessionId)
      for (const continuation of result.transferred) {
        const id = continuationTargetId(continuation.target)
        if (scheduled.has(id)) continue
        scheduled.add(id)
        ranked.push({ continuation, ...await resumeOrder(input.manager, continuation) })
      }
    } catch (error) {
      failures.push({ sessionId, error })
      continue
    }
    input.settled(sessionId)
  }
  if (failures.length > 0) {
    const reasons = failures.map(({ sessionId, error }) => `${sessionId}: ${errorMessage(error)}`).join("; ")
    throw new AggregateError(failures.map(({ error }) => error), `The planned continuation of ${failures.length} of ${continuations.length} sessions failed, and each keeps its row: ${reasons}`)
  }
  return resumed
}

/** Resumes one session in its continuation lane and retires its row once
 *  the resume has settled; whether it resumed. The row and the session's
 *  work are read in the lane, so this step finds what a step before it,
 *  such as a person's interrupt or an earlier attempt, left. */
async function continueOne(
  input: ReplacementContinuationInput,
  sessionId: string,
  mayDispatch: () => boolean,
): Promise<{ readonly resumed: boolean; readonly transferred: readonly PlannedSessionContinuation[] }> {
  const continuation = await readPlannedSessionContinuationAsync(input.projectionReader, sessionId)
  // A person's interrupt or an earlier attempt retired the row first. A
  // row of a workflow's agent is a capacity wait's, which names no handoff.
  if (continuation?.handoffId !== input.handoffId || continuation.target.kind === "workflow-agent") return { resumed: false, transferred: [] }
  const { kind } = continuation.target
  const retire = (): Promise<boolean> => retirePlannedSessionContinuation({ reader: input.projectionReader, writer: input.writer, sessionId, handoffId: input.handoffId })
  const work = await plannedContinuationWork(input, sessionId)
  if (!work) {
    await retire()
    log.info("the session's work no longer waits where the runtime interrupted it, so it is not resumed", { sessionId, kind })
    return { resumed: false, transferred: [] }
  }
  if (!mayDispatch()) {
    // The interrupt that withdrew this resume, next in the session's lane,
    // records the person's turn end over the cut and retires the row.
    log.info("a person interrupted the session before its planned continuation resumed it; it is not resumed", { sessionId, kind })
    return { resumed: false, transferred: [] }
  }
  const transferred: PlannedSessionContinuation[] = []
  const childOperations = new Map<string, typeof work.operations[number][]>()
  for (const operation of work.operations) {
    const id = continuationTargetId(operation.target)
    if (id === sessionId) continue
    const current = childOperations.get(id)
    if (current) current.push(operation)
    else childOperations.set(id, [operation])
  }
  for (const [childSessionId, childWork] of childOperations) {
    const childKind = childWork[0]?.target.kind
    if (childKind !== "workflow") continue
    const childContinuation: PlannedSessionContinuation = {
      version: 3,
      target: { kind: childKind, workflowId: childSessionId },
      handoffId: input.handoffId,
      operations: childWork.map(({ operation }) => operation),
    }
    await authorizePlannedSessionContinuation({
      reader: input.projectionReader,
      writer: input.writer,
      continuation: {
        target: childContinuation.target,
        handoffId: input.handoffId,
        operations: childContinuation.operations,
      },
    })
    transferred.push(childContinuation)
  }
  const self = work.conversationId !== undefined || work.workflowId !== undefined
    ? continuation.target
    : work.operations.find(({ target }) => continuationTargetId(target) === sessionId)?.target
  if (!self) {
    await retire()
    return { resumed: false, transferred }
  }
  // The conversation of a chat whose cut background wait the attach restores.
  // A failed read throws before the row retires, so the continuation duty
  // tries the handoff again.
  const waitingConversationId = self.kind === "chat" && work.conversationId !== undefined
    && (await readChatTurnEndEvidence(input.projectionReader, work.conversationId, { restoreWait: true }))?.restoredWait !== undefined
    ? work.conversationId
    : undefined
  let resumed = false
  try {
    const result: unknown = waitingConversationId !== undefined
      ? { ok: await input.supervisor.activateSession(sessionId) }
      : self.kind === "workflow"
      ? await input.resumePlannedWorkflow(self.workflowId).then((outcome) => outcome.kind === "resumed" || outcome.kind === "already_running" ? { ok: true } : { ok: false, error: outcome.message })
      : await input.dispatch(resumeMutation(self))
    resumed = typeof result === "object" && result !== null && "ok" in result && result.ok === true
    if (!resumed) log.warn("planned continuation resume was refused; the session stays interrupted", { sessionId, kind, result: JSON.stringify(result) })
  } catch (error) {
    log.warn("planned continuation resume failed; the session stays interrupted", { sessionId, kind, error: errorMessage(error) })
  }
  // No successor holds the cut wait now, so an ordinary stop ends it, and
  // the attach of a later tab parks it with no deadline (ARCH-SESSIONS-038). The row
  // retires only after the record lands, so no attach reads the planned cut
  // alone once the row is gone; a failed record keeps the row for a retry.
  if (!resumed && waitingConversationId !== undefined) await recordInterrupt(input, "runtime", sessionId, waitingConversationId)
  await retire()
  return { resumed, transferred }
}

/** The Resume a continuation of a chat or a child dispatches. */
export function resumeMutation(continuation: { readonly sessionId: string; readonly kind: "chat" | "subagent" }): FrontendMutation {
  if (continuation.kind === "chat") return { type: "chat.resume", sessionId: continuation.sessionId }
  return { type: "subagent.resume", sessionId: continuation.sessionId }
}

/** 0: a child under a chat; 1: a chat or a workflow; 2: a child under an
 *  agent of a workflow. */
async function resumeOrder(manager: Pick<SessionManager, "read">, continuation: PlannedSessionContinuation): Promise<{ readonly rank: number; readonly parentContinuationId?: string }> {
  if (continuation.target.kind !== "subagent") return { rank: 1 }
  const child = await manager.read(continuation.target.sessionId)
  if (child?.kind !== "subagent") return { rank: 0 }
  const parent = await manager.read(child.launchedFrom.parentSessionId)
  return { rank: parent?.kind === "workflow-agent" ? 2 : 0, ...(parent?.kind === "subagent" ? { parentContinuationId: child.launchedFrom.parentSessionId } : {}) }
}
