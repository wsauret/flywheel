import { parseProjectionFact } from "../../infra/event-projection.js"
import { CorruptEventRowError, type StoredFact } from "../../infra/event-store-types.js"
import { parseWorkflowRunFact } from "../run-facts.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import { foldWorkflowControl } from "./fact-fold.js"
import { parseWorkflowControlFact, workflowRootControl } from "./session-facts.js"

/** Where an active interval opened: at the first fact that left the run
 *  working, which is a root or proposal that left control executing or
 *  following up, or the release of a run cut while control stayed so, and
 *  at the first such fact after the run's registration, which is where a
 *  run with residual history opens it. */
export interface ActivityOpening {
  readonly first: StoredFact
  readonly afterRegistration?: StoredFact
}

/** An active interval, in milliseconds since the epoch. */
export interface ActiveInterval {
  readonly start: number
  readonly end: number
}

/** An active interval that a root, a damaged row, or a proposal that does
 *  not fold cut at `beforePosition`. Its reader bounds it by the members'
 *  evidence, which this fold does not read. */
interface ActivityCut {
  readonly opening: ActivityOpening
  readonly beforePosition: number
}

/** When one workflow's run worked. Only the facts at which that changes
 *  move it: roots and proposal terminals, which change control, and a run
 *  cut, which a whole-run interrupt records and its Resume clears while
 *  control stays active. It holds one entry per interrupt, cut, or
 *  settlement, never one entry per commit, and a closed interval is added
 *  once, when it closes. */
export interface WorkflowControlActivity {
  /** The intervals that a status change or a run cut closed, each measured
   *  from its opening's `first`, in the order they closed. */
  readonly closed: readonly ActiveInterval[]
  /** The milliseconds of `closed`, measured from `first` and from
   *  `afterRegistration`. */
  readonly closedMs: number
  readonly closedMsAfterRegistration: number
  readonly cuts: readonly ActivityCut[]
  readonly open?: ActivityOpening
  /** Control's last known status was executing or following up. */
  readonly active: boolean
  /** A whole-run interrupt is recorded, so the run does not work while
   *  control stays active. */
  readonly held: boolean
  /** The newest readable fact, which is running-loop evidence too. */
  readonly latest?: StoredFact
  readonly registeredAt?: number
}

const NO_ACTIVITY: WorkflowControlActivity = { closed: [], closedMs: 0, closedMsAfterRegistration: 0, cuts: [], active: false, held: false }
const ACTIVITY_TERMINAL_TYPES: ReadonlySet<string> = new Set(["workflow.control.committed", "workflow.definition_identity.adopted", "workflow.definition_identity.migrated"])

function isRoot(fact: StoredFact): boolean {
  return fact.type === "workflow.control.initialized" || fact.type === "workflow.control.recovered"
}

function isActive(control: CommittedWorkflowControl): boolean {
  return control.status === "executing" || control.status === "follow_up"
}

/** The run cut that `fact` records, null for a cleared cut, or undefined
 *  when `fact` is no run cut or this build cannot read it. */
function recordedCut(fact: StoredFact): { readonly timestamp: number } | null | undefined {
  if (fact.type !== "workflow.run.cut.updated") return undefined
  try {
    const parsed = parseWorkflowRunFact({ type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload })
    return parsed.type === "workflow.run.cut.updated" ? parsed.payload.cut : undefined
  } catch {
    return undefined
  }
}

function opened(activity: WorkflowControlActivity, fact: StoredFact): WorkflowControlActivity {
  const registered = activity.registeredAt !== undefined && fact.position > activity.registeredAt
  return { ...activity, open: { first: fact, ...(registered ? { afterRegistration: fact } : {}) } }
}

function closedAt(activity: WorkflowControlActivity, at: number): WorkflowControlActivity {
  const { open, ...rest } = activity
  if (!open) return activity
  const start = open.first.timestamp
  return {
    ...rest,
    closed: [...activity.closed, { start, end: Math.max(start, at) }],
    closedMs: activity.closedMs + Math.max(0, at - start),
    closedMsAfterRegistration: activity.closedMsAfterRegistration + (open.afterRegistration ? Math.max(0, at - open.afterRegistration.timestamp) : 0),
  }
}

/** The activity after a readable fact that does not change control. A run
 *  cut closes the open interval at the cut's time, and its release reopens
 *  one while control stays active. */
export function observedActivity(activity: WorkflowControlActivity, fact: StoredFact): WorkflowControlActivity {
  const registeredAt = activity.registeredAt ?? (fact.type === "workflow.run.registered" ? fact.position : undefined)
  const observed = { ...activity, latest: fact, ...(registeredAt === undefined ? {} : { registeredAt }) }
  const cut = recordedCut(fact)
  if (cut === undefined) return observed
  if (cut !== null) return closedAt({ ...observed, held: true }, cut.timestamp)
  const released = { ...observed, held: false }
  return released.active && !released.open ? opened(released, fact) : released
}

/** The activity after `fact` left control as `control`. */
export function controlledActivity(activity: WorkflowControlActivity, fact: StoredFact, control: CommittedWorkflowControl): WorkflowControlActivity {
  const active = isActive(control)
  const next = active === activity.active ? activity : { ...activity, active }
  if (!active) return closedAt(next, fact.timestamp)
  if (next.held) return next
  if (!next.open) return opened(next, fact)
  const registered = next.registeredAt !== undefined && fact.position > next.registeredAt
  return registered && next.open.afterRegistration === undefined ? { ...next, open: { ...next.open, afterRegistration: fact } } : next
}

/** Cuts the open interval at `beforePosition`. Control is unknown until a
 *  later root states it. */
function cutActivity(activity: WorkflowControlActivity, beforePosition: number): WorkflowControlActivity {
  const { open: opening, ...rest } = activity
  return { ...rest, active: false, cuts: opening ? [...activity.cuts, { opening, beforePosition }] : activity.cuts }
}

/** The activity of a whole history, from its own control transitions and
 *  run cuts. A
 *  damaged epoch supplies no further intervals; a later root can start
 *  another. Its caller folds a history once, where no advancing control can
 *  supply the transitions. */
export function seedControlActivity(facts: readonly (StoredFact | CorruptEventRowError)[]): WorkflowControlActivity {
  let activity = NO_ACTIVITY
  let control: CommittedWorkflowControl | null = null
  let batch: StoredFact[] = []
  for (const fact of facts) {
    if (fact instanceof CorruptEventRowError) {
      activity = cutActivity(activity, fact.position)
      control = null
      batch = []
      continue
    }
    activity = observedActivity(activity, fact)
    if (isRoot(fact)) activity = cutActivity(activity, fact.position)
    try {
      if (isRoot(fact)) {
        const parsed = parseProjectionFact(fact, parseWorkflowControlFact)
        if (parsed.type !== "workflow.control.initialized" && parsed.type !== "workflow.control.recovered") throw new Error("Expected workflow control root")
        control = workflowRootControl(parsed)
        batch = []
      } else if (control && fact.seq >= control.aggregateSeq) {
        batch.push(fact)
        if (!ACTIVITY_TERMINAL_TYPES.has(fact.type)) continue
        control = foldWorkflowControl(control, batch)
        batch = []
      } else {
        continue
      }
    } catch {
      control = null
      batch = []
    }
    activity = control ? controlledActivity(activity, fact, control) : cutActivity(activity, fact.position)
  }
  return activity
}
