import { isDeepStrictEqual } from "node:util"
import { createEventProjection } from "../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { heldProjection, pinHeldProjection, releaseHeldProjection } from "../../infra/projection-registry.js"
import type { ContentResolver } from "../../infra/tool-content.js"
import { parseWorkflowRunFact } from "../run-facts.js"
import { recoverWorkflowContext } from "../context-bundle/context-recovery.js"
import type { DefinitionDriftRejectedPayload } from "../definition-provenance-facts.js"
import { foldQueueFacts, queueFromProjection, type QueueProjectionState } from "../view/view-projection.js"
import { selectNewestWorkflowRoot, WORKFLOW_ROOT_FACT_TYPES, workflowFamilyEvents } from "../workflow-root.js"
import { matchingIdentities, validateWorkflowBootstrap } from "./bootstrap-validation.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import { controlledActivity, observedActivity, seedControlActivity, type WorkflowControlActivity } from "./control-activity.js"
import { advanceRetryEvidence, NO_RETRY_EVIDENCE, replayWorkflowControl, replayWorkflowControlFrom, resumesFailedAgents, resumesFailedAgentsWith, type FailedAgentRetryEvidence } from "./fact-fold.js"
import { advanceDefinitionDriftRejection, currentDefinitionDriftRejection, type WorkflowRecoveryPlan } from "./recovery.js"
import { workflowAggregateId } from "./session-facts.js"

/** What a workflow's durable history says about running it: the recovery
 *  plan, whether a failed run resumes its failed agents, and the definition
 *  drift rejection that still holds. */
export interface WorkflowRecoveryClassification {
  readonly plan: WorkflowRecoveryPlan
  readonly retry: boolean
  readonly rejection: DefinitionDriftRejectedPayload | undefined
}

/** One workflow's classification, folded once and advanced by each later fact.
 *
 *  The validators read the whole history, and a reader that runs them on each
 *  change while 150 agents commit pays for the history on every commit. The
 *  fold keeps their intermediate states instead: control through the last
 *  proposal, the facts after it, the queue state, and the retry and drift
 *  evidence. Each part advances through the same reducer the validators use,
 *  so the two can never disagree. A history the fold cannot advance exactly,
 *  such as a new root, a migration, a damaged row, or a run that does not
 *  validate, settles on the validators' answer, and the next fact other than
 *  a settings update makes the fold stale so that its reader seeds it again. */
export type WorkflowRecoveryFold = AdvancingFold | SettledFold | StaleFold

interface AdvancingFold {
  readonly kind: "advancing"
  readonly rootSeq: number
  /** Control through the last proposal terminal or identity fact. */
  readonly control: CommittedWorkflowControl
  /** Every fact after `control`, in order. The next terminal folds them. */
  readonly segment: readonly StoredFact[]
  readonly queue: QueueProjectionState
  readonly retryEvidence: FailedAgentRetryEvidence
  readonly rejection: DefinitionDriftRejectedPayload | undefined
}

interface SettledFold {
  readonly kind: "settled"
  readonly classification: WorkflowRecoveryClassification
  /** Strict control, or why it does not replay. A plan paused for its queue
   *  or context still has one. */
  readonly control: CommittedWorkflowControl | Error
}

interface StaleFold {
  readonly kind: "stale"
}

const STALE: StaleFold = { kind: "stale" }
const SEGMENT_TERMINAL_TYPES: ReadonlySet<string> = new Set(["workflow.control.committed", "workflow.definition_identity.adopted"])
/** A fact whose fold depends on history that one segment does not carry. A
 *  migration's order is checked across every migration since the root. */
const RESEED_TYPES: ReadonlySet<string> = new Set([...WORKFLOW_ROOT_FACT_TYPES, "workflow.definition_identity.migrated"])

