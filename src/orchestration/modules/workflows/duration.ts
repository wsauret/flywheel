import type { AsyncEventStateReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import type { ActiveInterval, ActivityOpening, WorkflowControlActivity } from "../../../workflows/vm/control-activity.js"
import { readWorkflowControlActivity } from "../../../workflows/vm/recovery-fold.js"
import { readEpisodeEvidenceEnd } from "../../session-store/duration.js"
import { readWorkflowMemberEvidence } from "../../workflow-host/member-totals.js"
import { workflowMembershipReader } from "../../session/workflow-membership.js"
import { reduceSessionDurationEvent } from "../../session/session-duration-projection.js"
import { createWorkflowRunReader } from "./run-record.js"

/** What a run's residual history adds, read once: the active time that its
 *  old session recorded, and whether its own intervals open only after its
 *  registration. */
interface Residual {
  readonly accumulatedActiveMs: number
  readonly afterRegistration: boolean
}

/** The active time of a run and the intervals that it was active in. A phase
 *  counts only its part of these intervals, so a phase's time stops while its
 *  run is interrupted. The open interval of a live run is `streamingStartedAt`
 *  and is not in `activeIntervals`, whose identity holds while no interval
 *  closes or moves. A run converted from the older storage era counts its
 *  old session's time, but its intervals keep the era before its
 *  registration, which its early phases ran in. */
export interface WorkflowRunTime {
  readonly durationMs: number
  readonly streamingStartedAt: number | null
  readonly activeIntervals: readonly ActiveInterval[]
}

/** One workflow's closed and cut intervals, measured once for the activity
 *  arrays they came from, and the intervals with the open one that a read
 *  last measured to its evidence. */
interface Measured {
  readonly closed: WorkflowControlActivity["closed"]
  readonly cuts: WorkflowControlActivity["cuts"]
  readonly afterRegistration: boolean
  /** The milliseconds of the cut intervals that the run's time counts. */
  readonly cutMs: number
  readonly intervals: readonly ActiveInterval[]
  withOpen?: { readonly start: number; readonly end: number; readonly intervals: readonly ActiveInterval[] }
}

/** Active time comes only from the run's active intervals, which the shared
 *  recovery owner advances from the transitions it already runs. This reader
 *  measures a workflow's closed intervals again only when one closes or a
 *  cut is added, so a read costs its open interval alone. A crash ends at
 *  the last durable running-loop evidence. */
export function createWorkflowDurationReader(reader: AsyncEventStateReadSurface) {
  const residuals = new Map<string, Residual>()
  // A cut interval is immutable, so each cut reads its members' evidence once.
  const cutEnds = new Map<string, number>()
  const measures = new Map<string, Measured>()
  const members = workflowMembershipReader(reader)
  return async (workflowId: string, live: boolean): Promise<WorkflowRunTime> => {
    const residual = residuals.get(workflowId) ?? await readResidual(workflowId)
    residuals.set(workflowId, residual)
    const activity = await readWorkflowControlActivity(reader, workflowId)
    const afterRegistration = residual.afterRegistration && activity.registeredAt !== undefined
    const counted = (opening: ActivityOpening): StoredFact | undefined => afterRegistration ? opening.afterRegistration : opening.first
    const known = measures.get(workflowId)
    const measured = known?.closed === activity.closed && known.cuts === activity.cuts && known.afterRegistration === afterRegistration
      ? known : await measure(workflowId, activity, afterRegistration, counted)
    measures.set(workflowId, measured)
    const closedMs = residual.accumulatedActiveMs + (afterRegistration ? activity.closedMsAfterRegistration : activity.closedMs) + measured.cutMs
    const { open } = activity
    const start = open && counted(open)
    if (!open || live) return { durationMs: closedMs, streamingStartedAt: live && start ? start.timestamp : null, activeIntervals: measured.intervals }
    // An interval that no running clock measures ends at the newest
    // running-loop evidence after it opened: the workflow's own facts, which
    // the shared owner read, or a member's, which the held member fold keeps.
    const member = await readWorkflowMemberEvidence(reader, workflowId)
    const first = open.first
    const end = Math.max(...[first, activity.latest, member].flatMap((evidence) => evidence && evidence.position >= first.position ? [evidence.timestamp] : []))
    if (measured.withOpen?.start !== first.timestamp || measured.withOpen.end !== end) {
      measured.withOpen = { start: first.timestamp, end, intervals: [...measured.intervals, { start: first.timestamp, end: Math.max(first.timestamp, end) }] }
    }
    return { durationMs: closedMs + (start ? Math.max(0, end - start.timestamp) : 0), streamingStartedAt: null, activeIntervals: measured.withOpen.intervals }
  }

  async function measure(workflowId: string, activity: WorkflowControlActivity, afterRegistration: boolean, counted: (opening: ActivityOpening) => StoredFact | undefined): Promise<Measured> {
    let cutMs = 0
    const cut: ActiveInterval[] = []
    for (const { opening, beforePosition } of activity.cuts) {
      const length = await cutLength(workflowId, opening.first, beforePosition)
      cut.push({ start: opening.first.timestamp, end: opening.first.timestamp + length })
      const from = counted(opening)
      if (from) cutMs += await cutLength(workflowId, from, beforePosition)
    }
    return { closed: activity.closed, cuts: activity.cuts, afterRegistration, cutMs, intervals: cut.length === 0 ? activity.closed : [...activity.closed, ...cut] }
  }

  /** A recovery root or a damaged row cuts an interval at a past position.
   *  The cut reads every member once, so this read is not paid per change. */
  async function cutLength(workflowId: string, open: StoredFact, beforePosition: number): Promise<number> {
    const key = `${workflowId}:${open.position}:${beforePosition}`
    const known = cutEnds.get(key)
    if (known !== undefined) return known
    const end = await readEpisodeEvidenceEnd(reader, {
      aggregateId: `workflow:${workflowId}`, sessionIds: (await members.list(workflowId)).map(({ sessionId }) => sessionId),
      afterPosition: open.position, beforePosition,
    })
    const length = Math.max(0, (end ?? open.timestamp) - open.timestamp)
    cutEnds.set(key, length)
    return length
  }

  async function readResidual(workflowId: string): Promise<Residual> {
    const aggregateId = (await createWorkflowRunReader(reader).read(workflowId))?.historicalResidualAggregateId
    const old = aggregateId ? await reader.readLatestByAggregateAndTypes(aggregateId, ["session.duration.recorded"]) : []
    return { accumulatedActiveMs: old.reduce(reduceSessionDurationEvent, { accumulatedActiveMs: 0 }).accumulatedActiveMs, afterRegistration: aggregateId !== undefined }
  }
}
