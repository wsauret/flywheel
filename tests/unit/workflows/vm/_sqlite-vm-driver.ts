import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import type { AsyncEventWriter, GuardedEventStoreAppend, StoredFact } from "../../../../src/infra/event-store-types.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, requireGuardedEventAppender } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution.js"
import { hashContent } from "../../../../src/workflows/definition-hash.js"
import { buildWorkflowCompilationFacts } from "../../../../src/workflows/definition-provenance-fact-writers.js"
import { loadDefinitionLineageFromEvents } from "../../../../src/workflows/definition-provenance-projection.js"
import { loadHandoffsFromEvents } from "../../../../src/workflows/output-contract/projection.js"
import { loadContextStateFromEvents } from "../../../../src/workflows/context-bundle/context-projection.js"
import { buildContextAccumulatedFact, buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { createWorkflowContextStore, type WorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js"
import { createWorkflowViewStore, type WorkflowViewStore } from "../../../../src/workflows/view/view-store.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import type { WorkflowView } from "../../../../src/workflows/view/types.js"
import { resolveSkillClosure } from "../../../../src/workflows/skill-closure.js"
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { createWorkflowCommitHost } from "../../../../src/workflows/vm/commit-host.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js"
import type { WorkflowVmHostDeps, WorkflowVmStartMode } from "../../../../src/workflows/vm/host-types.js"
import type { WorkflowTransitionResult } from "../../../../src/workflows/vm/commands.js"
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/companions.js"
import { composeWorkflowProposal } from "../../../../src/workflows/vm/proposal-composition.js"
import { buildHandoffValidatedFact, buildHandoffWrittenFact } from "../../../../src/workflows/output-contract/facts.js"
import { compileWorkflowControl, launchGuardrailLimits } from "../../../../src/workflows/vm/compile.js"
import { queuedAttempts } from "../../../../src/workflows/vm/structural-admission.js"
import type { WorkflowInputValue } from "../../../../src/workflows/output-contract/compile.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import type { WorkflowMachineState } from "../../../../src/workflows/vm/control-types.js"
import type { WorkflowEvent } from "../../../../src/workflows/vm/events.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { replayWorkflowFromFacts } from "../../../../src/workflows/vm/replay.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import {
  buildWorkflowControlInitializedFact,
  parseWorkflowSessionFact,
  type WorkflowSessionFact,
} from "../../../../src/workflows/vm/session-facts.js"
import { initializeWorkflow, replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"

export const acceptanceWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "sqlite-acceptance",
  name: "SQLite acceptance",
  phases: [
    { phase: "work", brief: "Do the work work.", name: "Work", output: { summary: "Acceptance result." }, writes: [{ id: "artifact", lifetime: "transient" }], retry: { max: 2, stuck: true } },
    { phase: "review", brief: "Do the review work.", name: "Review", output: { summary: "Acceptance result." }, writes: [] },
  ],
})

export const acceptanceSkills: SkillRegistryRevision = testSkillRevision([
  testSkill("work", { name: "Work" }),
  testSkill("review", { name: "Review" }),
])

/** Acceptance shape for blocked work: the phase after the work phase is
 *  the phase that reassessed a blocker in a build before blocked
 *  retirement. */
export const blockedWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "sqlite-blocked",
  name: "SQLite blocked acceptance",
  phases: [
    { phase: "work", brief: "Do the work work.", name: "Work", output: { summary: "What the work did." }, writes: [{ id: "artifact", lifetime: "transient" }] },
    { phase: "reassess", brief: "Do the reassess work.", name: "Reassess", output: { summary: "What the reassessment decided." }, writes: [] },
  ],
})

export const blockedSkills: SkillRegistryRevision = testSkillRevision([
  testSkill("work", { name: "Work" }),
  testSkill("reassess", { name: "Reassess" }),
])

export type InterruptionBoundary = "before" | "after"

