import { Result, Schema } from "effect"
import { isSessionHistoryFailure, type AsyncEventStateReadSurface, type AsyncEventWriter, type EventStoreAppend, type InFlightRecord } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { loadQueueSnapshotFromReader } from "../../workflows/view/view-store.js"
import { startedAgents } from "../../workflows/vm/host-commit-controller.js"
import { addressReachesAgent } from "../../workflows/context-bundle/context-facts.js"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "./conversation/addressed-workflow-messages.js"
import { installedChildSessionHistory, retainedOperationContinuations } from "./module-session-operations.js"
import type { ChildSessionRun, RetainedOperationContinuation, RetainedOperationContinuationTarget } from "../module-seams.js"
import { whenLiveChildRun, type LiveChildControl } from "./live-session-control.js"
import { readWaitsAtRuntimeInterrupt } from "./chat-session-run-evidence.js"
import { tryOpenConversationTree } from "./conversation/conversation-tree-handle.js"
import { createConversationTreeWriter } from "./conversation/conversation-tree-writer.js"
import type { ControlInterruption, PlannedCutInterrupt } from "./conversation/turn-end-record.js"
import type { PausedBy } from "../../infra/output-blocks.js"
import type { SessionManager } from "./manager.js"
import { readSessionMetadata } from "./session-metadata-store.js"

const log = Log.create({ service: "planned-session-continuation" })

export const PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND = "session.planned_continuation"

/** The session kinds a planned replacement interrupts and its successor resumes. */
type PlannedContinuationKind = "chat" | "workflow" | "subagent"

/** One session's authority to be continued after a planned replacement
 *  (ARCH-SESSIONS-039). A replacement writes it just before the runtime interrupts the
 *  session, and the successor that consumes the replacement's handoff
 *  resumes the session and retires the row once that resume has settled, so
 *  every process reads the session as owed its continuation until then. It
 *  is in-flight state, never history: an ordinary shutdown writes none, and
 *  an unexpected exit leaves interrupted work to a person's Resume. The row
 *  holds the authority only, never the progress of a resume: whether a
 *  resume already began is read from the conversation it continues
 *  (`waitsAtRuntimeInterrupt`), which is the ledger of what ran (ARCH-SUBSTRATE-038).
 *  - `handoffId` names the replacement that wrote the row; only the successor
 *    that consumes that handoff resumes the session automatically. A row
 *    without one is resumable by hand only.
 *  - `runId` is the child run a `subagent` row continues; the run's own facts
 *    remain the authority for its parent binding.
 *  - `operations` identifies module-owned deterministic work at the safe point
 *    the cut observed. The retained cell or published child remains the work
 *    evidence; this row only authorizes the successor to continue it.
 *  - `continuesAt` marks the row of a capacity wait (PI-MODEL-039): the
 *    agent of the session waits for model capacity until that
 *    epoch-millisecond time. It names no handoff; the executor that serves
 *    the project next continues the session (`capacity-wait.ts`). An agent
 *    of a workflow holds its own row, as a `workflow-agent` target, so a
 *    continuation resumes only the agents that waited. */
export interface PlannedSessionContinuation {
  readonly version: 3
  readonly target: PlannedContinuationTarget
  readonly handoffId?: string
  readonly runId?: string
  readonly operations?: readonly RetainedOperationContinuation[]
  readonly continuesAt?: number
}

/** The work a row continues: a replacement's target, or the one agent of a
 *  workflow that a capacity wait names. */
export type PlannedContinuationTarget = RetainedOperationContinuationTarget | { readonly kind: "workflow-agent"; readonly sessionId: string }

const KINDS: readonly PlannedContinuationKind[] = ["chat", "workflow", "subagent"]

export function continuationTargetId(target: PlannedContinuationTarget): string {
  return target.kind === "workflow" ? target.workflowId : target.sessionId
}

/** How long the account waits for the cut of the running work to settle
 *  before the stop begins, and how long a person's interrupt of a session
 *  waits for its turn in the session's continuation lane. */
export const PLANNED_CUT_LIMIT_MS = 30_000

/** The stored rows of one session, each decoded to the current shape. A row
 *  of a version this release does not know is reported and left in place. */
function decodedContinuations(rows: readonly InFlightRecord[], sessionId: string): { readonly row: InFlightRecord; readonly continuation: PlannedSessionContinuation }[] {
  return rows.flatMap((row) => {
    const continuation = decodePlannedSessionContinuation(row, sessionId)
    return continuation ? [{ row, continuation }] : []
  })
}

/** The session's continuation authority, or null when it holds none this
 *  release can read. */
export async function readPlannedSessionContinuationAsync(
  reader: Pick<AsyncEventStateReadSurface, "readInFlight">,
  sessionId: string,
): Promise<PlannedSessionContinuation | null> {
  const stored = decodedContinuations(await reader.readInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND), sessionId)
  if (stored.length > 1) throw new Error(`Session ${sessionId} has multiple planned continuation authorizations`)
  return stored[0]?.continuation ?? null
}

/** Every continuation row of the project, or of `only` those sessions, that
 *  `select` keeps. */
async function plannedContinuationsWhere<T extends PlannedSessionContinuation>(reader: Pick<AsyncEventStateReadSurface, "sessionsWithInFlight" | "readInFlight">, select: (continuation: PlannedSessionContinuation) => continuation is T, only?: readonly string[]): Promise<readonly T[]> {
  const sessions = only ?? await reader.sessionsWithInFlight(PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND)
  return (await Promise.all(sessions.map(async (sessionId) =>
    decodedContinuations(await reader.readInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND), sessionId)
      .flatMap(({ continuation }) => select(continuation) ? [continuation] : [])))).flat()
}

