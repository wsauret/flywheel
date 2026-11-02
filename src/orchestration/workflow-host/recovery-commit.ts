import { isDeepStrictEqual } from "node:util"
import { requireGuardedEventAppender, type AsyncEventStateReadSurface, type AsyncEventWriter, type GuardedEventStoreAppend } from "../../infra/event-store-types.js"
import type { CommittedWorkflowControl } from "../../workflows/vm/committed-control.js"
import { readWorkflowRecoveryEvidence, type WorkflowRecoveryEvidence } from "../../workflows/vm/recovery-fold.js"
import { recoverWorkflowContext, type RecoveredWorkflowContext } from "../../workflows/context-bundle/context-recovery.js"
import { buildContextInputSeededFact } from "../../workflows/context-bundle/context-facts.js"
import { readPristineWorkflowLaunch } from "../../workflows/view/launch-recovery.js"
import { queueFactsForState } from "../../workflows/view/view-diff.js"
import { flattenWorkflowView } from "../../workflows/vm/view-flatten.js"
import type { ResolvedAgent } from "../../workflows/agent-resolution.js"
import { workflowRunReader } from "../module-catalog.js"
import { describeWorkflowRecoveryDegradation, workflowRecoveryBasis } from "../../workflows/vm/recovery.js"
import {
  buildWorkflowControlRecoveredFact,
  workflowAggregateId,
  type WorkflowRecoveryDegradationReason,
} from "../../workflows/vm/session-facts.js"
import type { WorkflowInputValue } from "../../workflows/output-contract/compile.js"

export interface WorkflowRecoveryCommitInput {
  readonly sessionId: string
  readonly timestamp: string
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly runtimeIdentity: () => Promise<{ readonly version: string; readonly buildId: string }>
  /** Resolve the agent records and the control basis. With no proved prefix it
   *  compiles the launch again, with the structured input that the launch
   *  recorded, or null for a launch without input. */
  readonly prepare: (basis: CommittedWorkflowControl | null, launchInput: WorkflowInputValue | null) => Promise<{
    readonly control: CommittedWorkflowControl
    readonly resolvedAgents: ReadonlyMap<string, ResolvedAgent>
  }>
}

export type WorkflowRecoveryCommitResult =
  | { readonly kind: "committed" }
  | { readonly kind: "already_recovered" }
  | { readonly kind: "unrecoverable"; readonly message: string }
  | { readonly kind: "conflict" }

type DegradationReasons = readonly [WorkflowRecoveryDegradationReason, ...WorkflowRecoveryDegradationReason[]]

/** What a Restart can do with a session's durable workflow state. Resume,
 * the row's admission, and Restart itself read this one classification, so
 * a row offers Restart only when Restart can run the workflow again. */
export type WorkflowRecoveryAssessment =
  | { readonly kind: "executable" }
  | { readonly kind: "unrecoverable"; readonly reasons: DegradationReasons; readonly message: string }
  | {
    readonly kind: "recoverable"
    readonly reasons: DegradationReasons
    readonly context: RecoveredWorkflowContext
    readonly request: string
    /** The proved committed control, or null for a launch that never ran. */
    readonly prefix: CommittedWorkflowControl | null
    readonly pristine: ReturnType<typeof readPristineWorkflowLaunch>
  }

/** Classify durable workflow state for recovery. Recovery needs the original
 * request and either a proved committed prefix or a launch that never ran. */
export async function assessWorkflowRecovery(reader: AsyncEventStateReadSurface, sessionId: string): Promise<WorkflowRecoveryAssessment> {
  const evidence = await readWorkflowRecoveryEvidence(reader, sessionId)
  const { plan } = evidence.classification
  if (plan.executable) return { kind: "executable" }
  let cached = recoveryAssessments.get(evidence.assessmentIdentity)
  if (!cached) {
    const pending = assessRecoveryEvidence(reader, sessionId, evidence)
    cached = { pending, planReasons: plan.reasons.length }
    recoveryAssessments.set(evidence.assessmentIdentity, cached)
    void pending.catch(() => recoveryAssessments.delete(evidence.assessmentIdentity))
  }
  const assessment = await cached.pending
  if (assessment.kind === "executable") return assessment
  const [firstReason, ...otherReasons] = plan.reasons
  if (!firstReason) throw new Error("Recovery plan has no degradation reason")
  const reasons: DegradationReasons = [firstReason, ...otherReasons, ...assessment.reasons.slice(cached.planReasons)]
  // Valid settings-only updates retain the assessment, but its proved prefix
  // must still name the sequence used by a subsequent Restart. A root's
  // pruned companion tail can put its validated sequence beyond retained rows.
  return assessment.kind === "recoverable"
    ? { ...assessment, reasons, prefix: assessment.prefix ? { ...assessment.prefix, aggregateSeq: Math.max(assessment.prefix.aggregateSeq, evidence.aggregateSeq) } : null }
    : { ...assessment, reasons }
}

const recoveryAssessments = new WeakMap<object, { pending: Promise<WorkflowRecoveryAssessment>; planReasons: number }>()

/** A degraded workflow is paused, so its one full read happens once per
 * assessment identity, never per commit. */
