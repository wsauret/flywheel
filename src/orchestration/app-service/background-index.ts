/**
 * The background index of a session (PI-INTERACTION-037, PI-INTERACTION-093): its background commands and
 * every child it started, each child followed by the children that it
 * started. Each row is one call whose work continues in the background. A
 * workflow is one call, and interrupt and Stop act on the whole workflow,
 * so it is one row that states its progress and its agents have no rows. The rows come from durable facts, so the index is complete after
 * a restart and on a session whose transcript loads lazily. Only what facts
 * cannot know comes from this process: whether a command recorded as running
 * still runs, the model of a running child, and whether a running child waits
 * on its parent for a reply.
 */

import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { loggedOperation } from "../../infra/operation-log.js"
import { containSessionReads } from "../../infra/session-read-containment.js"
import type { BackgroundCommandRecord } from "../../infra/runtime-fact-types.js"
import type { BackgroundWorkProgress, BackgroundWorkRow, BackgroundWorkStatus } from "../../protocol/background-index-protocol-types.js"
import type { StoppedBy } from "../../protocol/app-service-types.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { ActiveBackgroundCommandView, ReplyWaitView } from "../../protocol/status-protocol-types.js"
import { workflowProgress } from "../../protocol/client/workflow-progress.js"
import { loadQueueSnapshotFromReader, readWorkflowStatees } from "../../workflows/view/view-store.js"
import { readBackgroundCommands } from "../session/background-index-projection.js"
import { readChildCall } from "../session/chat-session-run-evidence.js"
import { readChildSessionRunEvidence, type ChildSessionRunEvidence } from "../session/child-session-run-evidence.js"
import { keptCommandsOf } from "../session/command-handover.js"
import { installedChildSessionHistory } from "../session/module-session-operations.js"
import { onReplyWaitsChanged, readReplyWaitViews } from "../session/reply-waits.js"
import type { ReplayedSession } from "../session/schemas.js"
import type { SessionLifecycleState } from "../session/types.js"
import type { SessionStore } from "../session-store/types.js"
import { createBackgroundIndexPublisher } from "./background-index-publisher.js"
import { workflowPlacements, workflowRunReader } from "../module-catalog.js"
import { createSessionPlacements } from "../session/session-metadata-store.js"

const log = Log.create({ service: "background-index" })

/** A read this slow is a pause a person who opened the index notices. */
const SLOW_READ_MS = 250

export interface BackgroundIndexDeps {
  /** The project store, which holds the facts every row comes from. */
  readonly reader: AsyncEventStateReadSurface
  readonly readSession: (sessionId: string) => Promise<ReplayedSession | null | undefined>
  /** The running background work of a session that a runner here holds. */
  readonly liveCommands: (sessionId: string) => readonly ActiveBackgroundCommandView[]
  /** The sessions a session waits on for a reply now, from its stored waits. */
  readonly replyWaits: (sessionId: string) => Promise<readonly ReplyWaitView[]>
}

export interface BackgroundIndex {
  /** The rows of `sessionId`, in start order, each nested row
   *  after its parent row. A session that is gone has none. */
  rows(sessionId: string): Promise<readonly BackgroundWorkRow[]>
}

/** The background index of a runtime and its publication, over one project
 *  store: the live work comes from the runners `sessionStore` holds and the
 *  commands the executor's keeper holds, and the reply waits from the waits
 *  the sessions store. `dispose` ends the publication. */
export function composeBackgroundIndex(deps: {
  readonly reader: AsyncEventStateReadSurface
  readonly readSession: BackgroundIndexDeps["readSession"]
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => void
  readonly sessionStore: Pick<SessionStore, "onChange" | "get" | "allIds">
  readonly onKeptChange: (listener: (sessionId: string) => void) => () => void
}): BackgroundIndex & { dispose(): void } {
  const index = createBackgroundIndex({
    reader: deps.reader,
    readSession: deps.readSession,
    liveCommands: (sessionId) => deps.sessionStore.get(sessionId)?.activeBackgroundCommands ?? [],
    replyWaits: (sessionId) => readReplyWaitViews(deps.reader, async (id) => await deps.readSession(id) ?? null, sessionId),
  })
  const publisher = createBackgroundIndexPublisher({
    ...deps,
    workflowPlacements: workflowPlacements(deps.reader),
    sessionPlacements: createSessionPlacements(deps.reader),
    childRunFactTypes: installedChildSessionHistory().factTypes,
    onReplyWaitsChange: (listener) => onReplyWaitsChanged(deps.reader, listener),
  })
  return { rows: index.rows, dispose: publisher.dispose }
}

