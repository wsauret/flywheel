import { durableOwnerAggregate } from "../../infra/durable-owner.js"
import { isDeepStrictEqual } from "node:util"
import { capturedFacts, CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { yieldToNextTask } from "../../infra/task-scheduling.js"
import { workflowRunOwner } from "../module-catalog.js"
import { BUDGET_FACT_TYPES, initialBudgetProjectionState, reduceBudgetEvent, type BudgetProjectionState } from "../session/budget-projection.js"
import type { UsageTotals } from "../session/budget-summary.js"
import { createSessionMetadataProjection, reduceSessionMetadataEvent } from "../session/session-metadata-projection.js"
import { countToolCall, initialToolCallCount, TOOL_EXECUTION_FACT_TYPES, type ToolCallCount } from "../session/tool-execution-projection.js"
import { workflowMembershipReader } from "../session/workflow-membership.js"
import { EPISODE_EVIDENCE_FACT_TYPES } from "../session-store/duration.js"
import { reduceSessionDurationEvent, SESSION_DURATION_FACT_TYPES } from "../session/session-duration-projection.js"
import { Log } from "../../infra/log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"

const log = Log.create({ service: "workflow-member-totals" })
/** A member's duration row that this build cannot read, such as one that a
 *  newer build wrote, keeps the time that the member recorded before it.
 *  Every seed of the fold reads the row again, so one record names each
 *  session, and the reads after it only count. */
const unreadableDurations = coalesceRepeats<{ readonly position: number; readonly version: number }>({
  windowMs: 60_000,
  first: (sessionId, row) => { log.warn("a workflow member's duration row has a shape this release cannot read; its earlier time is kept", { sessionId, ...row }) },
  repeated: (sessionId, repeats) => { log.debug("a workflow member's unreadable duration row was read again", { sessionId, count: repeats.count, windowMs: repeats.windowMs }) },
})

/** Usage totals with the served requests whose provider reported no usage, which the budget gate names. */
type WorkflowUsageTotals = UsageTotals & { readonly unmeasuredRequests: number }

/** What a workflow's members did. Policy counts direct members and aggregate
 *  usage. Display adds each real descendant once. Context pressure stays
 *  local. The tool count holds the calls of every member and descendant that
 *  no other call dispatched. */
export interface WorkflowMemberTotals {
  readonly policy: WorkflowUsageTotals
  readonly display: WorkflowUsageTotals
  readonly toolCount: number
  readonly durations: MemberDurations
}

/** The active time that each direct member's session recorded, by session
 *  id, which the fold advances in place. `version` moves with each change, so
 *  a reader learns that a time moved without comparing every member. */
interface MemberDurations {
  readonly version: number
  readonly bySession: ReadonlyMap<string, number>
}

/** The budget gate reads usage before every agent start, and the workflow
 *  card reads every total after every member's change, so neither may cost a
 *  read per member: refolding every member's budget before each start of 150
 *  parallel agents starved the executor until it was killed. One held fold
 *  seeds every owner once and then advances on the facts committed after it.
 *  A tool fact of a member that cannot be read fails the tool count alone. */
export async function readWorkflowMemberTotals(reader: AsyncEventReadSurface, workflowId: string): Promise<WorkflowMemberTotals> {
  return memberTotals(await readWorkflowMemberState(reader, workflowId))
}

/** The totals of a workflow that the held fold already holds, advanced to the
 *  facts committed since its last read, or undefined when no reader asked for
 *  them yet. It never seeds a workflow, so a reader that restates every card
 *  pays nothing for the cards that nobody measured. */
export async function readHeldWorkflowMemberTotals(reader: AsyncEventReadSurface, workflowId: string): Promise<WorkflowMemberTotals | undefined> {
  const state = await workflowMemberTotalsOwner(reader).held(workflowId)
  if (state?.usageFailure) throw state.usageFailure
  return state && memberTotals(state)
}

function memberTotals(state: WorkflowMemberState): WorkflowMemberTotals {
  if (state.toolFailure) throw state.toolFailure
  return { policy: state.policy, display: state.display, toolCount: state.toolCount, durations: { version: state.durationsVersion, bySession: state.durations } }
}

/** The active time that each direct member's session recorded, from the same
 *  held fold, at the cost of the facts committed since its last read. */
export async function readWorkflowMemberDurations(reader: AsyncEventReadSurface, workflowId: string): Promise<ReadonlyMap<string, number>> {
  return (await readWorkflowMemberState(reader, workflowId)).durations
}

/** The maximum timestamp of each direct member's latest readable evidence:
 *  an unreadable latest row excludes that member. These are the facts that
 *  `readEpisodeEvidenceEnd` reads, from the same held fold. A member writes
 *  evidence with no workflow commit, as when the only running agent asks a
 *  question and then resumes, so the workflow's clock reads it here after
 *  every change at the cost of the facts committed since its last read. */
export async function readWorkflowMemberEvidence(reader: AsyncEventReadSurface, workflowId: string): Promise<MemberEvidence | undefined> {
  return (await readWorkflowMemberState(reader, workflowId)).evidence?.maximum
}

export async function readWorkflowUsage(reader: AsyncEventReadSurface, workflowId: string): Promise<Pick<WorkflowMemberTotals, "policy" | "display">> {
  const state = await readWorkflowMemberState(reader, workflowId)
  return { policy: state.policy, display: state.display }
}

async function readWorkflowMemberState(reader: AsyncEventReadSurface, workflowId: string): Promise<WorkflowMemberState> {
  const state = await workflowMemberTotalsOwner(reader).read(workflowId)
  if (state.usageFailure) throw state.usageFailure
  return state
}

/** Advances the shared owner once and consumes the workflows whose usage moved
 * since the last notification, including movement observed by intervening reads. */
export function advanceWorkflowMemberTotals(reader: AsyncEventReadSurface): Promise<readonly string[]> {
  return workflowMemberTotalsOwner(reader).moved()
}

/** Uses the same membership and parentage for accounting reads and their invalidation. */
async function workflowUsageSessions(reader: AsyncEventReadSurface, workflowId: string): Promise<{
  readonly members: ReadonlySet<string>
  readonly all: ReadonlySet<string>
}> {
  const members = new Set((await workflowMembershipReader(reader).list(workflowId)).map(({ sessionId }) => sessionId))
  // A converted run's retired session can still be the launch parent of a
  // child that no member conversation adopted; that child is a descendant.
  const reached = new Set([workflowId, ...members])
  const { sessions } = await createSessionMetadataProjection(reader).replay()
  for (;;) {
    const before = reached.size
    for (const [id, session] of Object.entries(sessions)) {
      if (session.kind !== "chat" && session.launchedFrom && reached.has(session.launchedFrom.parentSessionId)) reached.add(id)
    }
    if (before === reached.size) break
  }
  reached.delete(workflowId)
  return { members, all: reached }
}

/** One owner of a workflow's totals. Members and the workflow's own owners
 *  count toward policy; descendants count only toward display. Only a member
 *  or descendant session holds counted tool calls. */
interface MemberOwner {
  readonly policy: boolean
  /** A direct member's stable, one-based slot in the evidence tree. */
  readonly member?: number
  readonly budget: BudgetProjectionState
  /** Changed in place by the fold alone: no reader of the published state
   *  reads it, and `countToolCall` reads a fact before it changes the count. */
  readonly tools?: ToolCallCount
}

type WorkflowMemberState = {
  /** Owners by the aggregate their facts commit to. */
  owners: Map<string, MemberOwner>
  /** Sessions whose non-chat children are descendants: the workflow and every owning session. */
  parents: Set<string>
  policy: WorkflowUsageTotals
  display: WorkflowUsageTotals
  toolCount: number
  /** Changed in place by the fold alone, as `tools` is. */
  readonly durations: Map<string, number>
  durationsVersion: number
  memberCount: number
  evidence?: MemberEvidenceTree
  /** An unreadable budget row makes only this workflow's usage unknown. */
  usageFailure?: Error
  /** The first tool fact of a counted session that could not be read. The
   *  tool count is unknown from then on, and usage stays known. */
  toolFailure?: Error
}

/** One fact that a member's running loop wrote. */
export interface MemberEvidence {
  readonly position: number
  readonly timestamp: number
}

/** Each slot keeps its latest row, including damage. Subtree maxima let a
 *  member lose its contribution without scanning the other members. Slots
 *  follow binary integer paths, so an update copies O(log members)
 *  nodes and published projection drafts never share mutable evidence. */
interface MemberEvidenceTree {
  readonly row?: MemberEvidence | { readonly position: number; readonly timestamp?: undefined }
  readonly left?: MemberEvidenceTree
  readonly right?: MemberEvidenceTree
  readonly maximum?: MemberEvidence
}

const OWNERSHIP_FACT_TYPES = ["session.created", "session.ownership.adopted", "session.representation.retired", "session.deleted"] as const
const TOOL_FACT_TYPE_NAMES: readonly string[] = TOOL_EXECUTION_FACT_TYPES
const EVIDENCE_FACT_TYPE_NAMES: readonly string[] = EPISODE_EVIDENCE_FACT_TYPES
const BUDGET_FACT_TYPE_NAMES: readonly string[] = BUDGET_FACT_TYPES
const DURATION_FACT_TYPE_NAMES: readonly string[] = SESSION_DURATION_FACT_TYPES
/** Every durations version that any fold gave, so a seed that replaces a
 *  workflow's state never gives a version that an earlier state gave. */
let durationsVersions = 0
const ZERO_USAGE: WorkflowUsageTotals = { totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalInputTokens: 0, totalOutputTokens: 0, unmeasuredRequests: 0 }

function workflowMemberTotalsOwner(reader: AsyncEventReadSurface) {
  return heldProjection(reader, "workflow-members", () => {
    const workflows = new Map<string, WorkflowMemberState>()
    const byAggregate = new Map<string, Set<string>>()
    const byParent = new Map<string, Set<string>>()
    const moved = new Set<string>()
    let position = 0
    const index = (lookup: Map<string, Set<string>>, key: string, id: string) => {
      let ids = lookup.get(key)
      if (!ids) lookup.set(key, ids = new Set())
      ids.add(id)
    }
    function indexWorkflow(id: string, state: WorkflowMemberState) {
      for (const aggregate of state.owners.keys()) index(byAggregate, aggregate, id)
      for (const parent of state.parents) index(byParent, parent, id)
    }
    function unindex(lookup: Map<string, Set<string>>, key: string, id: string) {
      const ids = lookup.get(key)
      ids?.delete(id)
      if (ids?.size === 0) lookup.delete(key)
    }
    async function* changedFacts(types: readonly string[], upper: number, aggregateIds?: readonly string[]) {
      let after = position
      while (after < upper) {
        const page = await reader.readPage({ types, aggregateIds }, upper, after, true, "deferred")
        yield* page.facts
        if (page.continuationPosition === null) return
        after = page.continuationPosition
        await yieldToNextTask()
      }
    }
    async function advance() {
      const upper = await reader.capturePosition()
      if (upper <= position) return
      // No ownership fact changes an owner that holds no workflow, and a
      // later seed reads through the position it is given.
      if (workflows.size === 0) {
        position = upper
        return
      }
      // Membership facts have no aggregate filter: a new child names an existing
      // parent, but its own aggregate was not known before this range.
      for await (const event of changedFacts(OWNERSHIP_FACT_TYPES, upper)) {
        if (event instanceof CorruptEventRowError) {
          // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
          if (byAggregate.has(event.row.aggregateId)) throw event
          continue
        }
        if (event.type === "session.created") {
          const session = reduceSessionMetadataEvent({ sessions: {}, deleted: {}, errors: {} }, event).sessions[event.sessionId]
          if (!session) continue
          const ids = new Set(session.launchedFrom ? byParent.get(session.launchedFrom.parentSessionId) : [])
          if (session.kind === "workflow-agent" && workflows.has(session.workflowMembership.workflowId)) ids.add(session.workflowMembership.workflowId)
          for (const id of ids) {
            const state = workflows.get(id)
            if (!state) continue
            reduceWorkflowMembers(state, event, id)
            if (state.owners.has(event.aggregateId)) {
              index(byAggregate, event.aggregateId, id)
              index(byParent, event.sessionId, id)
            }
          }
        } else {
          // Adoption can move a complete subtree. These rare person and migration
          // actions rebuild membership; ordinary usage never traverses workflows.
          const ids = event.type === "session.ownership.adopted" ? [...workflows.keys()] : [...(byParent.get(event.sessionId) ?? [])]
          for (const id of ids) {
            const previous = workflows.get(id)
            if (!previous) continue
            const seeded = await seedWorkflowMembers(reader, id, position)
            for (const aggregate of previous.owners.keys()) unindex(byAggregate, aggregate, id)
            for (const parent of previous.parents) unindex(byParent, parent, id)
            workflows.set(id, seeded)
            indexWorkflow(id, seeded)
            if (!isDeepStrictEqual(previous.policy, seeded.policy) || !isDeepStrictEqual(previous.display, seeded.display)) moved.add(id)
          }
        }
      }
      if (byAggregate.size > 0) {
        const types = [...new Set([...BUDGET_FACT_TYPES, ...TOOL_EXECUTION_FACT_TYPES, ...EPISODE_EVIDENCE_FACT_TYPES, ...SESSION_DURATION_FACT_TYPES])]
        for await (const event of changedFacts(types, upper, [...byAggregate.keys()])) {
          const aggregate = event instanceof CorruptEventRowError ? event.row.aggregateId : event.aggregateId
          for (const id of byAggregate.get(aggregate) ?? []) {
            const state = workflows.get(id)
            if (!state) continue
            const beforePolicy = state.policy
            const beforeDisplay = state.display
            if (event instanceof CorruptEventRowError) {
              const owner = state.owners.get(aggregate)
              if (owner?.member !== undefined && EVIDENCE_FACT_TYPE_NAMES.includes(event.row.type)) state.evidence = updateEvidence(state.evidence, owner.member, { position: event.position })
              if (BUDGET_FACT_TYPE_NAMES.includes(event.row.type)) state.usageFailure ??= event
              if (TOOL_FACT_TYPE_NAMES.includes(event.row.type) && owner?.tools) state.toolFailure ??= event
            } else {
              try {
                reduceWorkflowMembers(state, event, id)
              } catch (error) {
                if (!(error instanceof InvariantViolation)) throw error
                state.usageFailure ??= error
              }
            }
            if (state.usageFailure) moved.delete(id)
            else if (!isDeepStrictEqual(state.policy, beforePolicy) || !isDeepStrictEqual(state.display, beforeDisplay)) moved.add(id)
          }
        }
      }
      position = upper
    }
    const queue = createOrderedLane()
    return {
      read(id: string): Promise<WorkflowMemberState> {
        return queue.run(async () => {
          await advance()
          let result = workflows.get(id)
          if (!result) {
            result = await seedWorkflowMembers(reader, id, position)
            workflows.set(id, result)
            indexWorkflow(id, result)
          }
          return result
        })
      },
      held(id: string): Promise<WorkflowMemberState | undefined> {
        return queue.run(async () => {
          await advance()
          return workflows.get(id)
        })
      },
      moved(): Promise<readonly string[]> {
        return queue.run(async () => {
          await advance()
          const ids = [...moved]
          moved.clear()
          return ids
        })
      },
    }
  })
}

/** Folds every owner's facts through one captured position. Owners found
 *  after that position fold their later facts in the projection itself, so the
 *  membership reads may run ahead of it. */
async function seedWorkflowMembers(reader: AsyncEventReadSurface, workflowId: string, position: number): Promise<WorkflowMemberState> {
  const run = await workflowRunOwner().settings(reader).read(workflowId)
  const { members, all } = await workflowUsageSessions(reader, workflowId)
  const policyOwners = [durableOwnerAggregate({ kind: "workflow", workflowId }), ...(run?.historicalResidualAggregateId ? [run.historicalResidualAggregateId] : [])]
  const state: WorkflowMemberState = { owners: new Map(), parents: new Set([workflowId, ...all]), policy: ZERO_USAGE, display: ZERO_USAGE, toolCount: 0, durations: new Map(), durationsVersion: ++durationsVersions, memberCount: 0 }
  const owners = [
    ...policyOwners.map(aggregateId => ({ aggregateId, policy: true, session: false })),
    ...[...all].map(sessionId => ({ aggregateId: `session:${sessionId}`, policy: members.has(sessionId), session: true })),
  ]
  for (const { aggregateId, policy, session } of owners) {
    const member = session && policy ? ++state.memberCount : undefined
    state.owners.set(aggregateId, { policy, member, budget: initialBudgetProjectionState(), ...(session ? { tools: initialToolCallCount() } : {}) })
  }
  // Stored rows never change, so an unreadable budget row marks this workflow's
  // usage unknown for good instead of failing the shared owner's advance.
  try {
    for await (const fact of capturedFacts(reader, { aggregateIds: [...state.owners.keys()], types: BUDGET_FACT_TYPES }, { upperPosition: position })) {
      // SAFETY: the query filters by these owners' aggregate ids, so each fact has an owner.
      const owner = state.owners.get(fact.aggregateId)!
      state.owners.set(fact.aggregateId, { ...owner, budget: reduceBudgetEvent(owner.budget, fact) })
    }
  } catch (error) {
    if (!(error instanceof CorruptEventRowError || error instanceof InvariantViolation)) throw error
    state.usageFailure = error
  }
  await seedMemberActivity(reader, state, position)
  for (const owner of state.owners.values()) {
    addOwnerUsage(state, owner.policy, owner.budget, 1)
    state.toolCount += owner.tools?.topLevel ?? 0
  }
  return state
}

/** Tool damage stops only that owner's tool fold. Evidence still takes its
 * latest row, including damage, as in the descending limit-one reader. */
async function seedMemberActivity(reader: AsyncEventReadSurface, state: WorkflowMemberState, position: number): Promise<void> {
  const aggregateIds = [...state.owners].filter(([, owner]) => owner.tools).map(([aggregateId]) => aggregateId)
  const types = [...new Set([...TOOL_EXECUTION_FACT_TYPES, ...EPISODE_EVIDENCE_FACT_TYPES, ...SESSION_DURATION_FACT_TYPES])]
  const failures = new Map<string, Error>()
  let after = 0
  while (after < position) {
    const page = await reader.readPage({ aggregateIds, types }, position, after, true, "deferred")
    for (const fact of page.facts) {
      const aggregateId = fact instanceof CorruptEventRowError ? fact.row.aggregateId : fact.aggregateId
      const type = fact instanceof CorruptEventRowError ? fact.row.type : fact.type
      // SAFETY: the query filters by these owners' aggregate ids, so each fact has an owner.
      const owner = state.owners.get(aggregateId)!
      if (owner.member !== undefined && EVIDENCE_FACT_TYPE_NAMES.includes(type)) {
        state.evidence = updateEvidence(state.evidence, owner.member, fact instanceof CorruptEventRowError ? { position: fact.position } : { position: fact.position, timestamp: fact.timestamp })
      }
      if (!(fact instanceof CorruptEventRowError)) recordDuration(state, owner, fact)
      if (!TOOL_FACT_TYPE_NAMES.includes(type) || failures.has(aggregateId)) continue
      try {
        // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
        if (fact instanceof CorruptEventRowError) throw fact
        // SAFETY: the query reads only owners that count tools.
        countToolCall(owner.tools!, fact)
      } catch (error) {
        if (!(error instanceof InvariantViolation || error instanceof CorruptEventRowError)) throw error
        failures.set(aggregateId, error)
      }
    }
    if (page.continuationPosition === null) break
    after = page.continuationPosition
    await yieldToNextTask()
  }
  for (const aggregateId of aggregateIds) state.toolFailure ??= failures.get(aggregateId)
}

function updateEvidence(tree: MemberEvidenceTree | undefined, slot: number, row: NonNullable<MemberEvidenceTree["row"]>): MemberEvidenceTree {
  let { row: own, left, right } = tree ?? {}
  if (slot === 1) own = row
  else if (slot % 2 === 0) left = updateEvidence(left, slot / 2, row)
  else right = updateEvidence(right, Math.floor(slot / 2), row)
  const readable = own?.timestamp === undefined ? undefined : own
  const maximum = laterTimestamp(laterTimestamp(readable, left?.maximum), right?.maximum)
  return { row: own, left, right, maximum }
}

function laterTimestamp(a: MemberEvidence | undefined, b: MemberEvidence | undefined): MemberEvidence | undefined {
  return !a || (b && b.timestamp > a.timestamp) ? b : a
}

function reduceWorkflowMembers(state: WorkflowMemberState, event: StoredFact, workflowId: string): WorkflowMemberState {
  switch (event.type) {
    case "session.created": {
      if (state.owners.has(event.aggregateId)) return state
      const session = reduceSessionMetadataEvent({ sessions: {}, deleted: {}, errors: {} }, event).sessions[event.sessionId]
      if (!session) return state
      const member = session.kind === "workflow-agent" && session.workflowMembership.workflowId === workflowId
      const descendant = session.kind !== "chat" && session.launchedFrom !== undefined && state.parents.has(session.launchedFrom.parentSessionId)
      if (!member && !descendant) return state
      state.owners.set(event.aggregateId, { policy: member, member: member ? ++state.memberCount : undefined, budget: initialBudgetProjectionState(), tools: initialToolCallCount() })
      state.parents.add(event.sessionId)
      return state
    }
  }
  const owner = state.owners.get(event.aggregateId)
  if (!owner) return state
  if (owner.member !== undefined && EVIDENCE_FACT_TYPE_NAMES.includes(event.type)) state.evidence = updateEvidence(state.evidence, owner.member, { position: event.position, timestamp: event.timestamp })
  if (recordDuration(state, owner, event)) return state
  if (TOOL_FACT_TYPE_NAMES.includes(event.type)) {
    if (owner.tools) countOwnerToolCall(state, owner.tools, event)
    return state
  }
  if (!BUDGET_FACT_TYPE_NAMES.includes(event.type)) return state
  const budget = reduceBudgetEvent(owner.budget, event)
  if (budget === owner.budget) return state
  addOwnerUsage(state, owner.policy, owner.budget, -1)
  addOwnerUsage(state, owner.policy, budget, 1)
  state.owners.set(event.aggregateId, { ...owner, budget })
  return state
}

/** Keeps a direct member's recorded active time from its newest duration
 *  fact. Returns whether `event` is a duration fact. A duration row that
 *  this build cannot read keeps the time the member recorded before it, and
 *  never makes the workflow's usage unknown. */
function recordDuration(state: WorkflowMemberState, owner: MemberOwner, event: StoredFact): boolean {
  if (!DURATION_FACT_TYPE_NAMES.includes(event.type)) return false
  if (owner.member === undefined) return true
  const sessionId = event.aggregateId.slice("session:".length)
  let accumulatedActiveMs: number
  try {
    ({ accumulatedActiveMs } = reduceSessionDurationEvent({ accumulatedActiveMs: 0 }, event))
  } catch (error) {
    if (!(error instanceof InvariantViolation)) throw error
    unreadableDurations.observe(sessionId, { position: event.position, version: event.version })
    return true
  }
  if (state.durations.get(sessionId) === accumulatedActiveMs) return true
  state.durations.set(sessionId, accumulatedActiveMs)
  state.durationsVersion = ++durationsVersions
  return true
}

function countOwnerToolCall(state: WorkflowMemberState, tools: ToolCallCount, event: StoredFact): void {
  const before = tools.topLevel
  try {
    countToolCall(tools, event)
  } catch (error) {
    if (!(error instanceof InvariantViolation)) throw error
    state.toolFailure ??= error
    return
  }
  state.toolCount += tools.topLevel - before
}

/** Adds (`sign` 1) or removes (`sign` -1) one owner's usage. A price that was
 *  unavailable once stays unavailable for that owner, so the flag only joins. */
function addOwnerUsage(state: WorkflowMemberState, policy: boolean, usage: WorkflowUsageTotals, sign: 1 | -1): void {
  state.display = addUsage(state.display, usage, sign)
  if (policy) state.policy = addUsage(state.policy, usage, sign)
}

function addUsage(a: WorkflowUsageTotals, b: WorkflowUsageTotals, sign: 1 | -1): WorkflowUsageTotals {
  return {
    totalCost: a.totalCost + sign * b.totalCost,
    totalBilledCost: a.totalBilledCost + sign * b.totalBilledCost,
    priceUnavailable: a.priceUnavailable || b.priceUnavailable,
    totalInputTokens: a.totalInputTokens + sign * b.totalInputTokens,
    totalOutputTokens: a.totalOutputTokens + sign * b.totalOutputTokens,
    unmeasuredRequests: a.unmeasuredRequests + sign * b.unmeasuredRequests,
  }
}