/** Every session the replacement `handoffId` authorized to continue. */
export function plannedContinuationsFor(reader: AsyncEventStateReadSurface, handoffId: string): Promise<readonly PlannedSessionContinuation[]> {
  return plannedContinuationsWhere(reader, (continuation): continuation is PlannedSessionContinuation => continuation.handoffId === handoffId)
}

/** The row of a capacity wait, which names the time it continues at. */
export type CapacityWaitRow = PlannedSessionContinuation & { readonly continuesAt: number }

/** Every capacity wait's row of the project, or of `only` those sessions. */
export function capacityContinuations(reader: Pick<AsyncEventStateReadSurface, "sessionsWithInFlight" | "readInFlight">, only?: readonly string[]): Promise<readonly CapacityWaitRow[]> {
  return plannedContinuationsWhere(reader, (continuation): continuation is CapacityWaitRow => continuation.handoffId === undefined && continuation.continuesAt !== undefined, only)
}

/** What the continuation readers read beside the row: the durable facts and
 *  the session metadata that names a chat's conversation. */
interface ContinuationEvidence {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly manager: Pick<SessionManager, "read"> & Partial<Pick<SessionManager, "updateLifecycleState">>
}

/** The run `runId` of the child `sessionId`, read from its run facts. */
async function childRun(reader: AsyncEventStateReadSurface, sessionId: string, runId: string | undefined): Promise<ChildSessionRun | undefined> {
  const history = installedChildSessionHistory()
  return (await history.readRuns(reader, sessionId)).find((candidate) => candidate.childRunId === runId)
}

/** The reached conversations of the work a continuation names. Workflow
 * attempts remain independent while their session shares one successor row. */
async function workConversations(input: ContinuationEvidence, continuation: PlannedSessionContinuation, address: WorkflowDeliveryAddress = WHOLE_WORKFLOW): Promise<readonly string[]> {
  if (continuation.target.kind === "subagent") {
    const id = (await childRun(input.projectionReader, continuation.target.sessionId, continuation.runId))?.conversationId
    return id === undefined ? [] : [id]
  }
  if (continuation.target.kind === "chat" || continuation.target.kind === "workflow-agent") {
    const session = await input.manager.read(continuation.target.sessionId)
    return session?.kind === continuation.target.kind ? [session.conversationId] : []
  }
  const queue = await loadQueueSnapshotFromReader(input.projectionReader, continuationTargetId(continuation.target)).catch((error: unknown) => {
    // A workflow whose attempt rows this build cannot read has no attempt to
    // continue: its Resume asks for a recovery message instead. So no
    // successor owes it a continuation, and the session still opens.
    if (!isSessionHistoryFailure(error)) throw error
    log.warn("planned continuation skipped: the workflow's attempt rows cannot be read", { workflowId: continuationTargetId(continuation.target) })
    return null
  })
  if (queue?.followUpConversationId !== undefined) return isTargeted(address) ? [] : [queue.followUpConversationId]
  return startedAgents(queue).filter(({ agent }) => addressReachesAgent(address.addressedTo, agent)).map(({ conversationId }) => conversationId)
}

async function waitingConversations(input: ContinuationEvidence, continuation: PlannedSessionContinuation, address?: WorkflowDeliveryAddress): Promise<readonly string[]> {
  const conversations = await workConversations(input, continuation, address)
  return (await Promise.all(conversations.map(async (id) => await readWaitsAtRuntimeInterrupt(input.projectionReader, id) ? id : undefined)))
    .filter((id): id is string => id !== undefined)
}

function isTargeted(address: WorkflowDeliveryAddress | undefined): boolean {
  return address !== undefined && !address.addressedTo.some(({ _tag }) => _tag === "workflow")
}

/** The conversation of the work `continuation` names while that work still
 *  waits where the runtime interrupted it for the replacement: its last turn
 *  end is the runtime's interrupt, and no Resume has continued it since
 *  (`waitsAtRuntimeInterrupt`). A row names only work that the replacement
 *  found running, so the runtime's interrupt that ended that work is the
 *  replacement's: the planned cut, which the cut and the stop both record,
 *  or an ordinary runtime interrupt, which still leaves the session owed.
 *  Work that ended any other way, such as a turn a person interrupted
 *  before or after the cut, a turn that answered after the cut, a turn
 *  whose process exited, or a turn that a resume already began, waits for
 *  nothing. */
export interface PlannedContinuationWork {
  readonly conversationId?: string
  readonly workflowId?: string
  readonly operations: readonly {
    readonly operation: RetainedOperationContinuation
    readonly target: RetainedOperationContinuationTarget
  }[]
}

async function waitingConversation(input: ContinuationEvidence, continuation: PlannedSessionContinuation): Promise<PlannedContinuationWork | undefined> {
  const operations = (await Promise.all((continuation.operations ?? []).map(async (operation) => {
    const owner = retainedOperationContinuations().find((candidate) => candidate.kind === operation.kind)
    const target = owner ? await owner.resolve({ reader: input.projectionReader, manager: input.manager, operation }) : null
    return target ? { operation, target } : null
  }))).filter((work): work is PlannedContinuationWork["operations"][number] => work !== null)
  if (operations.length > 0) return { operations }
  if (continuation.target.kind === "subagent") {
    const conversationId = (await waitingChildRun(input, continuation))?.conversationId
    return conversationId ? { conversationId, operations: [] } : undefined
  }
  const conversationId = (await waitingConversations(input, continuation))[0]
  if (conversationId === undefined && continuation.target.kind === "workflow") {
    const queue = await loadQueueSnapshotFromReader(input.projectionReader, continuation.target.workflowId)
    if (queue && (queue.status === "idle" || queue.status === "running") && startedAgents(queue).length === 0) return { workflowId: continuation.target.workflowId, operations: [] }
  }
  return conversationId !== undefined
    ? { conversationId, operations: [] }
    : undefined
}

