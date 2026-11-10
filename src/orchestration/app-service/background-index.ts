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
 *
 * A tree builds the index of one root once, and then each update reads only
 * the rows of the part it names, so an owner that holds the tree advances it
 * per change (ARCH-SUBSTRATE-017). The full build and every update run the
 * same reads, so an advanced tree holds the rows that a fresh build reads.
 */

import { CorruptEventRowError, type AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { loggedOperation } from "../../infra/operation-log.js"
import { containSessionReads } from "../../infra/session-read-containment.js"
import type { BackgroundCommandRecord } from "../../infra/runtime-fact-types.js"
import type { BackgroundWorkProgress, BackgroundWorkRow, BackgroundWorkStatus } from "../../protocol/background-index-protocol-types.js"
import type { StoppedBy } from "../../protocol/app-service-types.js"
import type { ActiveBackgroundCommandView, ReplyWaitView } from "../../protocol/status-protocol-types.js"
import { workflowProgress } from "../../protocol/client/workflow-progress.js"
import { loadQueueSnapshotFromReader, readWorkflowStatees } from "../../workflows/view/view-store.js"
import { readBackgroundCommands } from "../session/background-index-projection.js"
import { childCallOf } from "../session/chat-session-run-evidence.js"
import { readChildSessionRunEvidence, type ChildSessionRunEvidence } from "../session/child-session-run-evidence.js"
import { keptCommandsOf } from "../session/command-handover.js"
import { installedChildSessionHistory } from "../session/module-session-operations.js"
import type { ReplayedSession } from "../session/schemas.js"
import { decodeSessionMetadataFactForReplay } from "../session/session-metadata-facts.js"
import { readToolExecutions } from "../session/tool-execution-projection.js"
import type { SessionLifecycleState } from "../session/types.js"
import type { WorkflowRunRecord } from "../workflow-host/run-record.js"
import { workflowRunReader } from "../module-catalog.js"

const log = Log.create({ service: "background-index" })

/** A build this slow is a pause a person who opened the index notices. */
const SLOW_BUILD_MS = 250

export interface BackgroundIndexDeps {
  /** The project store, which holds the facts every row comes from. */
  readonly reader: AsyncEventStateReadSurface
  readonly readSession: (sessionId: string) => Promise<ReplayedSession | null | undefined>
  /** The running background work of a session that a runner here holds. */
  readonly liveCommands: (sessionId: string) => readonly ActiveBackgroundCommandView[]
  /** The sessions a session waits on for a reply now, from its stored waits. */
  readonly replyWaits: (sessionId: string) => Promise<readonly ReplyWaitView[]>
}

/** One part of an index whose rows an update reads again. */
export type BackgroundIndexPart =
  /** The command rows of the root or of a subagent of the tree that
   *  `toolUseIds` names, and each row whose command a host or the keeper
   *  took up or let go since the last read. Every row without `toolUseIds`. */
  | { readonly kind: "commands"; readonly sessionId: string; readonly toolUseIds?: ReadonlySet<string> }
  /** The row of a subagent of the tree. */
  | { readonly kind: "child"; readonly sessionId: string }
  /** The children of the root or of a subagent of the tree: a new child
   *  adds its rows and every row under it, a removed one takes them away. */
  | { readonly kind: "children"; readonly sessionId: string }
  /** The row of a workflow of the root. */
  | { readonly kind: "workflow"; readonly workflowId: string }
  /** Which workflows the root launched. */
  | { readonly kind: "launches" }

/** How the rows of a tree change after its build. */
export interface BackgroundIndexSink {
  updated(row: BackgroundWorkRow): void
  removed(rowId: string): void
}

/** The place in the tree of the root or of one of its subagents. */
interface SessionPlace {
  /** The session that launched it; absent for the root. */
  readonly parentId?: string
  /** The call of the parent that launched it. */
  readonly toolUseId?: string
  /** The row its own row sits under, for a subagent under another subagent. */
  readonly parentRowId?: string
  /** The top-level card its rows land on; absent for the root. */
  readonly card?: string
  /** Every child id of the session that the tree considered. */
  readonly children: Set<string>
  /** The children with rows: its subagents. */
  readonly shown: Set<string>
  readonly commands: Set<string>
  /** The commands a host or the keeper held at the last read. */
  held: ReadonlySet<string>
}

/** A workflow of the root, with who stopped its launching call. */
interface Launch {
  readonly toolUseId: string
  stoppedBy: StoppedBy | undefined
}

interface LaunchedWorkflow {
  readonly workflowId: string
  readonly run: WorkflowRunRecord
}

/** The background index of one root, held in memory. */
export interface BackgroundIndexTree {
  readonly rows: ReadonlyMap<string, BackgroundWorkRow>
  /** Whether `sessionId` is the root (`root`) or a subagent of the tree
   *  (`child`). A child whose admission reads are out is a child already, so
   *  a change of it queues an update that runs once it is placed. */
  role(sessionId: string): "root" | "child" | undefined
  hasWorkflow(workflowId: string): boolean
  /** The root recorded a result of its call `toolUseId`: the tree holds who
   *  it says stopped the call, and returns the workflow the call launched,
   *  whose row an update then reads again. */
  callResult(toolUseId: string, stoppedBy: StoppedBy | undefined): string | undefined
  /** The subagents of `sessionId` that its calls `toolUseIds` launched. */
  childrenLaunchedBy(sessionId: string, toolUseIds: ReadonlySet<string>): string[]
  /** Reads every row. Tells the sink nothing. */
  build(): Promise<void>
  /** Reads the rows of `part` again and tells the sink each row that changed. */
  update(part: BackgroundIndexPart): Promise<void>
}

export interface BackgroundIndex {
  /** The rows of `sessionId` from a fresh build, in no stated order. A
   *  session that is gone has none. */
  rows(sessionId: string): Promise<readonly BackgroundWorkRow[]>
  /** The tree of `rootId`, not built yet, which tells `sink` each change. */
  tree(rootId: string, sink: BackgroundIndexSink): BackgroundIndexTree
}

const ACTIVE: ReadonlySet<BackgroundWorkStatus> = new Set(["running", "waiting_on_parent"])
/** The statuses of a child whose newest run ended and records how long it ran. */
const FINISHED: ReadonlySet<BackgroundWorkStatus> = new Set(["completed", "partial", "failed", "stopped", "cancelled"])

type SubagentSession = Extract<ReplayedSession, { kind: "subagent" }>

/** The status of a child, and how long it ran once it finished. */
interface ChildOutcome {
  readonly status: BackgroundWorkStatus
  readonly durationMs?: number
}

export function createBackgroundIndex(deps: BackgroundIndexDeps): BackgroundIndex {
  const runs = workflowRunReader(deps.reader)
  // A child's unreadable run history does not hide its row or the chat's other work.
  const childReads = containSessionReads(log, "background index child read")

  async function childOutcome(childId: string, child: SubagentSession, parentId: string): Promise<ChildOutcome> {
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

  /** The children that can be subagents. One read of the creation facts of
   *  every child spares a full read of each child of another kind; a child
   *  whose creation fact is missing or unreadable is read in full. */
  async function subagentCandidates(childIds: readonly string[]): Promise<string[]> {
    if (childIds.length === 0) return []
    const { facts } = await deps.reader.readSlice({ aggregateIds: childIds.map((id) => `session:${id}`), types: ["session.created"], limit: childIds.length }, true)
    const kinds = new Map(facts.flatMap((fact) => {
      if (fact instanceof CorruptEventRowError) return []
      const created = decodeSessionMetadataFactForReplay(fact, fact.timestamp)
      return created?.type === "session.created" ? [[fact.sessionId, created.payload.kind] as const] : []
    }))
    return childIds.filter((id) => (kinds.get(id) ?? "subagent") === "subagent")
  }

  function tree(rootId: string, sink: BackgroundIndexSink): BackgroundIndexTree {
    const rows = new Map<string, BackgroundWorkRow>()
    const places = new Map<string, SessionPlace>()
    // The children whose admission reads are out, which have no place yet.
    const admitting = new Set<string>()
    const launches = new Map<string, Launch>()
    const launchedByCall = new Map<string, string>()
    // The launching calls whose stop a read is out for, with the result the
    // root recorded meanwhile, which is newer than the read's answer.
    const callReads = new Map<string, { readonly stoppedBy: StoppedBy | undefined } | undefined>()
    let built = false

    function put(row: BackgroundWorkRow): void {
      const current = rows.get(row.id)
      if (current !== undefined && Bun.deepEquals(current, row, true)) return
      rows.set(row.id, row)
      if (built) sink.updated(row)
    }
    function remove(rowId: string): void {
      if (rows.delete(rowId) && built) sink.removed(rowId)
    }

    /** Reads the command rows of `sessionId` that `toolUseIds` names, or
     *  every row, and each row whose command became held or stopped being
     *  held, so a change visits only the rows it touches. */
    async function commands(sessionId: string, toolUseIds?: ReadonlySet<string>): Promise<void> {
      const place = places.get(sessionId)
      if (!place) return
      const records = await readBackgroundCommands(deps.reader, sessionId)
      // A record that says running is true only while a host here or the
      // executor's keeper still holds the command. Otherwise the command
      // ended with no recorded outcome, as in a crash.
      const held = new Set([
        ...deps.liveCommands(sessionId).map((command) => command.toolUseId),
        ...(await keptCommandsOf(deps.reader, sessionId)).map((command) => command.toolUseId),
      ])
      if (places.get(sessionId) !== place) return
      const touched = toolUseIds === undefined
        ? records.keys()
        : new Set([...toolUseIds, ...held.symmetricDifference(place.held)])
      place.held = held
      for (const toolUseId of touched) {
        const record = records.get(toolUseId)
        if (record === undefined) continue
        const row = commandRow(sessionId, record, held.has(toolUseId))
        place.commands.add(row.id)
        put(place.card === undefined ? row : { ...row, parentRowId: sessionId, cardToolUseId: place.card, target: { kind: "session", sessionId } })
      }
    }

    async function childRow(childId: string, child: SubagentSession, place: SessionPlace & { readonly parentId: string; readonly card: string }): Promise<BackgroundWorkRow> {
      const { status, durationMs } = await childOutcome(childId, child, place.parentId)
      const toolUseId = place.toolUseId
      const live = toolUseId === undefined ? undefined : deps.liveCommands(place.parentId).find((command) => command.toolUseId === toolUseId)
      return {
        id: childId,
        kind: child.kind,
        title: child.shortLabel ?? child.label,
        startedAtMs: startedAt(child),
        ...(place.parentRowId === undefined ? {} : { parentRowId: place.parentRowId }),
        cardToolUseId: place.card,
        target: { kind: "session", sessionId: childId },
        status,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(live?.model === undefined ? {} : { model: live.model }),
        ...(live?.effort === undefined ? {} : { effort: live.effort }),
        ...(live?.roleSessionId === undefined ? {} : { roleSessionId: live.roleSessionId }),
        ...(ACTIVE.has(status) && toolUseId !== undefined ? { stop: { sessionId: place.parentId, toolUseId } } : {}),
      }
    }

    async function addChildren(parentId: string, childIds: readonly string[]): Promise<void> {
      const parent = places.get(parentId)
      if (!parent) return
      const added = childIds.filter((id) => !parent.children.has(id))
      for (const id of added) {
        parent.children.add(id)
        admitting.add(id)
      }
      try {
        await Promise.all((await subagentCandidates(added)).map(async (childId) => {
          const child = await deps.readSession(childId)
          if (!child || child.kind !== "subagent") return
          const toolUseId = child.launchedFrom.toolUseId
          const card = parent.card ?? toolUseId
          if (card === undefined || places.get(parentId) !== parent) return
          const place: SessionPlace = {
            parentId, card, children: new Set<string>(), shown: new Set<string>(), commands: new Set<string>(), held: new Set<string>(),
            ...(toolUseId === undefined ? {} : { toolUseId }),
            ...(parent.card === undefined ? {} : { parentRowId: parentId }),
          }
          places.set(childId, place)
          parent.shown.add(childId)
          put(await childRow(childId, child, { ...place, parentId, card }))
          await Promise.all([commands(childId), addChildren(childId, child.childSessionIds ?? [])])
        }))
      } finally {
        for (const id of added) admitting.delete(id)
      }
    }

    function removeSubtree(sessionId: string): void {
      const place = places.get(sessionId)
      if (!place) return
      for (const commandId of place.commands) remove(commandId)
      for (const childId of place.shown) removeSubtree(childId)
      places.delete(sessionId)
      remove(sessionId)
    }

    async function children(sessionId: string): Promise<void> {
      const place = places.get(sessionId)
      if (!place) return
      const childIds = (await deps.readSession(sessionId))?.childSessionIds ?? []
      const current = new Set(childIds)
      for (const childId of place.children) {
        if (current.has(childId)) continue
        place.children.delete(childId)
        // A child adopted elsewhere in this tree already has its new place.
        if (place.shown.delete(childId) && places.get(childId)?.parentId === sessionId) removeSubtree(childId)
      }
      await addChildren(sessionId, childIds)
    }

    async function updateChild(sessionId: string): Promise<void> {
      const place = places.get(sessionId)
      if (place?.parentId === undefined || place.card === undefined) return
      const session = await deps.readSession(sessionId)
      if (session?.kind !== "subagent" || places.get(sessionId) !== place) return
      put(await childRow(sessionId, session, { ...place, parentId: place.parentId, card: place.card }))
    }

    /** Who stopped the launching call of each workflow in `launched` that
     *  the tree does not hold yet, with one read of the root's calls. A
     *  workflow the tree holds keeps the stop its root's results stated, so
     *  a workflow's own progress never reads the root's history. */
    async function launchesOf(launched: readonly LaunchedWorkflow[]): Promise<readonly (LaunchedWorkflow & { readonly launch: Launch })[]> {
      const unread = launched.filter(({ workflowId }) => !launches.has(workflowId)).map(({ run }) => run.launchedFrom.toolUseId)
      for (const toolUseId of unread) callReads.set(toolUseId, undefined)
      try {
        const calls = unread.length === 0 ? undefined : await readToolExecutions(deps.reader, rootId, unread)
        return launched.map((item) => {
          const known = launches.get(item.workflowId)
          if (known !== undefined) return { ...item, launch: known }
          const toolUseId = item.run.launchedFrom.toolUseId
          const seen = callReads.get(toolUseId)
          const launch: Launch = { toolUseId, stoppedBy: seen === undefined ? childCallOf(calls?.get(toolUseId)).stoppedBy : seen.stoppedBy }
          launches.set(item.workflowId, launch)
          launchedByCall.set(toolUseId, item.workflowId)
          return { ...item, launch }
        })
      } finally {
        for (const toolUseId of unread) callReads.delete(toolUseId)
      }
    }

    /** The rows of `launched`, with one read of the workflows' states for all of them. */
    async function putWorkflows(launched: readonly LaunchedWorkflow[]): Promise<void> {
      if (launched.length === 0) return
      const [states, held] = await Promise.all([
        readWorkflowStatees(launched.map(({ workflowId }) => workflowId), deps.reader),
        launchesOf(launched),
      ])
      await Promise.all(held.map(async ({ workflowId, run, launch }) => {
        const toolUseId = launch.toolUseId
        const status = workflowStatus({ state: states.statuses.get(workflowId), stoppedBy: launch.stoppedBy })
        put({
          id: workflowId, kind: "workflow", title: run.shortLabel ?? run.label,
          startedAtMs: startedAt(run), cardToolUseId: toolUseId,
          target: { kind: "workflow", workflowId }, status,
          ...await progressOf(workflowId),
          ...(ACTIVE.has(status) ? { stop: { sessionId: rootId, toolUseId } } : {}),
        })
      }))
    }
    function removeWorkflow(workflowId: string): void {
      const launch = launches.get(workflowId)
      if (launch === undefined) return
      launches.delete(workflowId)
      launchedByCall.delete(launch.toolUseId)
      remove(workflowId)
    }

    async function readLaunched(): Promise<void> {
      const launched = await runs.listForParent(rootId)
      const current = new Set(launched.map(({ workflowId }) => workflowId))
      for (const workflowId of launches.keys()) {
        if (!current.has(workflowId)) removeWorkflow(workflowId)
      }
      await putWorkflows(launched.filter(({ workflowId }) => !launches.has(workflowId)))
    }

    async function workflow(workflowId: string): Promise<void> {
      const run = await runs.read(workflowId)
      if (run?.launchedFrom.parentSessionId !== rootId) removeWorkflow(workflowId)
      else await putWorkflows([{ workflowId, run }])
    }

    return {
      rows,
      role: (sessionId) => sessionId === rootId ? (places.has(rootId) ? "root" : undefined) : places.has(sessionId) || admitting.has(sessionId) ? "child" : undefined,
      hasWorkflow: (workflowId) => launches.has(workflowId),
      callResult(toolUseId, stoppedBy) {
        if (callReads.has(toolUseId)) callReads.set(toolUseId, { stoppedBy })
        const workflowId = launchedByCall.get(toolUseId)
        const launch = workflowId === undefined ? undefined : launches.get(workflowId)
        if (launch === undefined) return undefined
        launch.stoppedBy = stoppedBy
        return workflowId
      },
      childrenLaunchedBy(sessionId, toolUseIds) {
        return [...places.get(sessionId)?.shown ?? []].filter((childId) => {
          const launch = places.get(childId)?.toolUseId
          return launch !== undefined && toolUseIds.has(launch)
        })
      },
      async build() {
        await loggedOperation({ log, operation: "background index build", slowMs: SLOW_BUILD_MS, fields: { sessionId: rootId }, summarize: () => ({ rows: rows.size }) }, async () => {
          const root = await deps.readSession(rootId)
          if (!root) return
          places.set(rootId, { children: new Set(), shown: new Set(), commands: new Set(), held: new Set() })
          await Promise.all([commands(rootId), addChildren(rootId, root.childSessionIds ?? []), readLaunched()])
        })
        built = true
      },
      async update(part) {
        switch (part.kind) {
          case "commands": return await commands(part.sessionId, part.toolUseIds)
          case "child": return await updateChild(part.sessionId)
          case "children": return await children(part.sessionId)
          case "workflow": return await workflow(part.workflowId)
          case "launches": return await readLaunched()
        }
      },
    }
  }

  return {
    async rows(sessionId) {
      const built = tree(sessionId, { updated: () => {}, removed: () => {} })
      await built.build()
      return [...built.rows.values()]
    },
    tree,
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