export interface DriverOptions {
  readonly root?: string
  readonly retain?: boolean
  readonly writer?: AsyncEventWriter
  readonly workflow?: WorkflowDefinition
  /** Revision the workflow's step dependencies resolve against. A driver
   *  that overrides the workflow overrides this too, because deterministic
   *  composition has no fallback for a skill that is not installed. */
  readonly skills?: SkillRegistryRevision
  /** The decoded structured launch input. The launch compiles with it and
   *  records it in its seed. */
  readonly input?: WorkflowInputValue
  /** A change to the compiled control before the launch stores it, for a
   *  test of a history arm that no phase-grammar compile emits. */
  readonly control?: (compiled: CommittedWorkflowControl) => CommittedWorkflowControl
}

interface ReplayOptions {
  readonly workflow?: WorkflowDefinition
  readonly skills?: SkillRegistryRevision
  readonly identityVersionOverride?: string
}

export class SqliteVmDriver {
  readonly root: string
  readonly sessionId = "sqlite-vm-session"
  readonly aggregateId = `workflow:${this.sessionId}`
  readonly sessionAggregateId = `session:${this.sessionId}`
  readonly workflow: WorkflowDefinition
  readonly skills: SkillRegistryRevision
  readonly bindings: ReadonlyMap<string, ResolvedAgent>
  readonly definitionRevision: import("../../../../src/workflows/definition-registry.js").ProjectDefinitionRegistryRevision
  readonly store
  readonly #retain: boolean
  readonly #writer: AsyncEventWriter
  readonly #input: WorkflowInputValue | null
  readonly #control: (compiled: CommittedWorkflowControl) => CommittedWorkflowControl
  #state: WorkflowMachineState | null = null
  #committed: CommittedWorkflowControl | null = null
  #batches: StoredFact[][] = []
  #workflowStores: { readonly queueStore: WorkflowViewStore; readonly contextStore: WorkflowContextStore } | null = null
  #lastAppliedEvents: StoredFact[] = []

  constructor(options: DriverOptions = {}) {
    this.root = options.root ?? join(tmpdir(), `flywheel-sqlite-vm-${process.pid}-${randomUUID()}`)
    this.#retain = options.retain ?? false
    this.workflow = options.workflow ?? acceptanceWorkflow
    this.skills = options.skills ?? acceptanceSkills
    this.bindings = resolveWorkflowAgents(this.workflow)
    const capturedRevision = repoDefinitions().captureRevision()
    this.definitionRevision = Object.freeze({
      ...capturedRevision,
      skills: this.skills,
      personas: new Map(),
    })
    mkdirSync(this.root, { recursive: true })
    this.store = createSqliteEventStore(join(this.root, ".flywheel", "flywheel.sqlite"))
    this.#writer = options.writer ?? asAsyncEventWriter(this.store)
    this.#input = options.input ?? null
    this.#control = options.control ?? ((compiled) => compiled)
  }