/** The child run a `subagent` row names while it waits where the runtime
 *  interrupted it (`waitingConversation`). It waits only while it is
 *  paused, because a Resume of a child records the resumed run first. */
async function waitingChildRun(input: Pick<ContinuationEvidence, "reader" | "projectionReader">, continuation: PlannedSessionContinuation): Promise<ChildSessionRun | undefined> {
  const run = await childRun(input.projectionReader, continuationTargetId(continuation.target), continuation.runId)
  return run?.status === "paused" && run.conversationId !== undefined && await readWaitsAtRuntimeInterrupt(input.projectionReader, run.conversationId) ? run : undefined
}

/** The successor's resume of one session while that resume waits in, or
 *  runs in, the session's continuation lane: `pending` until its step
 *  dispatches it, `withdrawn` once a person's interrupt arrived first, so
 *  that it is never dispatched, and `dispatched` once it was. */
interface LaneResume {
  state: "pending" | "withdrawn" | "dispatched"
}

/** One session's continuation lane. */
interface ContinuationLane {
  /** Settles once every step queued in the lane so far has settled. */
  tail: Promise<void>
  /** The steps queued in the lane and not settled; the lane ends at zero. */
  steps: number
  /** The successor's resumes queued in the lane and not settled. */
  readonly resumes: Set<LaneResume>
}

/** The continuation lanes of one executor, one for each session a step is
 *  queued for. The steps that decide a session's planned continuation take
 *  turns in its lane, so none acts on a turn end that another is about to
 *  change: each step of a planned replacement's cut of the session, the
 *  cut's own and the stop's, the successor's resume of it, and the one
 *  Interrupt of it by a person or the parent agent, whether the session is
 *  a chat, a workflow, or a child.
 *  The executor's composition creates the one registry and passes it to
 *  each owner of such a step: the runtime supervisor, the subagents
 *  module's controls, and the successor's continuation. A lane orders work
 *  and holds nothing any surface reads: whether a session is owed its
 *  continuation is read from its row and its conversation, in every
 *  process. */
export interface ContinuationLanes {
  /** Runs `step` in the session's lane, once every earlier step there has
   *  settled. Each step of a planned replacement's cut of the session runs
   *  here, the cut's own and the stop's: its continuation row, the
   *  runtime's interrupt, and the wait until the cut turn has settled and
   *  its turn end is durable. An interrupt that arrives meanwhile waits for
   *  the step, so it never races the cut's own interrupt: it then finds the
   *  turn the cut ended, at rest, and records its own turn end over it. A second step of the cut for the same session waits too,
   *  and then finds that turn ended. */
  run<T>(sessionId: string, step: () => Promise<T>): Promise<T>
  /** Whether a step runs or waits in the session's lane now. */
  busy(sessionId: string): boolean
  /** Runs `step`, the successor's resume of `sessionId`, in the session's
   *  lane. The step calls `mayDispatch` at once before it dispatches the
   *  resume. It answers false when an interrupt of the session arrived
   *  first: the interrupt wins, the step dispatches nothing, and the
   *  interrupt, next in the lane, records its turn end over the cut and
   *  retires the row. Once it has answered true,
   *  an interrupt waits until the step has ended, and the resume it
   *  dispatched is then a running turn, or one about to open, which the
   *  ordinary interrupt cuts. */
  resume<T>(sessionId: string, step: (mayDispatch: () => boolean) => Promise<T>): Promise<T>
  /** The one Interrupt of one session, by a person or the parent agent
   *  (`interruptInLane`). */
  interrupt(input: SessionInterrupt): Promise<boolean>
}

/** Creates one executor's continuation lanes. An interrupt waits for its
 *  turn in a lane for at most `interruptWaitLimitMs`, the cut limit unless
 *  a caller sets another. */
export function createContinuationLanes(options: { readonly interruptWaitLimitMs?: number } = {}): ContinuationLanes {
  const interruptWaitLimitMs = options.interruptWaitLimitMs ?? PLANNED_CUT_LIMIT_MS
  const lanes = new Map<string, ContinuationLane>()
  const laneOf = (sessionId: string): ContinuationLane => {
    const lane = lanes.get(sessionId) ?? { tail: Promise.resolve(), steps: 0, resumes: new Set() }
    lanes.set(sessionId, lane)
    return lane
  }
  const run = <T,>(sessionId: string, step: () => Promise<T>): Promise<T> => {
    const lane = laneOf(sessionId)
    const before = lane.tail
    const settled = Promise.withResolvers<void>()
    lane.tail = before.then(() => settled.promise)
    lane.steps += 1
    return before.then(step).finally(() => {
      settled.resolve()
      lane.steps -= 1
      if (lane.steps === 0 && lanes.get(sessionId) === lane) lanes.delete(sessionId)
    })
  }
  const resume = <T,>(sessionId: string, step: (mayDispatch: () => boolean) => Promise<T>): Promise<T> => {
    const entry: LaneResume = { state: "pending" }
    const { resumes } = laneOf(sessionId)
    resumes.add(entry)
    return run(sessionId, async () => {
      try {
        return await step(() => {
          if (entry.state === "withdrawn") return false
          entry.state = "dispatched"
          return true
        })
      } finally {
        resumes.delete(entry)
      }
    })
  }
  const interrupt = (input: SessionInterrupt): Promise<boolean> => interruptInLane(input, { lane: lanes.get(input.sessionId), run, waitLimitMs: interruptWaitLimitMs })
  return { run, busy: (sessionId) => lanes.has(sessionId), resume, interrupt }
}

