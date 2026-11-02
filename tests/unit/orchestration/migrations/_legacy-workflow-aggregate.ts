/** The pre-unification workflow aggregate this suite migrates, and the readers
 *  its assertions use. The fixture is a module of its own because two things
 *  consume it: the identity-adoption suite and any later suite that needs a
 *  legacy aggregate staged the way a pre-catalog build staged one. */

import { Database } from "bun:sqlite"
import { Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import { parseLegacyStepRecord, type LegacyStepRecord } from "../../../../src/workflows/legacy-step-migration.js"
import type { SkillDefinition } from "../../../../src/workflows/skill-schema.js"
import type { RetiredBinding } from "../../../../src/workflows/retired-bindings.js"
import { legacyCaptureOf, legacyIdentityOf, type LegacyCapture } from "../../../../src/orchestration/modules/workflows/migrations/legacy-identity-view.js"
import { LEGACY_HANDOFF_CONTRACTS } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-step-content-pins.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import type { StepGrammarWorkflow } from "../../../../src/workflows/retired-step-grammar/schema.js"
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import { isLegacyDefinitionIdentity, type DefinitionIdentity, type LegacyDefinitionIdentity } from "../../../../src/workflows/vm/definition-identity.js"
import { retiredStepIdentity, retiredStepView } from "../../../../src/workflows/vm/retired-step-identity.js"
import { workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { testDirectories } from "../../../helpers/directories.js"
import { normalizeWorkflowControlV10 } from "../../../../src/workflows/vm/historical-normalization.js"
import { prePhaseControl, prePhaseHistory, type PrePhaseControl } from "./_pre-phase-control.js"

import { installedPersonaToolEntries } from "../../../../src/orchestration/tool-catalog.js"
import { retainedProject } from "../../../fixtures/retired-workflows/retained-project.js"
import { retiredFixtureWorkflow } from "../../../helpers/retired-fixture-briefs.js"
export const WORKFLOW_ID = "implement"
export const SPEC_CREATE_SKILL_ID = "fly.spec-create"
export const STEP_IDS = [SPEC_CREATE_SKILL_ID, "fly.spec-review", "fly.implement"] as const
export const BINDING_IDS = ["spec-create", "spec-review", "implement"] as const

export interface EventRow {
  position: number
  id: string
  aggregateId: string
  seq: number
  type: string
  version: number
  payload: string
}

export const processRoot = retainedProject({ legacyDebug: true, legacyRaindropAudit: true })
/** The directory authorities of a project that retained the retired workflow. */
export const processDirectories = testDirectories(processRoot)
const registries = new Map<string, ReturnType<typeof createProjectDefinitionRegistry>>()

function registryFor(projectRoot: string) {
  const cached = registries.get(projectRoot)
  if (cached) return cached
  const definitions = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(projectRoot), personaToolEntries: installedPersonaToolEntries() })
  registries.set(projectRoot, definitions)
  return definitions
}

function installedWorkflow(projectRoot: string, workflowId: string): WorkflowDefinition {
  return retiredFixtureWorkflow(registryFor(projectRoot).captureRevision(), workflowId, projectRoot)
}

export function boundSkills(projectRoot: string, workflowId: string): ReadonlyMap<string, ResolvedAgent> {
  return resolveWorkflowAgents(installedWorkflow(projectRoot, workflowId))
}

/** The step-grammar view of an installed workflow: what a build before
 *  phases loaded for it. */
function installedView(projectRoot: string, workflowId: string): StepGrammarWorkflow {
  const view = retiredStepView(installedWorkflow(projectRoot, workflowId))
  if (!view) throw new Error(`Test fixture needs a step-grammar view of workflow ${workflowId}`)
  return view
}

function legacyCapture(projectRoot: string, workflowId: string): LegacyCapture {
  const capture = legacyCaptureOf(installedView(projectRoot, workflowId))
  if (!capture) throw new Error(`Test fixture needs a pre-cutover view of workflow ${workflowId}`)
  return capture
}