async function assessRecoveryEvidence(reader: AsyncEventStateReadSurface, sessionId: string, evidence: WorkflowRecoveryEvidence): Promise<WorkflowRecoveryAssessment> {
  const { classification: { plan } } = evidence
  if (plan.kind === "executable") return { kind: "executable" }
  const { facts } = await reader.readSlice({ aggregateId: workflowAggregateId(sessionId) }, true)
  const [firstReason, ...otherReasons] = plan.reasons
  if (!firstReason) throw new Error("Recovery plan has no degradation reason")
  const context = recoverWorkflowContext(facts)
  const reasons: DegradationReasons = [firstReason, ...otherReasons, ...context.reasons]
  const unrecoverable = (cause: string): WorkflowRecoveryAssessment => ({
    kind: "unrecoverable",
    reasons,
    message: `${describeWorkflowRecoveryDegradation(firstReason)} The workflow remains paused because ${cause}, so Restart cannot run it again.`,
  })
  const prefix = workflowRecoveryBasis(facts)
  const pristine = prefix === null ? readPristineWorkflowLaunch(facts) : null
  const request = context.seed?.fact.payload.userRequest ?? await workflowRunReader(reader).readCreationRequest(sessionId)
  if (request === null) return unrecoverable("the original workflow request is unreadable")
  if (prefix === null && pristine === null) return unrecoverable("its committed work cannot be proved")
  return { kind: "recoverable", reasons, context, request, prefix, pristine }
}

/** Atomically publish canonical recovered control for a person's explicit
 * Restart. Operator text that a build before 2026-10 retained for the
 * recovery stays in its workflow-targeted queued-input cell. A conflict
 * discards preparation; the controller owns candidate rebuild. Unprovable
 * work remains paused without publication. */
export async function commitWorkflowRecovery(input: WorkflowRecoveryCommitInput): Promise<WorkflowRecoveryCommitResult> {
  const expectedSeq = await input.reader.aggregateSeq(workflowAggregateId(input.sessionId)) + 1
  const assessment = await assessWorkflowRecovery(input.reader, input.sessionId)
  if (assessment.kind === "executable") return { kind: "already_recovered" }
  if (assessment.kind === "unrecoverable") return { kind: "unrecoverable", message: assessment.message }
  const { reasons: degradationReasons, context, request, prefix, pristine } = assessment
  const seed = context.seed?.fact
  const prepared = await input.prepare(prefix, seed?.version === 2 ? seed.payload.input : null)
  const basis = prefix ?? prepared.control
  // The tree restates this control; the retained launch companion holds rows.
  const { tree: _tree, ...launchRows } = flattenWorkflowView(basis, prepared.resolvedAgents)
  if (pristine?.queue && !isDeepStrictEqual(pristine.queue, launchRows)) {
    return { kind: "unrecoverable", message: "The retained launch queue does not match the original workflow. The workflow remains paused." }
  }
  const appends = buildWorkflowRecoveryBootstrap({
    sessionId: input.sessionId, expectedSeq, basis, resolvedAgents: prepared.resolvedAgents, context, request,
    degradationReasons, runtimeIdentity: await input.runtimeIdentity(), timestamp: Date.parse(input.timestamp),
  })
  const result = await requireGuardedEventAppender(input.writer, "Workflow recovery requires guarded append authority").appendBatchGuarded(appends)
  return result.kind === "stored" ? { kind: "committed" } : { kind: "conflict" }
}

/** Build a strict bootstrap without applying VM transitions or selecting work. */
function buildWorkflowRecoveryBootstrap(input: {
  sessionId: string
  expectedSeq: number
  basis: CommittedWorkflowControl
  resolvedAgents: ReadonlyMap<string, ResolvedAgent>
  context: RecoveredWorkflowContext
  request: string
  degradationReasons: DegradationReasons
  runtimeIdentity: { readonly version: string; readonly buildId: string }
  timestamp: number
}): GuardedEventStoreAppend[] {
  const { basis, expectedSeq, context } = input
  const seed = context.seed ?? {
    fact: buildContextInputSeededFact(basis.definitionIdentity.workflowDefinitionId, input.request),
    timestamp: input.timestamp,
  }
  const companions = [
    seed,
    ...context.records,
    ...queueFactsForState(null, flattenWorkflowView(basis, input.resolvedAgents)).map((fact) => ({ fact, timestamp: input.timestamp })),
  ]
  const control = { ...basis, aggregateSeq: expectedSeq + 1 + companions.length }
  // The root names one recovered attempt: the first that ran, in graph
  // order. Every running attempt is in its control.
  const running = basis.attempts.find(({ state }) => state._tag === "running")
  const conversationId = running?.conversationId ?? basis.followUp?.conversationId
  const root = buildWorkflowControlRecoveredFact({
    supersededThroughSeq: Math.max(expectedSeq - 1, 0),
    degradationReasons: input.degradationReasons,
    runtimeIdentity: input.runtimeIdentity,
    identities: {
      workflow: { source: "recovered", value: basis.definitionIdentity.workflowDefinitionId },
      step: running ? { source: "recovered", value: running.logicalNodeId } : null, // stored payload key
      attempt: running ? { source: "recovered", value: running.id } : null,
      conversation: conversationId ? { source: "recovered", value: conversationId } : null,
    },
    control,
  })
  return [{ fact: root, timestamp: input.timestamp }, ...companions].map(({ fact, timestamp }, index) => ({
    aggregateId: workflowAggregateId(input.sessionId), sessionId: input.sessionId,
    timestamp, ...fact,
    ...(index === 0 ? { expectedSeq } : {}),
  }))
}