const ACTIVE: ReadonlySet<BackgroundWorkStatus> = new Set(["running", "waiting_on_parent"])
/** The statuses of a child whose newest run ended and records how long it ran. */
const FINISHED: ReadonlySet<BackgroundWorkStatus> = new Set(["completed", "partial", "failed", "stopped", "cancelled"])

/** The status of a child, and how long it ran once it finished. */
interface ChildOutcome {
  readonly status: BackgroundWorkStatus
  readonly durationMs?: number
}

/** A row and the rows nested under it, for the depth-first order. */
interface RowTree {
  readonly row: BackgroundWorkRow
  readonly children: readonly RowTree[]
}

export function createBackgroundIndex(deps: BackgroundIndexDeps): BackgroundIndex {
  const runs = workflowRunReader(deps.reader)
  // A child's unreadable run history does not hide its row or the chat's other work.
  const childReads = containSessionReads(log, "background index child read")
  async function commandRows(sessionId: string): Promise<RowTree[]> {
    const records = await readBackgroundCommands(deps.reader, sessionId)
    // A record that says running is true only while a host here or the
    // executor's keeper still holds the command. Otherwise the command
    // ended with no recorded outcome, as in a crash.
    const held = new Set([
      ...deps.liveCommands(sessionId).map((command) => command.toolUseId),
      ...(await keptCommandsOf(deps.reader, sessionId)).map((command) => command.toolUseId),
    ])
    return [...records.values()].map((record) => ({ row: commandRow(sessionId, record, held.has(record.toolUseId)), children: [] }))
  }

  async function childTrees(parent: ReplayedSession, parentId: string, card: string | undefined): Promise<RowTree[]> {
    const trees = await Promise.all((parent.childSessionIds ?? []).map(async (childId): Promise<RowTree | undefined> => {
      const child = await deps.readSession(childId)
      if (!child || child.kind !== "subagent") return undefined
      const toolUseId = child.launchedFrom?.toolUseId
      const cardToolUseId = card ?? toolUseId
      if (cardToolUseId === undefined) return undefined
      const { status, durationMs } = await childOutcome(childId, child, parentId)
      const live = toolUseId === undefined ? undefined : deps.liveCommands(parentId).find((command) => command.toolUseId === toolUseId)
      const row: BackgroundWorkRow = {
        id: childId,
        kind: child.kind,
        title: child.shortLabel ?? child.label,
        startedAtMs: startedAt(child),
        ...(card === undefined ? {} : { parentRowId: parentId }),
        cardToolUseId,
        target: { kind: "session", sessionId: childId },
        status,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(live?.model === undefined ? {} : { model: live.model }),
        ...(live?.effort === undefined ? {} : { effort: live.effort }),
        ...(live?.roleSessionId === undefined ? {} : { roleSessionId: live.roleSessionId }),
        ...(ACTIVE.has(status) && toolUseId !== undefined ? { stop: { sessionId: parentId, toolUseId } } : {}),
      }
      const commands = (await commandRows(childId)).map(tree => ({ ...tree, row: { ...tree.row, parentRowId: childId, cardToolUseId, target: { kind: "session" as const, sessionId: childId } } }))
      return { row, children: [...commands, ...await childTrees(child, childId, cardToolUseId)] }
    }))
    return trees.filter((tree): tree is RowTree => tree !== undefined)
  }

  async function childOutcome(childId: string, child: Extract<ReplayedSession, { kind: "subagent" }>, parentId: string): Promise<ChildOutcome> {
    const outcome = await subagentOutcome(childId, child.lifecycleState)
    return outcome.status === "running" && (await deps.replyWaits(childId)).some((wait) => wait.sessionId === parentId) ? { status: "waiting_on_parent" } : outcome
  }

  /** A finished subagent also states how long it ran: the time of each of
   *  its runs added together, as its card in the transcript counts it, so
   *  the wait between a run and its resume is not counted. */
  async function subagentOutcome(childId: string, lifecycleState: SessionLifecycleState): Promise<ChildOutcome> {
    return await childReads.read(childId, async () => {
      const status = subagentStatus(lifecycleState, await readChildSessionRunEvidence(deps.reader, childId))
      if (!FINISHED.has(status)) return { status }
      const durations = (await installedChildSessionHistory().readRuns(deps.reader, childId)).flatMap((run) => run.durationMs === undefined ? [] : [run.durationMs])
      return durations.length === 0 ? { status } : { status, durationMs: Math.round(durations.reduce((total, duration) => total + duration, 0)) }
    }, { status: subagentStatus(lifecycleState, { continuationAuthorized: false }) })
  }

  /** A workflow's progress from its queue, which its held projection keeps.
   *  A workflow whose queue is unreadable keeps its row without progress. */
  async function progressOf(workflowId: string): Promise<{ readonly progress?: BackgroundWorkProgress }> {
    return await childReads.read(workflowId, async () => {
      const queue = await loadQueueSnapshotFromReader(deps.reader, workflowId)
      if (queue === null) return {}
      const { done, total, failed, running } = workflowProgress({ attempts: [], tree: queue.tree })
      const active = [...new Set(queue.tree.nodes.flatMap((node) => node.kind === "agent" && node.disposition === "running" ? [node.label] : []))]
      return { progress: { done, total, failed, running, active } }
    }, {})
  }

  return {
    rows(sessionId) {
      return loggedOperation({ log, operation: "background index read", slowMs: SLOW_READ_MS, fields: { sessionId }, summarize: (rows) => ({ rows: rows.length }) }, async () => {
        const session = await deps.readSession(sessionId)
        if (!session) return []
        const [commands, children] = await Promise.all([commandRows(sessionId), childTrees(session, sessionId, undefined)])
        const workflows = await runs.listForParent(sessionId)
        const states = await readWorkflowStatees(workflows.map(run => run.workflowId), deps.reader)
        const workflowTrees = await Promise.all(workflows.map(async ({ workflowId, run }): Promise<RowTree> => {
          const status = workflowStatus({
            state: states.statuses.get(workflowId),
            stoppedBy: (await readChildCall(deps.reader, run.launchedFrom))?.stoppedBy,
          })
          return {
            row: {
              id: workflowId, kind: "workflow", title: run.shortLabel ?? run.label,
              startedAtMs: startedAt(run), cardToolUseId: run.launchedFrom.toolUseId,
              target: { kind: "workflow", workflowId }, status,
              ...await progressOf(workflowId),
              ...(ACTIVE.has(status) ? { stop: { sessionId, toolUseId: run.launchedFrom.toolUseId } } : {}),
            },
            children: [],
          }
        }))
        return flatten([...commands, ...children, ...workflowTrees])
      })
    },
  }
}