/** One resolved step with the binding it replaced: what a pre-cutover build
 *  bound at that position. */
export interface LegacyBoundStep {
  readonly step: ResolvedAgent
  readonly binding: RetiredBinding
}

/** The binding each step of the workflow replaced, keyed by step id. */
export function legacyBindings(projectRoot: string, workflowId: string): ReadonlyMap<string, LegacyBoundStep> {
  const steps = boundSkills(projectRoot, workflowId)
  const bound = new Map<string, LegacyBoundStep>()
  for (const [stepId, binding] of legacyCapture(projectRoot, workflowId).bindings) {
    const step = steps.get(stepId)
    if (!step) throw new Error(`Test fixture needs step ${stepId}`)
    bound.set(stepId, { step, binding })
  }
  return bound
}

/** The step record a pre-cutover build recorded for one position. */
export function legacyRecordOf({ step, binding }: LegacyBoundStep, projectRoot = processRoot): LegacyStepRecord {
  return reconstructLegacyStepRecord(step, binding, registryFor(projectRoot).skills().skills.get(binding.skill))
}

/** What the migration reconstructs, keyed by the step id the legacy record
 *  carried. The fixture records these as its snapshots, so an adoption proves the
 *  reconstruction is stable rather than proving the mapping is right: the frozen
 *  record the suite asserts is what proves the mapping. */
export function legacyRecords(projectRoot: string, workflowId: string): ReadonlyMap<string, LegacyStepRecord> {
  const records = new Map<string, LegacyStepRecord>()
  for (const bound of legacyBindings(projectRoot, workflowId).values()) {
    records.set(bound.binding.skill, legacyRecordOf(bound, projectRoot))
  }
  return records
}

/** The identity evidence a pre-cutover build recorded that a current
 *  definition cannot recompute: each handoff contract at its last revision,
 *  and a hash for each former step skill, which left the catalog. */
function preCutoverEvidence(capture: LegacyCapture, vmVersion: string): LegacyDefinitionIdentity {
  return {
    workflowDefinitionId: "",
    graphSha256: capture.graphSha256,
    vmVersion,
    bindings: [],
    handoffRegistry: LEGACY_HANDOFF_CONTRACTS.map((pin) => ({ ...pin })),
    skills: [...capture.bindings.values()].map(({ skill }) => ({ skillId: skill, sha256: hashDefinition({ formerStepSkill: skill }).sha256 })),
    personas: [],
  }
}

/** Workflow control as the last pre-cutover build compiled it: the frozen
 *  graph and attempts of the last build before phases, under the identity
 *  that a pre-cutover build recorded for the current definition. */
export function compiledControl(projectRoot: string, workflowId: string): PrePhaseControl {
  const definitions = registryFor(projectRoot)
  const workflow = installedWorkflow(projectRoot, workflowId)
  const skills = definitions.skills()
  const revision = definitions.captureRevision()
  const current = retiredStepIdentity(installedView(projectRoot, workflowId), workflow, resolveWorkflowAgents(workflow), {
    skills,
    personas: revision.personas,
  })
  const capture = legacyCapture(projectRoot, workflowId)
  return prePhaseControl(workflowId, legacyIdentityOf(current, capture, preCutoverEvidence(capture, current.vmVersion), skills))
}

/** A recorded identity that must have the pre-cutover shape, as every
 *  identity these fixtures stage and the passes before the step-content
 *  migration adopt does. */
export function legacyIdentity(identity: DefinitionIdentity): LegacyDefinitionIdentity {
  if (!isLegacyDefinitionIdentity(identity)) throw new Error("Test fixture expected a pre-cutover identity")
  return identity
}

/** The identity every pass before the step-content migration adopts: the
 *  current definition in the shape the pre-cutover build recorded. */
export function preCutoverIdentity(workflowId: string): LegacyDefinitionIdentity {
  return legacyIdentity(compiledControl(processRoot, workflowId).definitionIdentity)
}