  get state(): WorkflowMachineState {
    if (!this.#state) throw new Error("Driver is not initialized")
    return this.#state
  }

  get committed(): CommittedWorkflowControl {
    if (!this.#committed) throw new Error("Driver has no committed control")
    return this.#committed
  }

  get batches(): readonly (readonly StoredFact[])[] {
    return this.#batches
  }

  get lastAppliedEvents(): readonly StoredFact[] {
    return this.#lastAppliedEvents
  }

  events(): StoredFact[] {
    return this.store.read({ aggregateId: this.aggregateId })
  }

  queue(): WorkflowView | null {
    return loadQueueFromEvents(this.events())
  }

  context() {
    return loadContextStateFromEvents(this.events())
  }

  handoffs() {
    return loadHandoffsFromEvents(this.events())
  }

  lineage() {
    return loadDefinitionLineageFromEvents(this.events())
  }
  workflowStores(): { readonly queueStore: WorkflowViewStore; readonly contextStore: WorkflowContextStore } {
    const reader = asAsyncEventReadSurface(this.store)
    this.#workflowStores ??= {
      queueStore: createWorkflowViewStore({ sessionId: this.sessionId, reader }),
      contextStore: createWorkflowContextStore({ sessionId: this.sessionId, reader }),
    }
    return this.#workflowStores
  }
  async initialize(): Promise<WorkflowTransitionResult> {
    // The launch's guardrails, as publication sets them with a
    // workflow.max_attempts setting of 50.
    const compiled = this.#control(compileWorkflowControl(this.workflow, this.bindings, { skills: this.skills }, launchGuardrailLimits(this.workflow, 50), this.#input))
    const queue = flattenWorkflowView(compiled, this.bindings)
    const inputSeed = buildContextInputSeededFact(this.workflow.id, "SQLite VM acceptance", this.#input)
    const provenance = buildWorkflowCompilationFacts({
      workflow: this.workflow,
      agents: [...this.bindings.values()],
      skills: this.#skillClosure(),
      attempts: queue.attempts,
      userRequestSha256: hashContent(inputSeed.payload.userRequest).sha256,
      worstCaseAttempts: queuedAttempts(compiled),
      verification: null,
      warnings: [],
    })
    const queueFacts = queueFactsForState(null, queue)
    const total = provenance.length + 2 + queueFacts.length
    const initialized = buildWorkflowControlInitializedFact({ ...compiled, aggregateSeq: total - 1 })
    const facts = [...provenance, inputSeed, initialized, ...queueFacts].map(parseWorkflowSessionFact)
    await this.#append("initialize", 0, facts)
    this.#applyCommittedBatch()
    const result = initializeWorkflow(this.committed)
    this.#state = result.state
    return result
  }

  propose(event: WorkflowEvent): WorkflowTransitionResult {
    return composeWorkflowCompanions(transitionWorkflow(this.state, event), {
      queue: this.queue(),
      resolvedAgents: this.bindings,
      timestamp: 100,
      addenda: [],
    })
  }

  async commitProposal(
    event: WorkflowEvent,
    proposal: WorkflowTransitionResult,
    writer = this.#writer,
  ): Promise<WorkflowTransitionResult> {
    if (proposal.command.kind !== "commit") throw new Error("Expected a commit proposal")
    const host = this.#host(writer)
    this.#lastAppliedEvents = []
    const applied: StoredFact[] = []
    const result = await host.commitOrReplay({
      snapshot: proposal.state,
      event,
      proposal: proposal.command.proposal,
      applyStoredFacts: (stored) => {
        applied.push(...stored)
        this.#lastAppliedEvents.push(...stored)
      },
    })
    const storedBatch = this.events().slice(
      proposal.command.proposal.expectedSeq,
      proposal.command.proposal.expectedSeq + proposal.command.proposal.facts.length,
    )
    if (storedProposalMatches(storedBatch, proposal.command.proposal.facts)) {
      this.#batches.push(storedBatch)
      this.#applyCommittedBatch()
    } else {
      this.#committed = result.state.context.committed
    }
    if (applied.length === 0) throw new Error("Commit host did not catch projections up before returning")
    this.#state = result.state
    return result
  }

  async drive(event: WorkflowEvent): Promise<WorkflowTransitionResult> {
    return this.commitProposal(event, this.propose(event))
  }

  async startAttempt(boundary: InterruptionBoundary, conversationId = "conversation-work"): Promise<WorkflowTransitionResult> {
    const prepared = await this.drive({ type: "START" })
    if (prepared.command.kind !== "prepare_attempt") throw new Error("No pending attempt is ready")
    const event: WorkflowEvent = {
      type: "ATTEMPT_STARTED",
      attemptId: prepared.command.attempt.attemptId,
      conversationId,
    }
    const proposal = this.propose(event)
    return boundary === "before" ? proposal : this.commitProposal(event, proposal)
  }

  async completeAttempt(
    boundary: InterruptionBoundary,
    handoff: { [key: string]: unknown } = { summary: "done" },
  ): Promise<WorkflowTransitionResult> {
    const attempt = this.committed.attempts.find(({ state }) => state._tag === "running")
    if (!attempt) throw new Error("No running attempt can complete")
    const event: WorkflowEvent = {
      type: "ATTEMPT_SUCCEEDED",
      outcome: {
        attemptId: attempt.id,
        conversationId: attempt.conversationId,
        handoff,
        reassessment: null,
      },
    }
    const proposal = this.propose(event)
    return boundary === "before" ? proposal : this.commitProposal(event, proposal)
  }

  async failHandoff(reason = "summary is required"): Promise<void> {
    const attempt = this.committed.attempts.find(({ state }) => state._tag === "running")
    if (!attempt) throw new Error("No running attempt can fail")
    const event: WorkflowEvent = {
      type: "ATTEMPT_FAILED",
      failure: {
        attemptId: attempt.id,
        kind: "invalid_handoff",
        reason,
        conversationId: attempt.conversationId,
        content: {},
        issues: [{ path: "summary", message: reason }],
      },
    }
    await this.commitProposal(event, this.propose(event))
  }

  /** The block a running attempt reported under a build before blocked
   *  retirement, with the corrective definition that build resolved from the
   *  pinned bindings. No current writer proposes it; only replay reads it. */
  blockEvent(handoff: { [key: string]: unknown }, correctiveDefinitionId: string | null): WorkflowEvent {
    const attempt = this.committed.attempts.find(({ state }) => state._tag === "running")
    if (!attempt) throw new Error("No running attempt can block")
    return {
      type: "ATTEMPT_BLOCKED",
      blocked: {
        attemptId: attempt.id,
        conversationId: attempt.conversationId ?? "conversation-work",
        handoff,
      },
      correctiveDefinitionId,
    }
  }

  /** Commit a block exactly as a build before blocked retirement did: the
   *  ATTEMPT_BLOCKED control commit, the handoff facts, and the blocker report
   *  addressed to the corrective attempt the same commit inserts. The current
   *  companions write none of these, so the stored chain is history the new
   *  build must replay. */
  async seedStoredBlock(handoff: { [key: string]: unknown }, correctiveDefinitionId: string | null): Promise<WorkflowTransitionResult> {
    const event = this.blockEvent(handoff, correctiveDefinitionId)
    const proposal = this.propose(event)
    const pending = proposal.state.context.pending
    if (event.type !== "ATTEMPT_BLOCKED" || !pending) throw new Error("A block must propose a commit")
    const attempt = pending.previousCommitted.attempts.find(({ id }) => id === event.blocked.attemptId)
    const node = pending.previousCommitted.graph.nodes.find(({ id }) => id === attempt?.logicalNodeId)
    const binding = attempt ? this.bindings.get(attempt.definitionId) : undefined
    if (!attempt || !node || !binding) throw new Error("A stored block needs its attempt provenance")
    const identity = {
      attemptId: attempt.id,
      agentName: node.kind === "agent" && attempt.definitionId === node.definitionId ? node.name : binding.name,
      definitionId: attempt.definitionId,
      workflowDefinitionId: attempt.workflowDefinitionId,
    }
    const recipientAttemptId = pending.proposedCommitted.attempts.find(({ parentAttemptId }) => parentAttemptId === attempt.id)?.id ?? null
    const historical = [
      buildHandoffWrittenFact({ ...identity, content: handoff }),
      buildHandoffValidatedFact({ ...identity, status: "passed", issues: [] }),
      ...(recipientAttemptId === null ? [] : [buildContextAccumulatedFact({
        entryId: identity.attemptId,
        agentName: identity.agentName,
        definitionId: identity.definitionId,
        workflowDefinitionId: identity.workflowDefinitionId,
        recipientAttemptId,
        writes: [{ id: "blocked_work", lifetime: "transient" as const }],
        timestamp: 100,
        handoff,
      })]),
    ].map(parseWorkflowSessionFact)
    return this.commitProposal(event, composeWorkflowProposal(proposal, historical))
  }

  freshState(): WorkflowMachineState {
    const fresh = createSqliteEventStore(join(this.root, ".flywheel", "flywheel.sqlite"))
    try {
      return replayWorkflow(replayWorkflowControl(fresh.read({ aggregateId: this.aggregateId })))
    } finally {
      fresh.close()
    }
  }

  freshViews() {
    const fresh = createSqliteEventStore(join(this.root, ".flywheel", "flywheel.sqlite"))
    try {
      const events = fresh.read({ aggregateId: this.aggregateId })
      return {
        control: replayWorkflowControl(events),
        queue: loadQueueFromEvents(events),
        context: loadContextStateFromEvents(events),
        handoffs: loadHandoffsFromEvents(events),
        lineage: loadDefinitionLineageFromEvents(events),
      }
    } finally {
      fresh.close()
    }
  }

  async freshReplay(event: WorkflowEvent, options: ReplayOptions = {}): Promise<WorkflowTransitionResult> {
    const fresh = createSqliteEventStore(join(this.root, ".flywheel", "flywheel.sqlite"))
    const workflow = options.workflow ?? this.workflow
    const skills = options.skills ?? this.skills
    try {
      const revision = Object.freeze({
        ...this.definitionRevision,
        skills,
      })
      return await replayWorkflowFromFacts(fresh.read({ aggregateId: this.aggregateId }), event, {
        sessionId: this.sessionId,
        writer: asAsyncEventWriter(fresh),
        definitionRevision: revision,
        workflow,
        now: () => 100,
      }, options.identityVersionOverride ? { vmVersion: options.identityVersionOverride } : undefined)
    } finally {
      fresh.close()
    }
  }

  async commitCompeting(event: WorkflowEvent): Promise<void> {
    const snapshot = this.freshState()
    const proposal = composeWorkflowCompanions(transitionWorkflow(snapshot, event), {
      queue: this.queue(),
      resolvedAgents: this.bindings,
      timestamp: 100,
      addenda: [],
    })
    if (proposal.command.kind !== "commit") throw new Error("Competing event did not propose a commit")
    const fresh = createSqliteEventStore(join(this.root, ".flywheel", "flywheel.sqlite"))
    try {
      await this.#host(asAsyncEventWriter(fresh)).commit(proposal.command.proposal)
    } finally {
      fresh.close()
    }
  }

  async appendCompetingFact(fact: WorkflowSessionFact): Promise<StoredFact> {
    const parsed = parseWorkflowSessionFact(fact)
    const fresh = createSqliteEventStore(join(this.root, ".flywheel", "flywheel.sqlite"))
    try {
      const result = await asAsyncEventWriter(fresh).appendGuarded({
        aggregateId: this.aggregateId,
        sessionId: this.sessionId,
        timestamp: 100,
        type: parsed.type,
        version: parsed.version,
        actor: parsed.actor,
        payload: parsed.payload,
        expectedSeq: fresh.aggregateSeq(this.aggregateId) + 1,
      })
      if (result.kind !== "stored" || !result.events[0]) throw new Error("competing fact conflicted")
      return result.events[0]
    } finally {
      fresh.close()
    }
  }

  async appendSessionTelemetry(): Promise<StoredFact> {
    const fresh = createSqliteEventStore(join(this.root, ".flywheel", "flywheel.sqlite"))
    try {
      return await asAsyncEventWriter(fresh).append({
        aggregateId: this.sessionAggregateId,
        sessionId: this.sessionId,
        timestamp: 100,
        type: "test.telemetry.observed",
        version: 1,
        actor: "flywheel",
        payload: {
          name: "concurrent telemetry",
          startTimeMs: 100,
        },
      })
    } finally {
      fresh.close()
    }
  }

  async initializeLegacy(): Promise<void> {
    const compiled = compileWorkflowControl(this.workflow, this.bindings, { skills: this.skills })
    const queue = flattenWorkflowView(compiled, this.bindings)
    const facts = [
      ...buildWorkflowCompilationFacts({
        workflow: this.workflow,
        agents: [...this.bindings.values()],
        skills: this.#skillClosure(),
        attempts: queue.attempts,
        userRequestSha256: hashContent("SQLite VM legacy acceptance").sha256,
        worstCaseAttempts: queuedAttempts(compiled),
        verification: null,
        warnings: [],
      }),
      ...queueFactsForState(null, queue),
    ].map(parseWorkflowSessionFact)
    await this.#writer.appendBatch(facts.map((fact) => ({
      aggregateId: this.sessionAggregateId,
      sessionId: this.sessionId,
      timestamp: 100,
      type: fact.type,
      version: fact.version,
      actor: fact.actor,
      payload: fact.payload,
    })))
  }

  close(): void {
    this.#workflowStores?.queueStore.dispose()
    this.#workflowStores?.contextStore.dispose()
    this.#workflowStores = null
    this.store.close()
    if (!this.#retain) rmSync(this.root, { recursive: true, force: true })
  }

  /** Packages the recorded provenance covers: the dependency closure of every
   *  step's dependencies, exactly as the production launch resolves it. */
  #skillClosure() {
    return resolveSkillClosure(
      [...this.bindings.values()].flatMap(({ dependencies }) => dependencies),
      this.skills,
      `Workflow "${this.workflow.id}"`,
    )
  }

  #host(writer: AsyncEventWriter) {
    return createWorkflowCommitHost({
      sessionId: this.sessionId,
      writer,
      reader: asAsyncEventReadSurface(this.store),
      definitionRevision: this.definitionRevision,
      workflow: this.workflow,
      now: () => 100,
    })
  }

  async #append(proposalId: string, expectedSeq: number, facts: readonly WorkflowSessionFact[]): Promise<StoredFact[]> {
    const appends = facts.map((fact, index): GuardedEventStoreAppend => ({
      aggregateId: this.aggregateId,
      sessionId: this.sessionId,
      timestamp: 100,
      type: fact.type,
      version: fact.version,
      actor: fact.actor,
      payload: fact.payload,
      ...(index === 0 ? { expectedSeq } : {}),
    }))
    const result = await requireGuardedEventAppender(this.#writer, "SQLite VM driver requires guarded append authority").appendBatchGuarded(appends)
    if (result.kind === "conflict") throw new Error(`${proposalId} conflicted at aggregate sequence ${result.conflict.actualSeq}`)
    const stored = [...result.events]
    if (stored.length === 0) throw new Error(`${proposalId} returned no stored events`)
    this.#batches.push(stored)
    return stored
  }

  #applyCommittedBatch(): void {
    this.#committed = replayWorkflowControl(this.events())
  }


}