/** The session's continuation row of a handoff. */
async function handoffContinuation(reader: AsyncEventStateReadSurface, sessionId: string): Promise<PlannedSessionContinuation | undefined> {
  const rows = decodedContinuations(await reader.readInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND), sessionId)
  return rows.find((stored) => stored.continuation.handoffId !== undefined)?.continuation
}

/** The conversation of `sessionId` whose turn a successor will continue,
 *  or nothing when no successor will: the session holds the continuation
 *  row of a handoff, and its work still waits where the runtime interrupted
 *  it (`waitingConversation`). The row stays until the successor's resume
 *  settles, so every process that reads the store answers the same, the
 *  account's history included. */
export async function plannedContinuationWork(input: ContinuationEvidence, sessionId: string): Promise<PlannedContinuationWork | undefined> {
  const continuation = await handoffContinuation(input.projectionReader, sessionId)
  return continuation === undefined ? undefined : await waitingConversation(input, continuation)
}

/** Whether a successor will continue `sessionId`, or is continuing it now,
 *  or its agent waits for model capacity: until that continuation settles
 *  every surface shows the session working and offers its Interrupt, never
 *  its Resume, across an unexpected exit too (PI-REMOTE-012, PI-MODEL-039, PI-MODEL-063). */
export async function awaitsPlannedContinuation(input: ContinuationEvidence, sessionId: string): Promise<boolean> {
  return await plannedContinuationWork(input, sessionId) !== undefined
    || (await capacityContinuations(input.projectionReader, [sessionId])).length > 0
}

/** Module-owned work accepted in a chat but not yet past its deterministic
 * publication-to-dispatch safe point. */
export async function pendingRetainedOperationContinuations(
  input: ContinuationEvidence & { readonly sessionId: string; readonly conversationId: string },
): Promise<readonly RetainedOperationContinuation[]> {
  const operations = await Promise.all(retainedOperationContinuations().map((owner) => owner.pending({
    reader: input.projectionReader,
    manager: input.manager,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
  })))
  return operations.flat()
}

async function withdrawRetainedOperations(input: ContinuationEvidence & { readonly writer: AsyncEventWriter }, operations: readonly RetainedOperationContinuation[]): Promise<void> {
  await Promise.all(operations.map(async (operation) => {
    const owner = retainedOperationContinuations().find((candidate) => candidate.kind === operation.kind)
    await owner?.withdraw({ reader: input.projectionReader, writer: input.writer, manager: input.manager, operation })
  }))
}

/** A live runner that holds a session's conversation. */
interface PlannedCutOwner {
  /** Records the turn end that names `by` over the planned cut through the
   *  runner's own conversation writer and shows it as an ordinary interrupt
   *  by `by` shows, or answers why it did not (`PlannedCutInterrupt`). */
  interruptPlannedCut(by: ControlInterruption, address?: WorkflowDeliveryAddress): Promise<PlannedCutInterrupt>
}

/** What the one Interrupt of one session reads and runs. */
interface SessionInterrupt extends ContinuationEvidence {
  readonly writer: AsyncEventWriter
  readonly sessionId: string
  /** Who interrupts: a person, or the parent agent of a child. Every rule
   *  here decides alike for both. */
  readonly by: ControlInterruption
  /** Resolved workflow coverage. A whole-workflow address has the same
   * successor-withdrawal semantics as an absent address. */
  readonly address?: WorkflowDeliveryAddress
  /** Whether a turn of the session runs in this process now. */
  readonly runs: () => boolean
  /** The ordinary interrupt, which cuts what runs of the session. */
  readonly interrupt: () => boolean | Promise<boolean>
  /** The live runner that holds the session's conversation, if one does. */
  readonly owner?: () => PlannedCutOwner | undefined
}

/** The session's lane as an interrupt enters it. */
interface InterruptLane {
  /** The session's lane, when a step runs or waits in it. */
  readonly lane: ContinuationLane | undefined
  readonly run: ContinuationLanes["run"]
  /** How long the interrupt waits for its turn in the lane. */
  readonly waitLimitMs: number
}

/** The one Interrupt of one session, by a person (Escape, or any surface's
 *  control) or by the parent agent of a child (its `process` tool). The
 *  rules below decide alike for both, and the turn end each records names
 *  who interrupted.
 *  A session whose turn runs while its continuation lane holds no step takes
 *  the ordinary interrupt at once. A session that no replacement touches
 *  takes it in its turn in the lane, once the read there finds nothing owed. A
 *  session at rest that a successor owes its continuation has nothing
 *  running to cut: the runtime's planned cut ended its turn, and the
 *  successor would resume it. Its interrupt records the person's turn end
 *  over the cut instead, through the live runner's writer or, with no runner
 *  live or one that has ended, through the conversation's writer, and then
 *  retires the session's row for a whole-session interrupt, so no successor
 *  resumes it, and every surface shows it interrupted by the person, with
 *  its Resume (PI-REMOTE-012, PI-REMOTE-020). While a step of the lane is in flight, the
 *  interrupt takes its turn after it. After a step of the cut, the cut's own
 *  or the stop's, the interrupt finds the cut turn at rest and records the
 *  person's turn end over it: an ordinary interrupt during the cut would
 *  reach a turn that the cut already aborted, which never parks to record
 *  it. A targeted workflow interrupt preserves the successor row and pending
 *  resume, so siblings can continue. A whole interrupt wins over every resume that
 *  the successor has not dispatched yet, and that resume's step then
 *  dispatches nothing. A resume already dispatched is a running turn once it
 *  settles, which the ordinary interrupt cuts. The wait for its turn is
 *  bounded by the cut limit (`interruptPastLane`). Answers whether anything
 *  was interrupted. */