function commandRow(sessionId: string, record: BackgroundCommandRecord, held: boolean): BackgroundWorkRow {
  const base = { id: record.toolUseId, kind: "command" as const, title: record.description, startedAtMs: record.startedAtMs, cardToolUseId: record.toolUseId }
  if (record.state === "running") {
    return held ? { ...base, status: "running", stop: { sessionId, toolUseId: record.toolUseId } } : { ...base, status: "ended" }
  }
  return {
    ...base,
    status: record.status,
    durationMs: Math.max(0, record.settledAtMs - record.startedAtMs),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
  }
}

/** The status of a subagent from its newest run. A run that a person or the
 *  runtime cut, or one that no runner holds and no successor continues,
 *  reads as interrupted: it reads nothing until it resumes. */
function subagentStatus(lifecycleState: SessionLifecycleState, evidence: ChildSessionRunEvidence): BackgroundWorkStatus {
  const status = evidence.run?.status
  switch (status) {
    case "completed": case "partial": case "failed": case "stopped": case "cancelled": return status
    case "paused": case "interrupted": return "interrupted"
    case "created": case undefined: return lifecycleState === "active" || evidence.continuationAuthorized ? "running" : "interrupted"
  }
}

/** The status of a workflow. A Stop of its parent's call ends it whatever
 *  its own control says, as every reader of a stopped child reads it. */
function workflowStatus(input: { readonly state: string | undefined; readonly stoppedBy: StoppedBy | undefined }): BackgroundWorkStatus {
  if (input.stoppedBy !== undefined) return input.stoppedBy === "person" ? "stopped" : "cancelled"
  if (input.state === "completed" || input.state === "failed") return input.state
  if (input.state === "paused") return "interrupted"
  return input.state === "running" || input.state === "idle" ? "running" : "interrupted"
}

function startedAt(session: { readonly createdAt?: string }): number {
  const parsed = session.createdAt === undefined ? Number.NaN : Date.parse(session.createdAt)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

/** Start order at each level, each row followed by its own nested rows. */
function flatten(trees: readonly RowTree[]): BackgroundWorkRow[] {
  return [...trees]
    .sort((left, right) => left.row.startedAtMs - right.row.startedAtMs)
    .flatMap((tree) => [tree.row, ...flatten(tree.children)])
}