export function closedSqliteWriter(root: string): AsyncEventWriter {
  const store = createSqliteEventStore(join(root, ".flywheel", "flywheel.sqlite"))
  const writer = asAsyncEventWriter(store)
  store.close()
  return writer
}


function storedProposalMatches(
  stored: readonly StoredFact[],
  facts: readonly WorkflowSessionFact[],
): boolean {
  return stored.length === facts.length && stored.every((event, index) => {
    const fact = facts[index]
    return fact !== undefined
      && event.type === fact.type
      && event.version === fact.version
      && event.actor === fact.actor
      && isDeepStrictEqual(event.payload, fact.payload)
  })
}

/** A workflow host over the driver's store that answers each attempt
 *  through `answer`. */
export function mapHost(vm: SqliteVmDriver, startMode: WorkflowVmStartMode, answer: WorkflowVmHostDeps["attemptRunner"]["run"], messages: Pick<Partial<WorkflowVmHostDeps>, "requestAddenda" | "addressedMessages" | "preAttemptPolicy"> = {}) {
  return createWorkflowVmHost({
    servedConversations: async () => new Set(),
    requestAddenda: async () => [],
    startMode,
    sessionId: vm.sessionId,
    reader: asAsyncEventReadSurface(vm.store),
    writer: asAsyncEventWriter(vm.store),
    ...vm.workflowStores(),
    definitionRevision: vm.definitionRevision,
    workflow: vm.workflow,
    attemptRunner: { run: answer },
    emit: () => {},
    now: () => 100,
    ...messages,
  })
}