async function interruptInLane(input: SessionInterrupt, { lane, run, waitLimitMs }: InterruptLane): Promise<boolean> {
  const { sessionId } = input
  if (lane === undefined && input.runs()) return await input.interrupt()
  // Decided in the tick the interrupt arrives, before it waits in the lane:
  // a resume's step reads its state at once before it dispatches, so a
  // resume withdrawn here is never dispatched. The interrupt enters the lane
  // in this same tick, so a resume that arrives later queues behind it. Any
  // read here would let such a resume pass it. The interrupt reads the row
  // and the work in its turn (`interruptInTurn`), and takes the ordinary
  // interrupt when nothing is owed.
  let withdrew = false
  for (const resume of isTargeted(input.address) ? [] : lane?.resumes ?? []) {
    if (resume.state !== "pending") continue
    resume.state = "withdrawn"
    withdrew = true
  }
  if (lane !== undefined) log.info("an interrupt waits for its turn in the session's continuation lane", { sessionId, by: input.by, turnRuns: input.runs(), withdrewResume: withdrew })
  // Which of the two ends the wait, the interrupt's turn or the cut limit,
  // is decided once: a turn that comes after the limit does nothing.
  let turn: "waiting" | "taken" | "passed" = "waiting"
  const limit = Promise.withResolvers<"passed">()
  const timer = setTimeout(() => {
    if (turn !== "waiting") return
    turn = "passed"
    limit.resolve("passed")
  }, waitLimitMs)
  const inTurn = run(sessionId, async () => {
    if (turn === "passed") return true
    turn = "taken"
    return await interruptInTurn(input, withdrew)
  })
  try {
    const outcome = await Promise.race([inTurn, limit.promise])
    if (outcome !== "passed") return outcome
  } finally {
    clearTimeout(timer)
  }
  return await interruptPastLane(input)
}

/** An interrupt in its turn in the session's continuation lane. */
async function interruptInTurn(input: SessionInterrupt, withdrew: boolean): Promise<boolean> {
  const { sessionId } = input
  // A resume this interrupt withdrew leaves its row for the interrupt to
  // retire, whatever the interrupt finds, so the row never outlives the
  // continuation it no longer authorizes.
  let consumed = withdrew
  try {
    const work = input.runs() ? undefined : await plannedContinuationWork(input, sessionId)
    if (work === undefined) return await input.interrupt()
    if (work.operations.length > 0 && !isTargeted(input.address)) {
      await withdrawRetainedOperations(input, work.operations.map(({ operation }) => operation))
      consumed = true
    }
    if (work.conversationId === undefined) return !isTargeted(input.address)
    const owner = input.owner?.()
    const answer = owner === undefined ? "ended" : await owner.interruptPlannedCut(input.by, input.address)
    if (answer === "running") return await input.interrupt()
    if (answer === "ended") {
      const continuation = await handoffContinuation(input.projectionReader, sessionId)
      const conversations = continuation === undefined ? [] : await waitingConversations(input, continuation, input.address)
      for (const id of conversations) {
        await recordInterrupt(input, input.by, sessionId, id)
      }
      if (conversations.length === 0) return false
    }
    consumed = true
    return true
  } finally {
    if (consumed && !isTargeted(input.address)) await retirePlannedSessionContinuation({ reader: input.projectionReader, writer: input.writer, sessionId })
  }
}

/** An interrupt whose turn in the session's continuation lane has
 *  not come within the cut limit, because a step ahead of it still runs: a
 *  cut whose turn never settles, or a resume whose dispatch takes that long.
 *  The person's intent still wins, and the person's turn end is the last
 *  one, recorded by the writer that holds the conversation. A live chat or
 *  workflow runner whose turn the runtime cut records it through its own
 *  writer (`PlannedCutInterrupt`). A turn that runs and that no cut ended,
 *  such as the one a slow resume opened, takes the ordinary interrupt, and
 *  its runner records it when it parks. Only when no runner takes it is it
 *  recorded at the tail of the session's work conversation through the
 *  conversation's writer. A whole interrupt retires the session's row, so no
 *  successor resumes the session, and its turn in the lane, when it comes,
 *  does nothing. A session that holds no row of a handoff owes nothing, so
 *  it takes the ordinary interrupt. */
async function interruptPastLane(input: SessionInterrupt): Promise<boolean> {
  const { sessionId } = input
  const continuation = await handoffContinuation(input.projectionReader, sessionId)
  log.info("an interrupt passed the cut limit in the session's continuation lane; it acts without its turn", { sessionId, by: input.by, owed: continuation !== undefined })
  if (continuation === undefined) return await input.interrupt()
  try {
    const work = await waitingConversation(input, continuation)
    if (work?.operations.length && !isTargeted(input.address)) {
      await withdrawRetainedOperations(input, work.operations.map(({ operation }) => operation))
      if (work.conversationId === undefined) return true
    }
    const owner = input.owner?.()
    const answer = owner === undefined ? undefined : await owner.interruptPlannedCut(input.by, input.address)
    if (answer === "recorded") return true
    const cutsTurn = answer === "running" || (answer === undefined && input.runs())
    if (cutsTurn && await input.interrupt()) return true
    const conversations = await waitingConversations(input, continuation, input.address)
    for (const conversationId of conversations) await recordInterrupt(input, input.by, sessionId, conversationId)
    return conversations.length > 0
  } finally {
    if (!isTargeted(input.address)) await retirePlannedSessionContinuation({ reader: input.projectionReader, writer: input.writer, sessionId })
  }
}