/** The validators' answer for the whole history. */
export function classifyWorkflowHistory(facts: readonly (StoredFact | CorruptEventRowError)[]): WorkflowRecoveryClassification {
  const plan = validateWorkflowBootstrap(facts)
  return {
    plan,
    retry: plan.executable && resumesFailedAgents(facts.filter((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError)), plan.control),
    rejection: currentDefinitionDriftRejection(facts),
  }
}

/** Classifies the whole history and keeps what later facts need to advance it. */
export function seedWorkflowRecoveryFold(facts: readonly (StoredFact | CorruptEventRowError)[]): WorkflowRecoveryFold {
  const classification = classifyWorkflowHistory(facts)
  const { plan } = classification
  const settled: SettledFold = { kind: "settled", classification, control: strictControl(facts, plan) }
  if (!plan.executable) return settled
  const stored = facts.filter((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError))
  if (stored.length !== facts.length) return settled
  const root = selectNewestWorkflowRoot(stored)
  const terminal = stored.findLastIndex(({ type }) => SEGMENT_TERMINAL_TYPES.has(type))
  if (!root || terminal <= root.index) return settled
  try {
    const family = workflowFamilyEvents(stored)
    const advancing: AdvancingFold = {
      kind: "advancing",
      rootSeq: plan.rootSeq,
      control: replayWorkflowControl(stored.slice(0, terminal + 1)),
      segment: stored.slice(terminal + 1),
      queue: foldQueueFacts(family),
      retryEvidence: family.reduce(advanceRetryEvidence, NO_RETRY_EVIDENCE),
      rejection: classification.rejection,
    }
    // The fold must start where the validators stand, or no later fact can
    // advance it exactly. A history the split cannot reproduce stays settled.
    return isDeepStrictEqual(classifyWorkflowRecoveryFold(advancing), classification) ? advancing : settled
  } catch {
    return settled
  }
}

/** Advances the fold by the next fact of the workflow aggregate. */
export function advanceWorkflowRecoveryFold(fold: WorkflowRecoveryFold, fact: StoredFact): WorkflowRecoveryFold {
  if (fold.kind === "settled" && validSettingsUpdate(fact)) {
    const { classification } = fold
    const { plan } = classification
    // Settings change only control's sequence. They cannot repair or damage
    // queue/context evidence, but an invalid suffix still names its latest seq.
    const next = plan.executable
      ? { ...plan, control: replayWorkflowControlFrom(plan.control, [fact]) }
      : { ...plan, reasons: plan.reasons.map(reason => reason.kind === "invalid_suffix" ? { ...reason, seq: fact.seq } : reason) }
    const control = fold.control instanceof Error ? fold.control : replayWorkflowControlFrom(fold.control, [fact])
    return { kind: "settled", control, classification: { ...classification, plan: next } }
  }
  if (fold.kind !== "advancing" || RESEED_TYPES.has(fact.type)) return STALE
  // Context validation reads only the current epoch's context facts, and a
  // seeded fold already proved the earlier ones and its input seed.
  if (recoverWorkflowContext([fact]).reasons.length > 0) return STALE
  const evidence = {
    queue: foldQueueFacts([fact], fold.queue),
    retryEvidence: advanceRetryEvidence(fold.retryEvidence, fact),
    rejection: advanceDefinitionDriftRejection(fold.rejection, fact),
  }
  const segment = [...fold.segment, fact]
  if (!SEGMENT_TERMINAL_TYPES.has(fact.type)) return { ...fold, ...evidence, segment }
  try {
    return { ...fold, ...evidence, control: replayWorkflowControlFrom(fold.control, segment), segment: [] }
  } catch {
    return STALE
  }
}

/** The classification the fold holds, or null when only the whole history can say. */
export function classifyWorkflowRecoveryFold(fold: WorkflowRecoveryFold): WorkflowRecoveryClassification | null {
  if (fold.kind === "stale") return null
  if (fold.kind === "settled") return fold.classification
  // A tree before version 4 rebuilds from the whole history, so only a current tree classifies here.
  if (fold.queue.tree?.version !== 4) return null
  try {
    const control = currentControl(fold)
    const queue = queueFromProjection(fold.queue)
    if (!queue || !matchingIdentities(control, queue)) return null
    return {
      plan: { kind: "executable", executable: true, control, rootSeq: fold.rootSeq },
      retry: resumesFailedAgentsWith(fold.retryEvidence, control),
      rejection: fold.rejection,
    }
  } catch {
    return null
  }
}