export interface SeedOptions {
  readonly projectRoot?: string
  readonly workflowId?: string
  /** Workflow id the identity records, when the project no longer installs it. */
  readonly recordedAs?: string
  readonly status?: "ready" | "paused"
  /** Omit the context identity members, as a pre-context-migration store does. */
  readonly omitContextMembers?: boolean
  readonly omitSnapshots?: boolean
  readonly rewriteSnapshot?: (record: LegacyStepRecord, stepId: string) => LegacyStepRecord
  readonly rewriteIdentityHash?: (sha256: string, stepId: string) => string
  /** Omit the handoff contract revision, as every identity before that member existed did. */
  readonly omitHandoffContractRevision?: boolean
  /** Record the queue and context companions of a run, under the recorded step
   *  ids a pre-unification build wrote. */
  readonly companions?: boolean
  /** Name every graph position and attempt by its step definition id, as a
   *  pre-unification compile did. */
  readonly legacyControlIds?: boolean
  /** Reproduce the retired graph field whose policy moved into bindings. */
  readonly legacyOverrides?: boolean
  /** Settle the first attempt and move the frontier on, as a paused aggregate
   *  that already did work records. */
  readonly settledFirstAttempt?: boolean
  /** Author an unconditional follow-up on the first position, which is the
   *  continuation a blocked attempt routes to. */
  readonly authoredFollowUp?: boolean
  /** Record the commits a run made after its launch, under the recorded step
   *  ids: the frozen `catalog` history, which needs `legacyControlIds` and
   *  `authoredFollowUp` and no other change to the control. */
  readonly controlHistory?: boolean
}

export interface SeededFact {
  readonly type: string
  readonly version: number
  readonly payload: EventPayload
}

/** Workflow control and step provenance as a pre-unification build staged them:
 *  one `definition.loaded` snapshot per compiled step, the run's queue and context
 *  companions, then initialized control whose identity hashes those step
 *  definitions. Every seeded row belongs to the initialization batch the recorded
 *  `aggregateSeq` names, which is what strict replay reads as one commit. A driven
 *  control history commits on top of that batch, and the control that the
 *  history commits is returned in the current shape, so a test can compare
 *  the frontier a resume folds against the frontier the run staged. */