/** A person's interrupt of `sessionId` that no executor serves, such as one
 *  the account answers while the successor's executor recovers from an exit
 *  with no restart scheduled, so no lane or runner of the session exists.
 *  Nothing runs to cut. When a successor owes the session its continuation,
 *  the person's turn end is recorded over the planned cut through the
 *  conversation's writer and the session's row is retired, so the next
 *  executor resumes nothing. A session whose agent waits for model capacity
 *  is owed its continuation alike: the person's turn end is recorded at the
 *  tail of the agent's conversation, and the capacity row is retired, so no
 *  wake continues it (PI-MODEL-063). Answers whether it recorded one. */
export async function recordOwedPersonInterrupt(input: ContinuationEvidence & { readonly writer: AsyncEventWriter; readonly sessionId: string }): Promise<boolean> {
  const { writer, sessionId } = input
  const work = await plannedContinuationWork(input, sessionId)
  if (work === undefined) return await recordCapacityPersonInterrupt(input)
  try {
    if (work.operations.length > 0) await withdrawRetainedOperations(input, work.operations.map(({ operation }) => operation))
    if (work.conversationId !== undefined) {
      const continuation = await handoffContinuation(input.projectionReader, sessionId)
      for (const id of continuation === undefined ? [] : await waitingConversations(input, continuation)) {
        await recordInterrupt(input, "person", sessionId, id)
      }
    }
  } finally {
    await retirePlannedSessionContinuation({ reader: input.projectionReader, writer, sessionId })
  }
  log.info("a person's interrupt of a session no executor holds is recorded over the planned cut", { sessionId })
  return true
}

/** The capacity half of `recordOwedPersonInterrupt`. The interrupt of a
 *  workflow ends the capacity wait of each of its agents. */
async function recordCapacityPersonInterrupt(input: ContinuationEvidence & { readonly writer: AsyncEventWriter; readonly sessionId: string }): Promise<boolean> {
  const session = await input.manager.read(input.sessionId)
  const waits = session?.kind === "workflow"
    ? await capacityContinuationsOfWorkflow(input, input.sessionId)
    : (await capacityContinuations(input.projectionReader, [input.sessionId]))
  for (const continuation of waits) {
    const sessionId = continuationTargetId(continuation.target)
    try {
      for (const id of await workConversations(input, continuation)) await recordInterrupt(input, "person", sessionId, id)
    } finally {
      await retirePlannedSessionContinuation({ reader: input.projectionReader, writer: input.writer, sessionId, capacity: true })
    }
    log.info("a person's interrupt of a session no executor holds ends its capacity wait", { sessionId })
  }
  return waits.length > 0
}

/** The capacity rows of the agents of `workflowId`. */
async function capacityContinuationsOfWorkflow(input: ContinuationEvidence, workflowId: string): Promise<readonly PlannedSessionContinuation[]> {
  const agents = await Promise.all((await capacityContinuations(input.projectionReader)).map(async (continuation) => {
    if (continuation.target.kind !== "workflow-agent") return []
    const agent = await input.manager.read(continuation.target.sessionId)
    return agent?.kind === "workflow-agent" && agent.workflowMembership.workflowId === workflowId ? [continuation] : []
  }))
  return agents.flat()
}

/** Records the turn end of an interrupt by `by` at the tail of `conversationId` through the
 *  one conversation writer, which decides its text: where no live runner
 *  records it, because none holds the conversation or the one that held it
 *  has ended. The runtime records an ordinary stop this way when the
 *  successor of a planned cut could not attach the session it cut. */
export async function recordInterrupt(input: Pick<SessionInterrupt, "projectionReader" | "writer">, by: PausedBy, sessionId: string, conversationId: string): Promise<void> {
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: input.projectionReader, writer: input.writer })
  if (tree === null) throw new Error(`Conversation ${conversationId} has no tree to record the interrupt in`)
  try {
    await createConversationTreeWriter({ tree }).commitTurnEnd(by)
  } finally {
    tree.getStorage().dispose()
  }
}

/** Records that replacement `handoffId` authorizes this session to continue,
 *  replacing any row the session held before. Written before the runtime
 *  interrupts the session, so a crash between the two leaves the session
 *  resumable rather than lost. */
export async function authorizePlannedSessionContinuation(input: {
  readonly reader: Pick<AsyncEventStateReadSurface, "readInFlight">
  readonly writer: AsyncEventWriter
  readonly continuation: Omit<PlannedSessionContinuation, "version">
}): Promise<void> {
  const { reader, writer, continuation } = input
  if (!writer.putInFlight || !writer.dropInFlight) throw new Error("Planned continuation requires durable in-flight storage")
  const sessionId = continuationTargetId(continuation.target)
  for (const row of await reader.readInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND)) {
    if (row.key !== sessionId) await writer.dropInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, row.key)
  }
  const stored = Schema.decodeUnknownSync(PlannedContinuationSchema, { onExcessProperty: "error" })({ version: 3, ...continuation })
  await writer.putInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, sessionId, stored)
}