/** Control through the newest fact. The segment after a proposal terminal
 *  holds only companions, which advance the sequence without a decode. */
function currentControl(fold: AdvancingFold): CommittedWorkflowControl {
  return fold.segment.length === 0 ? fold.control : replayWorkflowControlFrom(fold.control, fold.segment)
}

/** The strict control of a whole history, or why it does not replay. A
 *  damaged row fails it, as a strict read of the history fails, even where
 *  recovery can still execute the run. */
function strictControl(facts: readonly (StoredFact | CorruptEventRowError)[], plan: WorkflowRecoveryPlan): CommittedWorkflowControl | Error {
  const damaged = facts.find((fact) => fact instanceof CorruptEventRowError)
  if (damaged) return damaged
  if (plan.executable) return plan.control
  try {
    return replayWorkflowControl(facts)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** Strict committed control: control authority, not the stronger execution
 *  admission check that `readWorkflowRecoveryEvidence` answers. It reads the
 *  recovery owner, so each proposal's control decodes once however many
 *  readers ask. Throws when strict control does not replay or a row of the
 *  workflow is damaged. */
export async function readWorkflowControl(reader: AsyncEventStateReadSurface, workflowId: string): Promise<CommittedWorkflowControl> {
  return seededControl(await replaySeeded(reader, workflowId))
}

/** The classification of one workflow's committed history, advanced from its held evidence. */
export async function readWorkflowRecovery(reader: AsyncEventStateReadSurface, workflowId: string): Promise<WorkflowRecoveryClassification> {
  return (await readWorkflowRecoveryEvidence(reader, workflowId)).classification
}

export interface WorkflowRecoveryEvidence {
  readonly classification: WorkflowRecoveryClassification
  /** Settings-only updates retain this identity for recovery assessment reuse. */
  readonly assessmentIdentity: object
  readonly aggregateSeq: number
}

interface RecoveryState {
  readonly fold: WorkflowRecoveryFold
  /** Undefined once the fold is stale, until the next seed. */
  readonly activity: WorkflowControlActivity | undefined
  readonly assessmentIdentity: object
  readonly aggregateSeq: number
}

/** A held state that needs no seed. A fold is stale exactly when its
 *  activity is undefined, and both hold until the next seed. */
interface SeededState extends RecoveryState {
  readonly fold: AdvancingFold | SettledFold
  readonly activity: WorkflowControlActivity
}

function isSeeded(state: RecoveryState): state is SeededState {
  return state.fold.kind !== "stale" && state.activity !== undefined
}

/** One replay of the held state, seeded again from the whole history while
 *  it is stale, so that control and activity come from the same state. */
async function replaySeeded(reader: AsyncEventStateReadSurface, workflowId: string): Promise<SeededState> {
  const key = recoveryKey(workflowId)
  for (;;) {
    const state = await workflowRecoveryProjection(reader, key, workflowId).replay()
    if (isSeeded(state)) return state
    releaseHeldProjection(reader, key)
  }
}

/** Strict control of a seeded state. Throws when it does not replay or a row is damaged. */
function seededControl({ fold }: SeededState): CommittedWorkflowControl {
  if (fold.kind === "advancing") return currentControl(fold)
  if (fold.control instanceof Error) throw fold.control
  return fold.control
}

/** Recovery and admission share one advancing evidence owner. It holds the
 * fold, not the facts: a history that only the validators can classify, such
 * as a new root, a migration, or a damaged row, seeds the owner again from one
 * tolerant read. Those facts are rare, so ordinary commits only advance. */
export async function readWorkflowRecoveryEvidence(reader: AsyncEventStateReadSurface, workflowId: string): Promise<WorkflowRecoveryEvidence> {
  const key = recoveryKey(workflowId)
  for (;;) {
    const state = await workflowRecoveryProjection(reader, key, workflowId).replay()
    const classification = classifyWorkflowRecoveryFold(state.fold)
    if (classification) return { classification, assessmentIdentity: state.assessmentIdentity, aggregateSeq: state.aggregateSeq }
    releaseHeldProjection(reader, key)
  }
}

/** When the workflow's control was active, advanced from the same control
 *  transitions that classify its recovery, so a commit's transition runs once
 *  however many readers measure it. */
export async function readWorkflowControlActivity(reader: AsyncEventStateReadSurface, workflowId: string): Promise<WorkflowControlActivity> {
  return (await replaySeeded(reader, workflowId)).activity
}

/** One workflow's strict control and its control activity, read together. */
export interface WorkflowControlEvidence {
  readonly control: CommittedWorkflowControl
  readonly activity: WorkflowControlActivity
}

/** Strict control and activity of each distinct workflow, from one durable
 *  request for every workflow the recovery owner has already folded. A
 *  workflow seen for the first time seeds its own fold, and a fold that only
 *  the whole history can classify seeds again through the single-workflow
 *  readers. Each workflow's key stays pinned during the call, so a batch
 *  larger than the held bound never evicts its own folds. A workflow maps
 *  to undefined when its strict control does not replay, a row of it is
 *  damaged, or a state request fails; the next call reads it again. */
export async function readWorkflowControls(reader: AsyncEventStateReadSurface, workflowIds: readonly string[]): Promise<ReadonlyMap<string, WorkflowControlEvidence | undefined>> {
  const ids = [...new Set(workflowIds)]
  const releases = ids.map((id) => pinHeldProjection(reader, recoveryKey(id)))
  try {
    const projections = ids.map((id) => ({ id, projection: workflowRecoveryProjection(reader, recoveryKey(id), id) }))
    const folded = projections.filter(({ projection }) => projection.getReadPosition() > 0)
    const unseen = projections.filter(({ projection }) => projection.getReadPosition() === 0)
    const [advanced, seeded] = await Promise.all([
      advanceTogether(reader, folded.map(({ id, projection }) => ({ aggregateId: workflowAggregateId(id), projection }))).catch(() => undefined),
      Promise.all(unseen.map(({ projection }) => projection.replay().catch(() => undefined))),
    ])
    const states = new Map<string, RecoveryState | undefined>([
      ...folded.map(({ id }, index) => [id, advanced?.[index]] as const),
      ...unseen.map(({ id }, index) => [id, seeded[index]] as const),
    ])
    return new Map(await Promise.all(ids.map(async (id) => [id, await controlEvidence(reader, id, states.get(id))] as const)))
  } finally {
    for (const release of releases) release()
  }
}

type RecoveryProjection = ReturnType<typeof workflowRecoveryProjection>

interface AggregatePage {
  readonly facts: (StoredFact | CorruptEventRowError)[]
  readonly toolContent: ContentResolver
}

/** Advances every projection through one paged tolerant read of all their
 *  aggregates, from the lowest read position among them. A fold that fails
 *  leaves only its own workflow undefined. */
async function advanceTogether(reader: AsyncEventStateReadSurface, members: readonly { aggregateId: string; projection: RecoveryProjection }[]): Promise<(RecoveryState | undefined)[]> {
  if (members.length === 0) return []
  const pages = new Map<string, AggregatePage[]>(members.map(({ aggregateId }) => [aggregateId, []]))
  let afterPosition = Math.min(...members.map(({ projection }) => projection.getReadPosition()))
  let upperPosition: number | undefined
  for (;;) {
    const page = await reader.readPage({ aggregateIds: members.map(({ aggregateId }) => aggregateId) }, upperPosition, afterPosition, true, "deferred")
    upperPosition = page.upperPosition
    const byAggregate = new Map<string, (StoredFact | CorruptEventRowError)[]>()
    for (const fact of page.facts) {
      const aggregateId = fact instanceof CorruptEventRowError ? fact.row.aggregateId : fact.aggregateId
      const facts = byAggregate.get(aggregateId) ?? []
      facts.push(fact)
      byAggregate.set(aggregateId, facts)
    }
    for (const [aggregateId, facts] of byAggregate) pages.get(aggregateId)?.push({ facts, toolContent: page.toolContent })
    if (page.continuationPosition === null) break
    afterPosition = page.continuationPosition
  }
  const ceiling = upperPosition
  return Promise.all(members.map(({ aggregateId, projection }) => projection.foldRead(pages.get(aggregateId) ?? [], ceiling).catch(() => undefined)))
}

/** The evidence a held state supplies, or that of one state seeded again
 *  from the whole history when the held state is stale. Any failure leaves
 *  only this workflow undefined. */
async function controlEvidence(reader: AsyncEventStateReadSurface, workflowId: string, state: RecoveryState | undefined): Promise<WorkflowControlEvidence | undefined> {
  if (!state) return undefined
  try {
    const seeded = isSeeded(state) ? state : await replaySeeded(reader, workflowId)
    return { control: seededControl(seeded), activity: seeded.activity }
  } catch {
    return undefined
  }
}

function recoveryKey(workflowId: string): string {
  return `workflow-recovery:${workflowId}`
}

/** The activity after `fact`. A proposal terminal that the fold advanced
 *  through supplies its control; any other fact only becomes the newest
 *  evidence. A stale fold supplies nothing, and the next seed folds the
 *  activity again from the whole history. */
function advancedActivity(state: RecoveryState, fold: WorkflowRecoveryFold, fact: StoredFact): WorkflowControlActivity | undefined {
  if (!state.activity || fold.kind === "stale") return undefined
  const observed = observedActivity(state.activity, fact)
  return fold.kind === "advancing" && SEGMENT_TERMINAL_TYPES.has(fact.type) ? controlledActivity(observed, fact, fold.control) : observed
}

function validSettingsUpdate(fact: StoredFact): boolean {
  if (fact.type !== "workflow.run.settings.updated") return false
  try {
    return parseWorkflowRunFact({ type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload }).type === fact.type
  } catch {
    return false
  }
}

function workflowRecoveryProjection(reader: AsyncEventStateReadSurface, key: string, workflowId: string) {
  const aggregateId = workflowAggregateId(workflowId)
  return heldProjection(reader, key, () => createEventProjection<RecoveryState>(reader, {
    name: key,
    aggregateId,
    // A damaged row reseeds the fold instead of failing the read.
    tolerateScopedCorruption: true,
    initialState: () => ({ fold: STALE, activity: undefined, assessmentIdentity: {}, aggregateSeq: 0 }),
    seed: async () => {
      const position = await reader.capturePosition()
      const { facts } = await reader.readSlice({ aggregateId, beforePosition: position + 1 }, true)
      const last = facts.at(-1)
      return { state: { fold: seedWorkflowRecoveryFold(facts), activity: seedControlActivity(facts), assessmentIdentity: {}, aggregateSeq: last ? (last instanceof CorruptEventRowError ? last.row.seq : last.seq) + 1 : 0 }, position }
    },
    reduce: (state, fact) => {
      const fold = advanceWorkflowRecoveryFold(state.fold, fact)
      return {
        fold,
        activity: advancedActivity(state, fold, fact),
        assessmentIdentity: validSettingsUpdate(fact) ? state.assessmentIdentity : {},
        aggregateSeq: fact.seq + 1,
      }
    },
    reduceCorruptRow: (_state, row) => ({ fold: STALE, activity: undefined, assessmentIdentity: {}, aggregateSeq: row.row.seq + 1 }),
  }))
}