export function seedLegacyAggregate(
  dbFile: string,
  sessionId: string,
  options: SeedOptions = {},
): CommittedWorkflowControl | null {
  const projectRoot = options.projectRoot ?? processRoot
  const workflowId = options.workflowId ?? WORKFLOW_ID
  const bindings = legacyBindings(projectRoot, workflowId)
  const compiled = compiledControl(projectRoot, workflowId)
  const withFollowUp = options.authoredFollowUp ? withAuthoredFollowUp(compiled) : compiled
  const withIds = options.legacyControlIds ? withLegacyControlIds(withFollowUp, bindings) : withFollowUp
  const withOverrides = options.legacyOverrides ? withLegacyOverrides(withIds) : withIds
  const control = options.settledFirstAttempt ? withSettledFirstAttempt(withOverrides) : withOverrides
  const steps = [...bindings.values()].map((bound) => {
    const record = legacyRecordOf(bound, projectRoot)
    return { stepId: bound.binding.skill, definition: options.rewriteSnapshot?.(record, bound.binding.skill) ?? record }
  })
  const { bindings: _replaced, skills, personas, ...rest } = legacyIdentity(compiled.definitionIdentity)
  const handoffRegistry = options.omitHandoffContractRevision
    ? rest.handoffRegistry.map(({ contractRevision: _contractRevision, ...entry }) => entry)
    : rest.handoffRegistry
  const identity = {
    ...rest,
    handoffRegistry,
    ...(options.omitContextMembers ? {} : { skills, personas }),
    workflowDefinitionId: options.recordedAs ?? workflowId,
    stepDefinitions: steps.map(({ stepId, definition }) => ({
      definitionId: stepId,
      sha256: options.rewriteIdentityHash?.(hashDefinition(definition).sha256, stepId) ?? hashDefinition(definition).sha256,
    })),
  }
  const snapshots: SeededFact[] = options.omitSnapshots ? [] : steps.flatMap(({ stepId, definition }) => [{
    type: "definition.loaded",
    version: 3,
    payload: {
      kind: "step",
      id: stepId,
      definition,
      provenance: { layer: "bundled", filePath: `src/workflows/steps/${stepId}.md`, id: stepId },
    },
  }, { type: "definition.hash_recorded", version: 1,
    payload: { kind: "step", id: stepId, ...hashDefinition(definition), format: "canonical-json-v1" } }])
  const companions = options.companions ? companionFacts(control, bindings, workflowId) : []
  const aggregateSeq = snapshots.length + companions.length + 1
  const status = options.status ?? control.status
  // The frozen history was driven from the control the row records, under its
  // recorded ids and sequence, so every batch is exactly what strict replay
  // recomputes.
  if (options.controlHistory && !(options.legacyControlIds && options.authoredFollowUp && !options.legacyOverrides && !options.settledFirstAttempt && status === "ready" && aggregateSeq === 7)) {
    throw new Error("The frozen catalog history holds the ready implement control with legacy ids and an authored follow-up only")
  }
  const history = options.controlHistory ? prePhaseHistory("catalog", compiled.definitionIdentity) : null
  const store = createSqliteEventStore(dbFile)
  try {
    for (const fact of [...snapshots, ...companions]) {
      store.append({
        aggregateId: workflowAggregateId(sessionId),
        type: fact.type,
        version: fact.version,
        timestamp: 1,
        actor: "flywheel",
        sessionId,
        payload: fact.payload,
      })
    }
    store.append({
      aggregateId: workflowAggregateId(sessionId),
      type: "workflow.control.initialized",
      version: 2,
      timestamp: 1,
      actor: "flywheel",
      sessionId,
      payload: { control: { ...control, issues: [], seals: [], definitionIdentity: identity, status, aggregateSeq } },
    })
    for (const fact of history?.facts ?? []) {
      store.append({
        aggregateId: workflowAggregateId(sessionId),
        type: fact.type,
        version: fact.version,
        timestamp: 1,
        actor: "flywheel",
        sessionId,
        payload: fact.payload,
      })
    }
  } finally {
    store.close()
  }
  return history === null ? null : normalizeWorkflowControlV10(history.final)
}

/** An unconditional follow-up on the first position. The core workflow authors
 *  none, and a block routes only to an authored continuation. */
export function withAuthoredFollowUp(control: PrePhaseControl): PrePhaseControl {
  const [first, second, ...rest] = control.graph.nodes
  if (first?.kind !== "step" || second?.kind !== "step") throw new Error("Test fixture needs two step positions")
  return {
    ...control,
    graph: {
      ...control.graph,
      nodes: [{ ...first, then: { step: second.definitionId, when: null, then: null } }, second, ...rest],
    },
  }
}

/** Control as a pre-unification build compiled it: every graph position, every
 *  follow-up, and every attempt is named by the step definition id the workflow
 *  referenced, which the unified catalog replaced with a workflow-local binding
 *  id. */
function withLegacyControlIds(control: PrePhaseControl, bindings: ReadonlyMap<string, LegacyBoundStep>): PrePhaseControl {
  const skillIdOf = (bindingId: string): string => {
    const skillId = bindings.get(bindingId)?.binding.skill
    if (!skillId) throw new Error(`Test fixture needs binding ${bindingId}`)
    return skillId
  }
  type FollowUp = { readonly step: string; readonly when: string | null; readonly then: FollowUp | null }
  const followUpWithSkillIds = (followUp: FollowUp | null): FollowUp | null =>
    followUp === null
      ? null
      : { ...followUp, step: skillIdOf(followUp.step), then: followUpWithSkillIds(followUp.then) }
  return {
    ...control,
    graph: {
      ...control.graph,
      nodes: control.graph.nodes.map((node) =>
        node.kind === "step"
          ? { ...node, definitionId: skillIdOf(node.definitionId), then: followUpWithSkillIds(node.then) }
          : node),
    },
    attempts: control.attempts.map((attempt) => ({ ...attempt, definitionId: skillIdOf(attempt.definitionId) })),
  }
}

