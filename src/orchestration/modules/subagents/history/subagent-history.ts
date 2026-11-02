import { parseProjectionFact } from "../../../../infra/event-projection.js"
import { CorruptEventRowError, readCapturedFacts, type AsyncEventStateReadSurface, type FactQuery, type StoredFact } from "../../../../infra/event-store-types.js"
import { Log } from "../../../../infra/log.js"
import { heldProjection, pinHeldProjection } from "../../../../infra/projection-registry.js"
import { createReadQueue } from "../../../../infra/read-queue.js"
import { firstTimestamp, loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "./subagent-run-projection.js"
import { parseSubagentRunFact, type SubagentRunFact } from "../facts.js"
import type { SubagentRunEntry } from "./subagent-run-types.js"
import { decodeSessionMetadataFactForReplay } from "../../../session/session-metadata-facts.js"
import { parseStoredSessionRuntimeFact } from "../../../session/session-runtime-event-types.js"

const log = Log.create({ service: "subagent-parent-runs" })
const RUN_FACT_TYPES: ReadonlySet<string> = new Set(SUBAGENT_RUN_FACT_TYPES)

/** The catch-ups whose changes a parent's owner keeps for its readers. A
 *  reader that falls further behind restates every call, as a new reader does. */
const RETAINED_CATCH_UPS = 64

interface ResumeCall {
  readonly childSessionId: string
  readonly position: number
}
interface ResumeAcknowledgement {
  readonly position: number
  readonly childRunId?: string
}
interface ResumedRun {
  readonly childRunId: string
  readonly sameRun: boolean
}

/** A child session's work through one of its runs: that run plus every
 *  earlier run of the session, in the order the session's runs began. A
 *  retry continues the same child session under a new run, so an attempt
 *  states the whole session's work through it. Run durations are active
 *  time, so the wait between attempts is never counted. */
export interface SessionTotals {
  readonly toolCount: number
  readonly tokens: number | undefined
  readonly duration: number
}

export interface SubagentRunsCatchUp {
  /** Latest relevant local or linked-child run fact position, or zero. */
  readonly position: number
  readonly runsByToolUseId: ReadonlyMap<string, SubagentRunEntry>
  readonly runsByChildRunId: ReadonlyMap<string, SubagentRunEntry>
  readonly changedToolUseIds: ReadonlySet<string>
  readonly resumedRunsByToolUseId: ReadonlyMap<string, ResumedRun>
  /** The runs of each call, in the order `runsByChildRunId` holds them. */
  readonly runIdsByToolUseId: ReadonlyMap<string, ReadonlySet<string>>
  /** Each child-session run's session totals through it. */
  readonly sessionTotalsByChildRunId: ReadonlyMap<string, SessionTotals>
  /** The runs of each call whose entry, session totals, or Resume calls this
   *  catch-up changed, in the order the call's runs hold them. */
  readonly changedRunIdsByToolUseId: ReadonlyMap<string, ReadonlySet<string>>
  /** The Resume calls that `resumedRunsByToolUseId` maps to each run. */
  readonly resumeToolUseIdsByChildRunId: ReadonlyMap<string, ReadonlySet<string>>
}

interface SubagentRunsByToolUseIdCursorReader {
  replay(): Promise<SubagentRunsCatchUp>
}

/** The runs of one child session that its parent's owner holds. */
export interface ChildSessionRuns {
  readonly runs: readonly SubagentRunEntry[]
  /** The run the session began last. */
  readonly latestRunId: string | undefined
}

/** The changes of one catch-up, numbered so that each reader of the shared
 *  owner collects only the changes it has not seen yet. */
interface RunChanges {
  readonly generation: number
  readonly toolUseIds: ReadonlySet<string>
  readonly runIdsByToolUseId: ReadonlyMap<string, ReadonlySet<string>>
}

/** A parent's current runs, with the changes after one generation. */
interface RunsSince {
  readonly generation: number
  readonly snapshot: SubagentRunsCatchUp
}

/** One reader of the parent's held run owner. The owner is shared, so the
 *  card summaries and the completion sweep of a parent fold its children's
 *  run facts once between them. */
export function createSubagentRunsByToolUseIdCursorReader(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
): SubagentRunsByToolUseIdCursorReader {
  const owner = heldSubagentParentRuns(reader, sessionId)
  let seen: number | undefined
  return {
    async replay() {
      await owner.replay()
      const { generation, snapshot } = owner.changesSince(seen)
      seen = generation
      return snapshot
    },
  }
}

/** The runs of each named child of `parentSessionId`: every run of a child
 *  that maps to undefined, and for the others only the runs that their new
 *  facts name. One catch-up of the parent's held owner serves every child. */
export async function readSubagentParentReconciliationRuns(
  reader: AsyncEventStateReadSurface,
  parentSessionId: string,
  children: ReadonlyMap<string, readonly StoredFact[] | undefined>,
): Promise<ReadonlyMap<string, ChildSessionRuns>> {
  const owner = heldSubagentParentRuns(reader, parentSessionId)
  await owner.replay()
  return new Map([...children].map(([childSessionId, changes]) => [childSessionId, owner.childRuns(childSessionId, changes)]))
}

/** The parent's run owner. While an owner of the parent holds it
 *  (`holdSubagentParentRuns`), the registry keeps it through churn of its
 *  family. A dropped owner folds the parent's tool history and every child's
 *  runs again on its next catch-up. */
function heldSubagentParentRuns(reader: AsyncEventStateReadSurface, sessionId: string): SubagentParentRuns {
  return heldProjection(reader, `subagent-parent-runs:${sessionId}`, () => createSubagentParentRuns(reader, sessionId))
}

type SubagentParentRuns = ReturnType<typeof createSubagentParentRuns>

/** Keeps the run owner of `parentSessionId` held until the returned release,
 *  which is idempotent. The registry keeps the one owner of the key, so the
 *  readers that already hold it, such as an open transcript's tool
 *  summaries, keep folding the same instance as the parent's sweeps. */
export function holdSubagentParentRuns(reader: AsyncEventStateReadSurface, parentSessionId: string): () => void {
  return pinHeldProjection(reader, `subagent-parent-runs:${parentSessionId}`)
}

/** Folds the run facts of one parent and of every child it links, with one
 *  read for all the children, and then advances only over new facts. */
function createSubagentParentRuns(reader: AsyncEventStateReadSurface, sessionId: string) {
  const eventsByChildRunId = new Map<string, StoredFact[]>()
  const runsByChildRunId = new Map<string, SubagentRunEntry>()
  const runsByToolUseId = new Map<string, SubagentRunEntry>()
  const runIdsByToolUseId = new Map<string, Set<string>>()
  /** The newest run of each call, the last that `runIdsByToolUseId` holds. */
  const latestRunIdByToolUseId = new Map<string, string>()
  /** The runs of each child session, in the order they began. */
  const runIdsByChildSessionId = new Map<string, string[]>()
  const latestRunIdByChildSessionId = new Map<string, string>()
  const sessionIndexByChildRunId = new Map<string, number>()
  const sessionTotalsByChildRunId = new Map<string, SessionTotals>()
  const childSessionIds = new Set<string>()
  const resumeTargets = new Map<string, ResumeCall>()
  const resumeAcknowledgements = new Map<string, ResumeAcknowledgement>()
  const resumedRunsByToolUseId = new Map<string, ResumedRun>()
  const resumeToolUseIdsByChildRunId = new Map<string, Set<string>>()
  const unresolvedResumesByChildSessionId = new Map<string, Set<string>>()
  const unreadableChildSessionIds = new Set<string>()
  const changes: RunChanges[] = []
  let generation = 0
  let toolsReadThrough = 0
  let position = 0
  // The store's head when the last catch-up read: an unmoved head holds no
  // fact this owner has not folded, so the catch-up reads nothing.
  let readThrough = -1

  // Catch-ups run one at a time, because overlapping ones would fold the same
  // facts twice.
  return { replay: createReadQueue(replay).read, changesSince, childRuns }

  /** The current runs, with every change after generation `seen`. */
  function changesSince(seen: number | undefined): RunsSince {
    if (seen === generation) return { generation, snapshot: snapshotOf(new Set(), new Map()) }
    const oldest = changes[0]?.generation
    if (seen === undefined || oldest === undefined || oldest > seen + 1) {
      return { generation, snapshot: snapshotOf(new Set([...runIdsByToolUseId.keys(), ...runsByToolUseId.keys()]), runIdsByToolUseId) }
    }
    const toolUseIds = new Set<string>()
    const runIds = new Map<string, Set<string>>()
    for (const change of changes) {
      if (change.generation <= seen) continue
      for (const toolUseId of change.toolUseIds) toolUseIds.add(toolUseId)
      for (const [toolUseId, ids] of change.runIdsByToolUseId) {
        const merged = runIds.get(toolUseId)
        if (merged) for (const id of ids) merged.add(id)
        else runIds.set(toolUseId, new Set(ids))
      }
    }
    return { generation, snapshot: snapshotOf(toolUseIds, runIds) }
  }

  function childRuns(childSessionId: string, facts: readonly StoredFact[] | undefined): ChildSessionRuns {
    if (unreadableChildSessionIds.has(childSessionId)) return { runs: [], latestRunId: undefined }
    const ids = facts === undefined ? runIdsByChildSessionId.get(childSessionId) ?? [] : [...new Set(facts.flatMap((event) => {
      if (!RUN_FACT_TYPES.has(event.type)) return []
      const fact = salvageDisplayFact(event, parseSubagentRunFact)
      return fact ? [fact.payload.childRunId] : []
    }))]
    return {
      runs: ids.flatMap((id) => {
        const run = runsByChildRunId.get(id)
        return run?.childSessionId === childSessionId ? [run] : []
      }),
      latestRunId: latestRunIdByChildSessionId.get(childSessionId),
    }
  }

  function foldResumeControls(events: readonly StoredFact[]): Set<string> {
    const affected = new Set<string>()
    for (const event of events) {
      const fact = salvageDisplayFact(event, parseStoredSessionRuntimeFact)
      if (!fact) continue
      if (fact.type === "tool.input.completed") {
        const childSessionId = resumedChildSessionId(fact.payload.toolName, fact.payload.input)
        if (childSessionId) resumeTargets.set(fact.payload.toolUseId, { childSessionId, position: event.position })
      }
      if (fact.type !== "tool.result.recorded" || fact.payload.outcome !== "ok") continue
      const target = resumeTargets.get(fact.payload.toolUseId)
      if (!target) continue
      let childRunId: string | undefined
      try {
        const value: unknown = JSON.parse(fact.payload.contentPreview ?? "")
        if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") childRunId = value.id
      } catch {
        // Historical acknowledgements can have only a truncated preview.
      }
      resumeAcknowledgements.set(fact.payload.toolUseId, { position: event.position, ...(childRunId ? { childRunId } : {}) })
      let unresolved = unresolvedResumesByChildSessionId.get(target.childSessionId)
      if (!unresolved) {
        unresolved = new Set()
        unresolvedResumesByChildSessionId.set(target.childSessionId, unresolved)
      }
      unresolved.add(fact.payload.toolUseId)
      affected.add(fact.payload.toolUseId)
    }
    return affected
  }

  async function replay(): Promise<void> {
    const changedChildRunIds = new Set<string>()
    const parentAggregateId = `session:${sessionId}`
    const upperPosition = await reader.capturePosition()
    if (upperPosition === readThrough) return
    // A parent row this release cannot read loses only what it names: a
    // link that cannot be read leaves its child's call open, as an
    // unreadable child run does, and the parent's other children still settle.
    const parent = await readTolerantFacts({
      aggregateId: parentAggregateId,
      types: [...SUBAGENT_RUN_FACT_TYPES, "session.child.linked"],
    }, upperPosition, (row) => { warnUnreadableParentRow(row.type, row.position) })
    const parentEvents = parent.facts
    for (const event of parentEvents) {
      if (event.type !== "session.child.linked") continue
      const fact = decodeSessionMetadataFactForReplay({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
      if (fact?.type === "session.child.linked") childSessionIds.add(fact.payload.childSessionId)
      else warnUnreadableParentRow(event.type, event.position)
    }
    // Resume names a linked child. Sessions without children need no tool scan.
    const toolEvents = childSessionIds.size === 0 ? [] : await readCapturedFacts(reader, {
      aggregateId: parentAggregateId,
      types: ["tool.input.completed", "tool.result.recorded"],
    }, { upperPosition, afterPosition: toolsReadThrough })
    if (childSessionIds.size > 0) toolsReadThrough = upperPosition
    const affectedResumeToolUseIds = foldResumeControls(toolEvents)
    // The children's read starts at this owner's position, so a child linked
    // after the owner passed its earlier run facts would lose those runs. No
    // writer does that: a publication commits the link in the batch of the
    // child's first run, and adoption moves runs only in a migration, before
    // any owner exists. A new link writer must keep that order.
    const children = childSessionIds.size === 0 ? { facts: [], through: position } : await readTolerantFacts(
      { aggregateIds: [...childSessionIds].map((childSessionId) => `session:${childSessionId}`), types: SUBAGENT_RUN_FACT_TYPES },
      upperPosition, (row) => { markUnreadable(row.aggregateId.slice("session:".length), row.type) },
    )
    const childEvents = children.facts
    const nextPosition = toolEvents.reduce((latest, event) => Math.max(latest, event.position), Math.max(parent.through, children.through))
    const events = [...parentEvents.filter((event) => SUBAGENT_RUN_FACT_TYPES.some((type) => type === event.type)), ...childEvents]
      .sort((left, right) => left.position - right.position)
    if (events.length === 0 && parentEvents.length === 0 && toolEvents.length === 0) {
      position = nextPosition
      readThrough = upperPosition
      return
    }
    const changedRunIdsByToolUseId = new Map<string, Set<string>>()
    const runChanged = (toolUseId: string | undefined, childRunId: string): void => {
      if (toolUseId === undefined || !runIdsByToolUseId.get(toolUseId)?.has(childRunId)) return
      const changed = changedRunIdsByToolUseId.get(toolUseId)
      if (changed) changed.add(childRunId)
      else changedRunIdsByToolUseId.set(toolUseId, new Set([childRunId]))
    }
    /** The first run of each child session whose session totals this catch-up changes. */
    const totalsFrom = new Map<string, number>()
    for (const event of events) {
      const fact = salvageDisplayFact(event, parseSubagentRunFact)
      if (!fact) {
        if (event.sessionId !== sessionId) markUnreadable(event.sessionId, event.type)
        continue
      }
      if (!ownsRunFact(event, fact)) continue
      const childRunId = fact.payload.childRunId
      const runEvents = eventsByChildRunId.get(childRunId)
      if (fact.type !== "child_run.created" && !runEvents) continue
      if (runEvents) runEvents.push(event)
      else eventsByChildRunId.set(childRunId, [event])
      changedChildRunIds.add(childRunId)
    }

    const affectedToolUseIds = new Set<string>()
    for (const childRunId of changedChildRunIds) {
      const runEvents = eventsByChildRunId.get(childRunId)
      if (!runEvents) continue
      const previous = runsByChildRunId.get(childRunId)
      const run = loadRun(runEvents)
      if (!run || (run.childSessionId !== undefined && run.parentSessionId !== sessionId)) continue
      runsByChildRunId.set(childRunId, run)
      if (run.childSessionId) {
        const index = listSessionRun(run.childSessionId, run)
        totalsFrom.set(run.childSessionId, Math.min(totalsFrom.get(run.childSessionId) ?? index, index))
        for (const pending of unresolvedResumesByChildSessionId.get(run.childSessionId) ?? []) affectedResumeToolUseIds.add(pending)
      }
      if (previous?.toolUseId) affectedToolUseIds.add(previous.toolUseId)
      if (run.toolUseId) {
        affectedToolUseIds.add(run.toolUseId)
        listCallRun(run.toolUseId, childRunId)
      }
      runChanged(previous?.toolUseId, childRunId)
      runChanged(run.toolUseId, childRunId)
    }
    for (const [childSessionId, from] of totalsFrom) advanceSessionTotals(childSessionId, from, runChanged)

    const changedToolUseIds = new Set<string>()
    const changedResumeToolUseIds = new Set<string>()
    for (const toolUseId of affectedResumeToolUseIds) {
      const target = resumeTargets.get(toolUseId)
      const acknowledgement = resumeAcknowledgements.get(toolUseId)
      if (!target || !acknowledgement) continue
      const selected = resolveResumeRun(target, acknowledgement, runsByChildRunId, runIdsByChildSessionId, eventsByChildRunId)
      // The complete publication interval is now loaded. An ambiguous legacy
      // ACK stays unmapped; later publications cannot change that interval.
      if (selected || !acknowledgement.childRunId) unresolvedResumesByChildSessionId.get(target.childSessionId)?.delete(toolUseId)
      const resumed = resumedRunsByToolUseId.get(toolUseId)
      if (!selected || resumed?.childRunId === selected.childRunId) continue
      const created = eventsByChildRunId.get(selected.childRunId)?.[0]
      if (!created) continue
      resumedRunsByToolUseId.set(toolUseId, { childRunId: selected.childRunId, sameRun: created.position < target.position })
      runChanged(selected.toolUseId, selected.childRunId)
      if (resumed) {
        resumeToolUseIdsByChildRunId.get(resumed.childRunId)?.delete(toolUseId)
        runChanged(runsByChildRunId.get(resumed.childRunId)?.toolUseId, resumed.childRunId)
      }
      let resumes = resumeToolUseIdsByChildRunId.get(selected.childRunId)
      if (!resumes) {
        resumes = new Set()
        resumeToolUseIdsByChildRunId.set(selected.childRunId, resumes)
      }
      resumes.add(toolUseId)
      if (selected.toolUseId) {
        affectedToolUseIds.add(selected.toolUseId)
        changedResumeToolUseIds.add(selected.toolUseId)
      }
    }
    for (const toolUseId of affectedToolUseIds) {
      const previous = runsByToolUseId.get(toolUseId)
      const latest = latestRunIdByToolUseId.get(toolUseId)
      const next = latest === undefined ? undefined : runsByChildRunId.get(latest)
      if (next) {
        if (previous !== next || changedResumeToolUseIds.has(toolUseId)) {
          runsByToolUseId.set(toolUseId, next)
          changedToolUseIds.add(toolUseId)
        }
      } else if (previous) {
        runsByToolUseId.delete(toolUseId)
        changedToolUseIds.add(toolUseId)
      }
    }
    position = nextPosition
    readThrough = upperPosition
    if (changedToolUseIds.size === 0 && changedRunIdsByToolUseId.size === 0) return
    generation += 1
    changes.push({ generation, toolUseIds: changedToolUseIds, runIdsByToolUseId: changedRunIdsByToolUseId })
    if (changes.length > RETAINED_CATCH_UPS) changes.shift()
  }

  /** Whether `fact` belongs to a run of this parent or of a child it links. */
  function ownsRunFact(event: StoredFact, fact: SubagentRunFact): boolean {
    if (fact.type !== "child_run.created") return event.sessionId === sessionId || childSessionIds.has(event.sessionId)
    if (!("childSessionId" in fact.payload)) return event.sessionId === sessionId
    // A linked child can hold a run that another parent created and an
    // adoption moved here: its loaded run names the owning parent.
    return fact.payload.childSessionId === event.sessionId && (fact.payload.parentSessionId === sessionId || childSessionIds.has(event.sessionId))
  }

  /** The facts of `query` after `position` through `upperPosition`, and the
   *  newest position read. Each row that cannot be decoded goes to
   *  `unreadable` and counts as read, so a later catch-up never meets it
   *  again. The linked children's run facts take one read for all of them: a
   *  chat with hundreds of subagents would otherwise pay one state round trip
   *  for each child. */
  async function readTolerantFacts(query: FactQuery, upperPosition: number, unreadable: (row: CorruptEventRowError["row"]) => void): Promise<{ readonly facts: StoredFact[]; readonly through: number }> {
    const facts: StoredFact[] = []
    let after = position
    let through = position
    for (;;) {
      const page = await reader.readPage(query, upperPosition, after, true, "deferred")
      for (const fact of page.facts) {
        through = Math.max(through, fact.position)
        if (fact instanceof CorruptEventRowError) unreadable(fact.row)
        else facts.push(fact)
      }
      if (page.continuationPosition === null) return { facts, through }
      after = page.continuationPosition
    }
  }

  /** Reports a row of the parent that this release cannot read. The cursor
   *  passes the row, so each row reports once. */
  function warnUnreadableParentRow(type: string, rowPosition: number): void {
    log.warn("parent subagent row is unreadable; what it names is not delivered", { parentSessionId: sessionId, type, position: rowPosition })
  }

  /** One run's entry from its facts. A run whose facts this release cannot
   *  fold is left out of the cards, and its child is unreadable. */
  function loadRun(runEvents: readonly StoredFact[]): SubagentRunEntry | undefined {
    try {
      return loadSubagentRunsFromEvents(runEvents)[0]
    } catch {
      const childSessionId = runEvents[0]?.sessionId
      if (childSessionId !== undefined && childSessionId !== sessionId) markUnreadable(childSessionId, "fold")
      return undefined
    }
  }

  /** Marks a child whose run history this release cannot read in full. The
   *  completion sweep reads none of its runs, because the run it cannot read
   *  can be the child's newest: the child's call stays open, as it would
   *  before the child finished. The cards keep the runs they can read. */
  function markUnreadable(childSessionId: string, cause: string): void {
    if (unreadableChildSessionIds.has(childSessionId)) return
    unreadableChildSessionIds.add(childSessionId)
    log.warn("subagent run history is unreadable; its completion is not delivered", { parentSessionId: sessionId, childSessionId, cause })
  }

  /** Lists `run` among the runs of its child session, and returns its place
   *  there. A new run is the session's newest unless its creation time is
   *  earlier than the newest run's, as the session's own run fold decides. */
  function listSessionRun(childSessionId: string, run: SubagentRunEntry): number {
    const childRunId = run.childRunId
    let ids = runIdsByChildSessionId.get(childSessionId)
    if (!ids) {
      ids = []
      runIdsByChildSessionId.set(childSessionId, ids)
    }
    let index = sessionIndexByChildRunId.get(childRunId)
    if (index === undefined) {
      index = ids.push(childRunId) - 1
      sessionIndexByChildRunId.set(childRunId, index)
      const latest = runsByChildRunId.get(latestRunIdByChildSessionId.get(childSessionId) ?? "")
      if (!latest || firstTimestamp(run) >= firstTimestamp(latest)) latestRunIdByChildSessionId.set(childSessionId, childRunId)
    }
    return index
  }

  /** Lists `childRunId` among the runs of its call; a run listed last is the call's newest. */
  function listCallRun(toolUseId: string, childRunId: string): void {
    let ids = runIdsByToolUseId.get(toolUseId)
    if (!ids) {
      ids = new Set()
      runIdsByToolUseId.set(toolUseId, ids)
    }
    if (ids.has(childRunId)) return
    ids.add(childRunId)
    latestRunIdByToolUseId.set(toolUseId, childRunId)
  }

  /** A run's session totals change with its own figures and with those of
   *  every earlier run of its session, so a change folds forward from the
   *  first changed run, which is almost always the session's newest. */
  function advanceSessionTotals(childSessionId: string, from: number, runChanged: (toolUseId: string | undefined, childRunId: string) => void): void {
    const ids = runIdsByChildSessionId.get(childSessionId) ?? []
    // SAFETY: a session lists a run only after `runsByChildRunId` holds it, and every listed run before `from` has totals.
    let through = from > 0 ? sessionTotalsByChildRunId.get(ids[from - 1]!)! : undefined
    for (const childRunId of ids.slice(from)) {
      // SAFETY: a session lists a run only after `runsByChildRunId` holds it.
      const run = runsByChildRunId.get(childRunId)!
      const totals: SessionTotals = {
        toolCount: (through?.toolCount ?? 0) + (run.toolUses ?? 0),
        tokens: run.totalTokens === undefined ? through?.tokens : (through?.tokens ?? 0) + run.totalTokens,
        duration: (through?.duration ?? 0) + (run.durationMs ?? 0),
      }
      const held = sessionTotalsByChildRunId.get(childRunId)
      if (held?.toolCount !== totals.toolCount || held.tokens !== totals.tokens || held.duration !== totals.duration) {
        sessionTotalsByChildRunId.set(childRunId, totals)
        runChanged(run.toolUseId, childRunId)
      }
      through = totals
    }
  }

  function snapshotOf(changedToolUseIds: ReadonlySet<string>, changedRunIdsByToolUseId: ReadonlyMap<string, ReadonlySet<string>>): SubagentRunsCatchUp {
    return { position, runsByToolUseId, runsByChildRunId, resumedRunsByToolUseId, changedToolUseIds, runIdsByToolUseId, sessionTotalsByChildRunId, changedRunIdsByToolUseId, resumeToolUseIdsByChildRunId }
  }
}

/** The child that a parent's call resumes: `process` resume names it by
 *  its session id. A retired `subagent` resume named it by `session_id`;
 *  remove that branch after 2027-04-08. */
function resumedChildSessionId(toolName: string, input: { readonly [key: string]: unknown }): string | undefined {
  if (toolName === "process" && input.action === "resume" && typeof input.process_id === "string") return input.process_id
  if (toolName === "subagent" && input.kind === "resume" && typeof input.session_id === "string") return input.session_id
  return undefined
}

/** Resolves a Resume only from its explicit ACK identity or one unique
 * publication within the call. Another operator can publish before a delayed ACK. */
function resolveResumeRun(
  call: ResumeCall,
  acknowledgement: ResumeAcknowledgement,
  runs: ReadonlyMap<string, SubagentRunEntry>,
  runIdsByChildSessionId: ReadonlyMap<string, readonly string[]>,
  eventsByChildRunId: ReadonlyMap<string, readonly StoredFact[]>,
): SubagentRunEntry | undefined {
  if (acknowledgement.childRunId) {
    const run = runs.get(acknowledgement.childRunId)
    return run?.childSessionId === call.childSessionId ? run : undefined
  }
  let publication: SubagentRunEntry | undefined
  for (const childRunId of runIdsByChildSessionId.get(call.childSessionId) ?? []) {
    for (const event of eventsByChildRunId.get(childRunId) ?? []) {
      if ((event.type === "child_run.created" || event.type === "subagent.resumed") && event.position > call.position && event.position < acknowledgement.position) {
        if (publication) return undefined
        publication = runs.get(childRunId)
      }
    }
  }
  return publication
}

function salvageDisplayFact<T>(event: StoredFact, parse: (value: unknown) => T): T | undefined {
  try {
    return parseProjectionFact(event, parse)
  } catch {
    return undefined
  }
}

/** One fresh fold of a parent's runs by call, apart from the held owner. */
export async function readSubagentRunsByToolUseId(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
): Promise<ReadonlyMap<string, SubagentRunEntry>> {
  const owner = createSubagentParentRuns(reader, sessionId)
  await owner.replay()
  return owner.changesSince(undefined).snapshot.runsByToolUseId
}