/** Retires the session's continuation authority, or with `handoffId` only
 *  the row of that handoff, or with `capacity` only a capacity wait's row,
 *  and reports whether this caller retired any. Each retirement is a
 *  compare-and-swap on the row it read, so a row that changed meanwhile,
 *  such as one a later replacement wrote, is left as it is. */
export async function retirePlannedSessionContinuation(input: {
  readonly reader: Pick<AsyncEventStateReadSurface, "readInFlight">
  readonly writer: AsyncEventWriter
  readonly sessionId: string
  readonly handoffId?: string
  readonly capacity?: true
}): Promise<boolean> {
  const { reader, writer, sessionId } = input
  if (!writer.swapInFlight) throw new Error("Planned continuation requires guarded in-flight retirement")
  let retired = false
  for (const { row, continuation } of decodedContinuations(await reader.readInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND), sessionId)) {
    if (input.handoffId !== undefined && continuation.handoffId !== input.handoffId) continue
    if (input.capacity && (continuation.handoffId !== undefined || continuation.continuesAt === undefined)) continue
    if (await writer.swapInFlight(sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, row.key, row.raw, null)) retired = true
  }
  if (retired) for (const listener of retirementListeners.get(reader) ?? []) listener(sessionId)
  return retired
}

/** The listeners of each project's retirements, by the reader that the
 *  retirement reads its rows through. */
const retirementListeners = new WeakMap<object, Set<(sessionId: string) => void>>()

/** Calls `listener` with the session each time a continuation row of the
 *  project that `reader` reads retires. A retirement writes no fact: a
 *  refused resume leaves committed control as the cut left it, so a reader
 *  that presents an owed session as running (`awaitsPlannedContinuation`)
 *  reads it again only after this call. */
export function onPlannedContinuationRetired(reader: Pick<AsyncEventStateReadSurface, "readInFlight">, listener: (sessionId: string) => void): () => void {
  const listeners = retirementListeners.get(reader) ?? new Set<(sessionId: string) => void>()
  retirementListeners.set(reader, listeners)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Prepares a person's Resume of a child that still holds continuation
 *  authority for its current run: the resumed-run fact and the retirement of
 *  the row, for a caller-owned atomic activation batch. Null when the row
 *  does not authorize this run. */
export async function preparePlannedSessionContinuationConsumption(input: {
  readonly reader: AsyncEventStateReadSurface
  readonly sessionId: string
  readonly runId: string
}): Promise<EventStoreAppend | null> {
  const stored = decodedContinuations(
    await input.reader.readInFlight(input.sessionId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND),
    input.sessionId,
  )
  if (stored.length > 1) throw new Error(`Session ${input.sessionId} has multiple planned continuation authorizations`)
  const authority = stored[0]
  if (!authority || authority.continuation.target.kind !== "subagent" || authority.continuation.runId !== input.runId) return null
  const history = installedChildSessionHistory()
  const run = await childRun(input.reader, input.sessionId, input.runId)
  // The runtime authorizes a run while it runs and then interrupts it, which
  // saves it as paused; an exit between the two leaves it created.
  if (!run || (run.status !== "created" && run.status !== "paused")) return null
  return {
    ...history.prepareResumed(input.sessionId, {
      childRunId: input.runId,
      authorizationId: `planned:${authority.continuation.handoffId ?? authority.row.key}`,
      continuation: (run.continuationCount ?? 0) + 1,
    }),
    inFlight: [{ op: "drop", kind: PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, key: authority.row.key }],
  }
}

/** A planned replacement's step for one running child: its continuation
 *  row for `handoffId`, then the runtime's interrupt at its save point. The
 *  cut runs it, in the child's continuation lane, for every child it finds
 *  running, and the stop of an executor whose cut has begun runs it for
 *  every running child whose lane holds no step and whose row does not name
 *  the run it runs now. */
export async function interruptChildForReplacement(input: {
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly control: LiveChildControl
  readonly handoffId: string
}): Promise<void> {
  const { control } = input
  await authorizePlannedSessionContinuation({ reader: input.projectionReader, writer: input.writer, continuation: {
    target: { sessionId: control.sessionId, kind: "subagent" },
    handoffId: input.handoffId,
    runId: control.child.runId,
  } })
  await control.child.interrupt("replacement")
}

/** How long a step re-entered after a planned replacement waits for its
 *  children. The successor resumes them as soon as the step has assembled
 *  the runtime they run under, so the bound only covers a resume the
 *  successor never makes, which leaves the child interrupted for a person. */
const PLANNED_CHILD_RESUME_WAIT_MS = 10_000

/** Waits, before a step's first request, until each child its conversation
 *  dispatched that a successor owes its continuation runs again (ARCH-SESSIONS-039):
 *  the child holds a row of a handoff, and the run the row names waits where
 *  the runtime interrupted it (`waitingChildRun`). The successor resumes
 *  such a child through the step's own module runtimes, so the child cannot
 *  resume before the step re-enters; this wait keeps the step's first
 *  request from running before the child it waits on. The step reads the
 *  parent's children from its session metadata. When the parent aggregate
 *  holds a corrupt row, the recovery fold supplies the children, so the step
 *  waits on the children it can still read and does not fail. A deleted
 *  parent, or a parent whose creation fact is unreadable, has no children to
 *  wait on. A link fact that the fold cannot decode adds no child. */
export async function awaitPlannedChildResumes(input: {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly parentSessionId: string
  readonly parentConversationId: string
}): Promise<void> {
  const { reader, projectionReader, parentSessionId, parentConversationId } = input
  const parent = await readSessionMetadata(projectionReader, parentSessionId)
  const interrupted: string[] = []
  for (const childSessionId of parent?.childSessionIds ?? []) {
    const continuation = await handoffContinuation(projectionReader, childSessionId)
    if (continuation?.target.kind === "subagent" && (await waitingChildRun(input, continuation))?.parentConversationId === parentConversationId) interrupted.push(childSessionId)
  }
  if (interrupted.length === 0) return
  const waits = interrupted.map((childSessionId) => whenLiveChildRun(reader, childSessionId))
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), PLANNED_CHILD_RESUME_WAIT_MS) })
  try {
    const outcome = await Promise.race([Promise.all(waits.map((wait) => wait.active)), bound])
    if (outcome === "timeout") log.warn("a child the replacement interrupted was not resumed; the step continues without it", { parentSessionId, parentConversationId })
  } finally {
    clearTimeout(timer)
    for (const wait of waits) wait.cancel()
  }
}