function withLegacyOverrides(control: PrePhaseControl) {
  return { ...control, graph: { ...control.graph, nodes: control.graph.nodes.map((node) => node.kind === "step"
    ? { ...node, overrides: node.definitionId === "fly.implement" ? { selfReview: true } : null }
    : "body" in node
      ? { ...node, body: overriddenBody(node.body) }
      : node) } }
}

/** A loop body with the retired per-position policy: the first position
 *  carries none, every later one opts out of self-review. */
function overriddenBody<Unit extends object>([first, ...rest]: readonly [Unit, ...Unit[]]): readonly [Unit, ...Unit[]] {
  return [{ ...first, overrides: null }, ...rest.map((unit) => ({ ...unit, overrides: { selfReview: false } }))]
}

export function withSettledFirstAttempt(control: PrePhaseControl) {
  const [firstAttempt, ...laterAttempts] = control.attempts
  const [firstNode, ...laterNodes] = control.graph.nodes
  if (!firstAttempt || !firstNode) throw new Error("Test fixture needs a compiled attempt")
  return {
    ...control,
    status: "paused" as const,
    graph: { ...control.graph, nodes: [{ ...firstNode, state: { _tag: "completed" as const } }, ...laterNodes] },
    attempts: [{ ...firstAttempt, state: { _tag: "completed" as const } }, ...laterAttempts],
    frontier: laterNodes[0] ? [laterNodes[0].id] : [],
  }
}

/** The queue and context companions of a pre-unification run. Each names its
 *  position by the recorded step id, and each queue step already carries the seat
 *  the queue-step-skill-id pass filled in, under the `contentId` name the
 *  step-row-content-id pass gave it, which is the state the identity chain reads. The last step arrives through a mutation, so `insertedSteps` is
 *  covered too. */
function companionFacts(
  control: PrePhaseControl,
  bindings: ReadonlyMap<string, LegacyBoundStep>,
  workflowId: string,
): SeededFact[] {
  const steps = [...bindings.values()].map(({ step, binding }, index) => ({
    id: control.attempts[index]?.id ?? `${workflowId}:node:${index + 1}:attempt:1`,
    definitionId: binding.skill,
    contentId: binding.skill,
    workflowDefinitionId: workflowId,
    name: step.name,
    status: index === 0 ? "completed" : "pending",
    writes: step.writes.map(({ id }) => id),
    resumeRevertCount: 0,
  }))
  const first = steps[0]
  const last = steps.at(-1)
  if (!first || !last || steps.length < 2) throw new Error("Test fixture needs at least two bound steps")
  const writer = [...bindings.values()][0]?.step
  if (!writer) throw new Error("Test fixture needs a writing binding")
  return [
    {
      type: "queue.created",
      version: 9,
      payload: { queue: { steps: steps.slice(0, -1), cursor: 1, status: "paused", mutationLog: [] } },
    },
    {
      type: "queue.mutated",
      version: 9,
      payload: {
        mutation: {
          timestamp: 1,
          action: "insert",
          actor: "authored",
          reason: "Workflow control inserted authored attempts",
          stepIds: [last.id],
        },
        insertedSteps: [last],
        insertIndex: steps.length - 1,
      },
    },
    {
      type: "context.accumulated",
      version: 4,
      payload: {
        entry: {
          stepId: first.id,
          stepName: first.name,
          definitionId: first.definitionId,
          workflowDefinitionId: workflowId,
          recipientStepId: null,
          writes: writer.writes.map((contract) => contract.lifetime === "durable" ? { ...contract, supersedes: [...contract.supersedes] } : contract),
          timestamp: 1,
          handoff: { summary: "Spec written" },
        },
      },
    },
  ]
}

/** A project workflow that binds one skill at two graph positions, so a recorded
 *  step id names no single binding. */
export function writeProjectWorkflowStepOneSkillTwice(projectRoot: string): void {
  const workflowsDir = path.join(projectRoot, ".flywheel", "workflows")
  fs.mkdirSync(workflowsDir, { recursive: true })
  fs.writeFileSync(path.join(workflowsDir, "dual-bind.yaml"), `id: dual-bind
name: Dual Bind
description: Binds one skill at two positions.
use_when: Project test fixture.
requires_description: true
bindings:
  first:
    skill: research
  second:
    skill: research
steps:
  - step: first
  - step: second
`)
}

export function readRows(dbFile: string): EventRow[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<EventRow, []>(
      "select position, id, aggregate_id as aggregateId, seq, type, version, payload from event order by position",
    ).all()
  } finally {
    db.close()
  }
}

/** The aggregate's committed history, in the envelope shape strict replay
 *  reads: stored sequence, type, version, actor, and decoded payload. */
export function aggregateFacts(dbFile: string, aggregateId: string): readonly unknown[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ seq: number; type: string; version: number; actor: string; payload: string }, { $aggregateId: string }>(
      "select seq, type, version, actor, payload from event where aggregate_id = $aggregateId order by seq",
    ).all({ $aggregateId: aggregateId }).map((row) => ({
      seq: row.seq,
      type: row.type,
      version: row.version,
      actor: row.actor,
      payload: JSON.parse(row.payload),
    }))
  } finally {
    db.close()
  }
}

interface RecordedFollowUp {
  readonly step: string
  readonly then: RecordedFollowUp | null
}

const RecordedFollowUp: Schema.Codec<RecordedFollowUp> = Schema.Struct({
  step: Schema.String,
  then: Schema.NullOr(Schema.suspend((): Schema.Codec<RecordedFollowUp> => RecordedFollowUp)),
})

const RecordedNode = Schema.Struct({
  kind: Schema.String,
  definitionId: Schema.optional(Schema.String),
  then: Schema.optional(Schema.NullOr(RecordedFollowUp)),
})
type RecordedNode = typeof RecordedNode.Type

const RecordedChange = Schema.Struct({ kind: Schema.String, node: Schema.optional(RecordedNode) })
type RecordedChange = typeof RecordedChange.Type

/** The members of a historical control fact that name graph positions. The
 *  fixture decodes them with its own schema rather than the current decoder,
 *  and ignores every other member the fact records. */
const RecordedControlPayload = Schema.fromJsonString(Schema.Struct({
  control: Schema.optional(Schema.Struct({
    graph: Schema.Struct({ nodes: Schema.Array(RecordedNode) }),
    attempts: Schema.Array(Schema.Struct({ definitionId: Schema.String })),
  })),
  changes: Schema.optional(Schema.Array(RecordedChange)),
  event: Schema.optional(Schema.Struct({
    type: Schema.String,
    correctiveDefinitionId: Schema.optional(Schema.NullOr(Schema.String)),
    proposal: Schema.optional(Schema.Struct({ changes: Schema.Array(RecordedChange) })),
  })),
}))

/** Every id the recorded control facts of one aggregate use to name a graph
 *  position: the initialized graph, its follow-up chains and attempts, the
 *  corrective continuation of a block, and the node a reassessment adds. */