/** Reads one stored row as the current shape. A version 1 row is a child
 *  authorized at an ordinary shutdown, which no build writes now; it
 *  converts to a version 2 row with no handoff, which a person's Resume
 *  consumes and no successor resumes automatically. Conversion added
 *  2026-09-22; remove it after 2027-03-22. A row of an unknown version or
 *  shape is reported and treated as absent, never dropped. */
export function decodePlannedSessionContinuation(row: InFlightRecord, sessionId: string): PlannedSessionContinuation | undefined {
  const value = row.payload
  if (value.version === 3) {
    const decoded = Schema.decodeUnknownResult(PlannedContinuationSchema, { onExcessProperty: "error" })(value)
    if (Result.isSuccess(decoded) && continuationTargetId(decoded.success.target) === sessionId && row.key === sessionId) return decoded.success
  }
  if (value.version === 1) {
    if (value.sessionId === sessionId && row.key === value.runId && typeof value.runId === "string") {
      return { version: 3, target: { sessionId, kind: "subagent" }, runId: value.runId }
    }
  } else if (value.version === 2) {
    const kind = KINDS.find((candidate) => candidate === value.kind)
    const operations = value.operations === undefined
      ? undefined
      : Array.isArray(value.operations)
        ? value.operations.map(decodeRetainedOperationContinuation)
        : [undefined]
    const known = Object.keys(value).every((key) => key === "version" || key === "sessionId" || key === "kind" || key === "handoffId" || key === "runId" || key === "operations")
    if (
      known && kind && value.sessionId === sessionId && row.key === sessionId
      && (value.handoffId === undefined || (typeof value.handoffId === "string" && value.handoffId.length > 0))
      && (kind === "subagent" ? typeof value.runId === "string" && value.runId.length > 0 : value.runId === undefined)
      && (operations === undefined || operations.every((operation) => operation !== undefined))
    ) {
      return {
        version: 3,
        target: kind === "workflow" ? { kind, workflowId: sessionId } : { kind, sessionId },
        ...(typeof value.handoffId === "string" ? { handoffId: value.handoffId } : {}),
        ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
        ...(operations && operations.length > 0
          ? { operations: operations.filter((operation): operation is RetainedOperationContinuation => operation !== undefined) }
          : {}),
      }
    }
  }
  log.warn("planned continuation row has a shape this release cannot read; it is left in place", { sessionId, key: row.key, version: String(value.version) })
  return undefined
}

/** One retained operation a planned continuation names. Its module supplies
 *  the kind of session the operation continues. */
const RetainedOperationContinuationSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  ownerSessionId: Schema.NonEmptyString,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("workflow"), workflowId: Schema.NonEmptyString }),
    Schema.Struct({ kind: Schema.Literals(["chat", "subagent"]), sessionId: Schema.NonEmptyString }),
  ]),
  bindingId: Schema.NonEmptyString,
}) satisfies Schema.Codec<RetainedOperationContinuation>
const decodeOperation = Schema.decodeUnknownResult(RetainedOperationContinuationSchema, { onExcessProperty: "error" })
const PlannedContinuationSchema = Schema.Struct({
  version: Schema.Literal(3),
  target: Schema.Union([...RetainedOperationContinuationSchema.fields.target.members, Schema.Struct({ kind: Schema.Literal("workflow-agent"), sessionId: Schema.NonEmptyString })]),
  handoffId: Schema.optionalKey(Schema.NonEmptyString),
  runId: Schema.optionalKey(Schema.NonEmptyString),
  operations: Schema.optionalKey(Schema.Array(RetainedOperationContinuationSchema)),
  continuesAt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})

function decodeRetainedOperationContinuation(value: unknown): RetainedOperationContinuation | undefined {
  const decoded = decodeOperation(value)
  if (Result.isSuccess(decoded)) return decoded.success
  // Remove after 2027-10-17. Version 2 addressed workflow containers using
  // a session identifier. Current writers store an explicit work target.
  const previous = Schema.decodeUnknownResult(Schema.Struct({
    kind: Schema.NonEmptyString, key: Schema.NonEmptyString, ownerSessionId: Schema.NonEmptyString,
    targetSessionId: Schema.NonEmptyString, targetKind: Schema.Literals(["workflow", "chat", "subagent"]), bindingId: Schema.NonEmptyString,
  }), { onExcessProperty: "error" })(value)
  if (Result.isFailure(previous)) return undefined
  const { targetKind: kind, targetSessionId: id, ...rest } = previous.success
  return { ...rest, target: kind === "workflow" ? { kind, workflowId: id } : { kind, sessionId: id } }
}