export function recordedPositionIds(dbFile: string, sessionId: string): string[] {
  const ids: string[] = []
  const addNode = (node: RecordedNode | undefined): void => {
    if (node?.definitionId !== undefined) ids.push(node.definitionId)
    for (let followUp = node?.then ?? null; followUp !== null; followUp = followUp.then) ids.push(followUp.step)
  }
  const addChanges = (changes: readonly RecordedChange[] = []): void => {
    for (const change of changes) if (change.kind === "add_node") addNode(change.node)
  }
  for (const row of readRows(dbFile)) {
    if (row.aggregateId !== workflowAggregateId(sessionId)) continue
    const payload = Schema.decodeUnknownSync(RecordedControlPayload)(row.payload)
    if (row.type === "workflow.control.initialized" && payload.control) {
      for (const node of payload.control.graph.nodes) addNode(node)
      for (const { definitionId } of payload.control.attempts) ids.push(definitionId)
    }
    if (row.type === "workflow.reassessed") addChanges(payload.changes)
    if (row.type === "workflow.control.committed" && payload.event) {
      if (typeof payload.event.correctiveDefinitionId === "string") ids.push(payload.event.correctiveDefinitionId)
      addChanges(payload.event.proposal?.changes)
    }
  }
  return [...new Set(ids)].sort()
}

/** The staged attempts under the ids the adoption renames them to: a resume must
 *  fold the same work, named by the current bindings. */
export function withCurrentBindingIds(
  attempts: CommittedWorkflowControl["attempts"],
  bindings: ReadonlyMap<string, LegacyBoundStep>,
): CommittedWorkflowControl["attempts"] {
  return attempts.map((attempt) => {
    const bound = [...bindings.values()].find(({ binding }) => binding.skill === attempt.definitionId)
    if (!bound) throw new Error(`Test fixture needs a binding for ${attempt.definitionId}`)
    return { ...attempt, definitionId: bound.step.definitionId }
  })
}

/** Steps that a shipped workflow dropped or rebound after the cutover. Their frozen pins
 *  stay, because they describe what the pre-cutover build recorded. */
export const CHANGED_SINCE_CUTOVER: ReadonlyMap<string, readonly string[]> = new Map([
  ["bench-implement", ["seed-plan"]],
  ["debug", ["fix", "investigate", "verify"]],
])

/** Rebuild the step record that one binding replaced. The skill the binding
 *  named owns the procedure and its direct-invocation metadata when it is
 *  still an installed package. A former step skill left the catalog, and its
 *  step content is the procedure now, with the metadata a step definition
 *  that no person or model invokes would state. The binding owns the
 *  workflow-only execution policy that used to live in step frontmatter. The
 *  name comes from the procedure, not from the binding: a legacy step
 *  definition had no per-workflow display name, so a binding that overrides
 *  the name states something the recorded snapshot never could and reports
 *  as a difference.
 *
 *  Phase 1 kept ids byte-identical, so the record id is the skill id. */
function reconstructLegacyStepRecord(agent: ResolvedAgent, binding: RetiredBinding, skill: SkillDefinition | undefined): LegacyStepRecord {
  const settings = binding.toolScoping === undefined ? {} : { toolScoping: binding.toolScoping };
  const procedure = skill
    ? { body: skill.body, name: skill.name, description: skill.trigger, agents: skill.agents, dependencies: skill.dependencies, directOutput: skill.directOutput, userInvocable: true, modelInvocable: skill.modelInvocable }
    : { body: agent.body, name: agent.name, description: agent.description, agents: agent.subagents, dependencies: agent.dependencies, directOutput: undefined, userInvocable: false, modelInvocable: false };
  return parseLegacyStepRecord({
    id: binding.skill,
    promptBody: procedure.body,
    name: procedure.name,
    ...(procedure.description === undefined ? {} : { description: procedure.description }),
    ...(binding.handoff === undefined ? {} : { handoff: binding.handoff }),
    writes: binding.writes ?? [],
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
    ...(procedure.agents.length === 0 ? {} : { agents: procedure.agents }),
    ...(procedure.dependencies.length === 0 ? {} : { requiredSkills: procedure.dependencies }),
    ...(procedure.directOutput === undefined ? {} : { "inline-output": procedure.directOutput }),
    "user-invocable": procedure.userInvocable,
    "disable-model-invocation": !procedure.modelInvocable,
  });
}
