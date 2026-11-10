import { describe, expect, it, spyOn } from "bun:test"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { foldWorkflowControl, replayWorkflowControl, replayWorkflowControlFrom } from "../../../../src/workflows/vm/fact-fold.js"
import { composeWorkflowProposal } from "../../../../src/workflows/vm/proposal-composition.js"
import { buildDefinitionIdentityAdoptedFact, buildWorkflowControlInitializedFact, buildWorkflowControlRecoveredFact, buildDefinitionIdentityMigratedFact, parseWorkflowSessionFact, type WorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { buildAttemptRecoveredFact } from "../../../../src/workflows/vm/fact-drafts.js"
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import {
  DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
  DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID,
  type DefinitionIdentity,
} from "../../../../src/workflows/vm/definition-identity.js"
import * as committedControl from "../../../../src/workflows/vm/committed-control.js"
import { recoveredWorkflowRoot } from "../../../helpers/workflow-root-fixtures.js"
import { selectNewestWorkflowRoot } from "../../../../src/workflows/workflow-root.js"
import { recoverWorkflowControl, workflowRecoveryBasis } from "../../../../src/workflows/vm/recovery.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { items, mapSkills, mapWorkflow } from "./_map-fixtures.js"
import { buildDefinitionDriftRejectedFact } from "../../../../src/workflows/definition-provenance-fact-writers.js"

const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "workflow",
  name: "Workflow",
  phases: [{ phase: "work", brief: "Follow the work method.", name: "Work", dependencies: ["work"], writes: [] }],
})
const skills = testSkillRevision([testSkill("work", { name: "Work" })])
const bindings = resolveWorkflowAgents(workflow)

function trace() {
  const initialized = buildWorkflowControlInitializedFact(
    compileWorkflowControl(workflow, bindings, { skills }),
  )
  if (initialized.type !== "workflow.control.initialized") throw new Error("Expected initialized root")
  const initial = initialized.payload.control
  const proposal = transitionWorkflow(initializeWorkflow(initial).state, { type: "PAUSE", reason: "operator" })
  if (proposal.command.kind !== "commit" || !proposal.state.context.pending) {
    throw new Error("Pause must propose a commit")
  }
  return {
    initialized,
    initial,
    final: proposal.state.context.pending.proposedCommitted,
    committed: proposal.command.proposal.facts,
    proposal,
  }
}

describe("workflow control fact fold", () => {
  it.each([2, 40])("advances independent companions without revisiting %i validated attempts", (members) => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "wide", name: "Wide",
      phases: Array.from({ length: members }, (_, index) => ({
        phase: `work${index}`, brief: "Follow the work method.", name: `Work ${index}`, dependencies: ["work"], writes: [],
      })),
    })
    const initial = compileWorkflowControl(definition, resolveWorkflowAgents(definition), { skills })
    const counts = { visits: 0 }
    for (const attempt of initial.attempts) {
      const id = attempt.id
      Object.defineProperty(attempt, "id", { get: () => { counts.visits++; return id }, configurable: true })
    }
    const companion: StoredFact = {
      ...stored(parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }), initial.aggregateSeq),
      type: "session.renamed", payload: { name: "Renamed", lastUpdated: "2026-10-19T00:00:00.000Z" },
    }
    const next = replayWorkflowControlFrom(initial, [companion])
    expect(next.aggregateSeq).toBe(initial.aggregateSeq + 1)
    expect(next.attempts).toBe(initial.attempts)
    expect(counts.visits).toBe(0)
  })

  it("strictly folds proposal batches and derives aggregate sequence from unstored fact count", () => {
    const { initialized, initial, final, committed } = trace()
    expect(foldWorkflowControl(null, [initialized])).toEqual(initial)
    expect(foldWorkflowControl(initial, committed)).toEqual(final)
  })

  it("folds mixed batches by validating companions before semantic facts", () => {
    const { initialized, initial, proposal } = trace()
    const companions = [
      parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }),
      parseWorkflowSessionFact({
        type: "follow_up.resume_state.recorded", version: 1, actor: "flywheel", payload: { conversationId: null },
      }),
    ]
    const composed = composeWorkflowProposal(proposal, companions)
    if (composed.command.kind !== "commit" || !composed.state.context.pending) throw new Error("Composition failed")
    const mixed = composed.command.proposal.facts.map((fact, index) => stored(fact, index + 1))

    expect(foldWorkflowControl(initial, mixed)).toEqual(composed.state.context.pending.proposedCommitted)
    expect(replayWorkflowControl([stored(initialized, 0), ...mixed])).toEqual(composed.state.context.pending.proposedCommitted)
  })

  it("ignores sparse stored sequences while keeping semantic facts strict", () => {
    const { initialized, initial, proposal } = trace()
    const companions = [
      parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }),
      parseWorkflowSessionFact({
        type: "follow_up.resume_state.recorded", version: 1, actor: "flywheel", payload: { conversationId: null },
      }),
    ]
    const composed = composeWorkflowProposal(proposal, companions)
    if (composed.command.kind !== "commit" || !composed.state.context.pending) throw new Error("Composition failed")
    const mixed = composed.command.proposal.facts.map((fact, index) => stored(fact, index + initial.aggregateSeq))
    const prunedCompanion = mixed.filter(({ seq }) => seq !== initial.aggregateSeq + 1)

    expect(replayWorkflowControl([stored(initialized, 0), ...prunedCompanion]))
      .toEqual(composed.state.context.pending.proposedCommitted)
    expect(() => replayWorkflowControl([
      stored(initialized, 0),
      ...mixed.filter(({ type }) => type !== "workflow.paused"),
    ])).toThrow("sparse semantic facts")
  })

  it("replays a root batch whose last replace-only companion was pruned", () => {
    const compiled = compileWorkflowControl(workflow, bindings, { skills })
    // The launch batch holds the root and two companions, so its control
    // records the position after all three.
    const initialized = buildWorkflowControlInitializedFact({ ...compiled, aggregateSeq: compiled.aggregateSeq + 2 })
    if (initialized.type !== "workflow.control.initialized") throw new Error("Expected initialized root")
    const companion = parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} })
    const batch = [stored(initialized, 0), stored(companion, 1), stored(companion, 2)]

    expect(replayWorkflowControl(batch.filter(({ seq }) => seq !== 2)).aggregateSeq).toBe(initialized.payload.control.aggregateSeq)
    expect(replayWorkflowControl(batch).aggregateSeq).toBe(initialized.payload.control.aggregateSeq)
  })

  it("replays current reassessment and commit facts", () => {
    const { initialized, initial } = trace()
    const batches: WorkflowSessionFact[][] = []
    const commit = (result: ReturnType<typeof transitionWorkflow>) => {
      if (result.command.kind !== "commit" || !result.state.context.pending) throw new Error("Event did not propose a commit")
      batches.push([...result.command.proposal.facts])
      return transitionWorkflow(result.state, {
        type: "COMMIT_SUCCEEDED",
        proposalId: result.state.context.pending.proposalId,
        aggregateSeq: result.state.context.pending.proposedCommitted.aggregateSeq,
      })
    }
    const prepared = commit(transitionWorkflow(initializeWorkflow(initial).state, { type: "START" }))
    if (prepared.command.kind !== "prepare_attempt") throw new Error("Start did not prepare an attempt")
    const running = commit(transitionWorkflow(prepared.state, {
      type: "ATTEMPT_STARTED",
      attemptId: prepared.command.attempt.attemptId,
      conversationId: "conversation",
    }))
    const reassessment = transitionWorkflow(running.state, {
      type: "REASSESSMENT_PROPOSED",
      proposal: {
        proposalId: "reassessment",
        ownerNodeId: "workflow:node:1",
        reason: "obsolete",
        changes: [{ kind: "skip", targetAttemptId: "workflow:node:1:attempt:1", reason: "obsolete" }],
      },
    })
    if (reassessment.command.kind !== "commit" || !reassessment.state.context.pending) throw new Error("Reassessment did not propose a commit")
    batches.push([...reassessment.command.proposal.facts])
    expect(reassessment.command.proposal.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow.reassessed", version: 3 }),
      expect.objectContaining({ type: "workflow.control.committed", version: 14 }),
    ]))
    expect(replayWorkflowControl([initialized, ...batches.flat()]))
      .toEqual(reassessment.state.context.pending.proposedCommitted)
  })

  it("rejects duplicate control semantics in a proposal companion prefix", () => {
    const { initial, committed } = trace()
    const first = committed[0]
    if (!first) throw new Error("Pause semantic fact missing")
    const duplicated = [first, ...committed]

    expect(() => foldWorkflowControl(initial, duplicated)).toThrow("control fact as a companion")
    expect(() => replayWorkflowControlFrom(
      initial,
      duplicated.map((fact, index) => stored(fact, index + initial.aggregateSeq)),
    )).toThrow("control fact as a companion")
  })

  it("advances aggregate sequence over a trailing stored non-control suffix", () => {
    const { initialized, final, committed } = trace()
    const history = [
      stored(initialized, 0),
      ...committed.map((fact, index) => stored(fact, index + 1)),
    ]
    const suffix = [
      stored(parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }), 3),
      stored(parseWorkflowSessionFact({
        type: "follow_up.resume_state.recorded", version: 1, actor: "flywheel", payload: { conversationId: null },
      }), 4),
    ]

    expect(replayWorkflowControl([...history, ...suffix])).toEqual({ ...final, aggregateSeq: 5 })
    expect(() => replayWorkflowControl([...history, suffix[0], {
      type: "queue.deleted", version: 1, actor: "flywheel", payload: {},
    }])).toThrow("mixed stored and unstored")
    expect(() => replayWorkflowControl([...history, { ...suffix[0], seq: -1 }])).toThrow("invalid stored sequence")
    expect(() => replayWorkflowControl([...history, { ...suffix[0], seq: 2 }])).toThrow("ordered sequence")
  })

  it("replays independently written companions, learning audit facts, and workflow-owned request facts before the next semantic proposal", () => {
    const { initialized, initial } = trace()
    const cut = parseWorkflowSessionFact({ type: "workflow.run.cut.updated", version: 1, actor: "flywheel", payload: { cut: { by: "person", timestamp: 1 } } })
    // A workflow-owned request records facts of a family the workflow layer
    // does not decode. The learning reviews that builds before 2026-11-10 ran
    // on workflow agents left such facts in stored workflow aggregates. Such a
    // review's memory tool and the inspiration reconciler record workflow-family audit facts in their
    // own transactions, and replay records a definition drift rejection before
    // it refuses, so they sit between batches too.
    const requests = [
      "memory.written", "improvement.proposed", "definition.drift_rejected",
      "prompt.assembled", "model.requested", "model.usage.recorded",
      "context.application.recorded", "context.transformer.applied",
      "tool_surface.selected", "budget.stream.completed", "skill.review.completed",
    ].map((type, index) => ({
      type, version: 5, actor: "flywheel", payload: { requestId: "review-request" }, seq: initial.aggregateSeq + index + 1,
    }))
    const independent = [stored(cut, initial.aggregateSeq), ...requests]
    const prefix = foldWorkflowControl(initial, independent)
    const proposed = transitionWorkflow(initializeWorkflow(prefix).state, { type: "PAUSE", reason: "operator" })
    if (proposed.command.kind !== "commit" || !proposed.state.context.pending) throw new Error("Pause must propose a commit")
    const suffix = proposed.command.proposal.facts.map((fact, index) => stored(fact, prefix.aggregateSeq + index))
    const history = [stored(initialized, 0), ...independent, ...suffix]
    expect(replayWorkflowControl(history)).toEqual(proposed.state.context.pending.proposedCommitted)
    expect(workflowRecoveryBasis(history)).toEqual(proposed.state.context.pending.proposedCommitted)
    expect(recoverWorkflowControl(history)).toMatchObject({ executable: true })
  })

  it.each(["workflow.definition_identity.adoptedd", "workflow.control.future", "attempt.future", "queue.future", "context.input.future"])(
    "rejects an unknown workflow-family type %s instead of positioning it as another family",
    (type) => {
      const { initialized, initial } = trace()
      const unknown = { ...stored(initialized, initial.aggregateSeq), type }
      const history = [stored(initialized, 0), unknown]
      expect(() => replayWorkflowControl(history)).toThrow()
      expect(workflowRecoveryBasis(history)).toBeNull()
      expect(recoverWorkflowControl(history)).toMatchObject({ executable: false })

      const rootBatch = [
        stored({ ...initialized, payload: { control: { ...initial, aggregateSeq: 2 } } }, 0),
        { ...unknown, seq: 1 },
      ]
      expect(() => replayWorkflowControl(rootBatch)).toThrow()
      expect(workflowRecoveryBasis(rootBatch)).toBeNull()
    },
  )

  it("rejects malformed, out-of-order, and incomplete proposal batches", () => {
    const { initialized, initial, committed } = trace()
    expect(() => foldWorkflowControl(null, [{
      type: "workflow.control.initialized", version: 1, actor: "flywheel", payload: {},
    }])).toThrow()
    expect(() => foldWorkflowControl(initial, committed.slice(0, -1))).toThrow("terminal")
    expect(() => foldWorkflowControl(initial, [initialized])).toThrow("repeated")
    expect(() => foldWorkflowControl(null, committed)).toThrow("must start")
    const terminal = committed.at(-1)
    if (terminal?.type !== "workflow.control.committed") throw new Error("Commit marker missing")
    expect(() => foldWorkflowControl(initial, [
      ...committed.slice(0, -1),
      { ...terminal, payload: { ...terminal.payload, proposalId: "wrong" } },
    ])).toThrow("proposal identity")
    expect(() => foldWorkflowControl(trace().final, committed)).toThrow("rejected PAUSE while paused")
  })

  it("uses only the newest recognized root and its suffix", () => {
    const { initialized, initial } = trace()
    const recoveredControl = { ...initial, status: "paused" as const, frontier: [], attempts: [], aggregateSeq: 3 }
    const recovered = buildWorkflowControlRecoveredFact({
      supersededThroughSeq: 0,
      degradationReasons: [{ kind: "invalid_suffix", seq: 1 }],
      runtimeIdentity: { version: "0.0.7", buildId: "build" },
      identities: {
        workflow: { source: "recovered", value: "workflow" },
        step: { source: "synthesized", value: "step" },
        attempt: null,
        conversation: null,
      },
      control: recoveredControl,
    })

    expect(replayWorkflowControl([
      stored(initialized, 0),
      { ...stored(initialized, 1), payload: { broken: true } },
      stored(recovered, 2),
    ])).toEqual({ ...recoveredControl, aggregateSeq: 3 })
  })

  it("refuses to rewind control across damaged or incomplete suffix data", () => {
    const { initialized, committed } = trace()
    const malformed = { type: "workflow.paused", version: 99, actor: "flywheel", payload: {} }

    expect(workflowRecoveryBasis([initialized, malformed])).toBeNull()
    expect(workflowRecoveryBasis([initialized, ...committed, malformed])).toBeNull()
    expect(workflowRecoveryBasis([initialized, ...committed.slice(0, -1)])).toBeNull()
    expect(workflowRecoveryBasis([initialized, { ...initialized, payload: { broken: true } }])).toBeNull()
  })

  it("never revives an older prefix across a malformed or unsupported newest root envelope", () => {
    const { initialized, committed } = trace()
    for (const type of ["workflow.control.initialized", "workflow.control.recovered"] as const) {
      for (const version of [type === "workflow.control.initialized" ? 2 : 1, 99]) {
        const newest = { type, version, actor: "flywheel", payload: {} }
        const facts = [stored(initialized, 0), ...committed.map((fact, index) => stored(fact, index + 1)), {
          ...newest, seq: 3, position: 40,
        }]
        expect(workflowRecoveryBasis(facts)).toBeNull()
        expect(() => replayWorkflowControl(facts)).toThrow()
        expect(recoverWorkflowControl(facts)).toMatchObject({ kind: "recovery", executable: false })
        expect(selectNewestWorkflowRoot(facts)).toEqual({ index: 3, type, version, seq: 3, position: 40 })
      }
    }
  })

  it("selects the latest of two complete recovered control batches without decoding older damage", () => {
    const { initialized, initial } = trace()
    const first = recoveredWorkflowRoot(initial, 4)
    const latest = recoveredWorkflowRoot({ ...initial, attempts: [] }, 6)
    const companion = parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} })
    const history = [
      stored(initialized, 0),
      { ...stored(companion, 1), payload: { poison: true } },
      stored(first, 2), stored(companion, 3),
      stored(latest, 4), stored(companion, 5),
    ]
    expect(replayWorkflowControl(history)).toEqual(latest.payload.control)
    expect(workflowRecoveryBasis(history)).toEqual(latest.payload.control)
    expect(recoverWorkflowControl(history)).toMatchObject({ executable: true, rootSeq: 4, control: latest.payload.control })
    expect(history[1]?.payload).toEqual({ poison: true })
  })

  it("distinguishes a root repair basis from strict complete-root replay", () => {
    const { initial } = trace()
    const recoveredControl = { ...initial, status: "paused" as const, frontier: [], aggregateSeq: 2 }
    const recovered = buildWorkflowControlRecoveredFact({
      supersededThroughSeq: 0,
      degradationReasons: [{ kind: "invalid_suffix", seq: 1 }],
      runtimeIdentity: { version: "0.0.7", buildId: "build" },
      identities: {
        workflow: { source: "recovered", value: "workflow" },
        step: { source: "recovered", value: "workflow:node:1" },
        attempt: { source: "recovered", value: "workflow:node:1:attempt:1" },
        conversation: { source: "recovered", value: "conversation" },
      },
      control: recoveredControl,
    })
    const companion = buildAttemptRecoveredFact("workflow:node:1:attempt:1", "conversation")

    expect(workflowRecoveryBasis([stored(recovered, 0), stored(companion, 1), { broken: true }])).toBeNull()
    expect(workflowRecoveryBasis([stored(recovered, 0)])).toEqual(recoveredControl)
    expect(() => replayWorkflowControl([stored(recovered, 0)])).toThrow("sequence")
  })

  it("preserves sparse stored sequence rules at complete proposal boundaries", () => {
    const { initialized, proposal } = trace()
    const companion = parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} })
    const composed = composeWorkflowProposal(proposal, [companion])
    if (composed.command.kind !== "commit" || !composed.state.context.pending) throw new Error("Composition failed")
    const storedBatch = composed.command.proposal.facts.map((fact, index) => stored(fact, index + 1))
    const sparse = storedBatch.filter(({ seq }) => seq !== 1)

    expect(workflowRecoveryBasis([stored(initialized, 0), ...sparse]))
      .toEqual(composed.state.context.pending.proposedCommitted)
  })

  it("refuses a long unknown suffix without decoding it as control", () => {
    const { initialized } = trace()
    let envelopeReads = 0
    const malformed = Array.from({ length: 2_000 }, () => ({
      get type() { envelopeReads += 1; return "unknown" },
      version: 1,
      actor: "flywheel",
      payload: {},
    }))

    expect(workflowRecoveryBasis([stored(initialized, 0), ...malformed])).toBeNull()
    expect(envelopeReads).toBe(malformed.length)
  })

  it("validates only the replay boundary control after a long semantic replay", () => {
    const initialized = buildWorkflowControlInitializedFact(
      compileWorkflowControl(workflow, bindings, { skills }),
    )
    if (initialized.type !== "workflow.control.initialized") throw new Error("Expected initialized root")
    const history: StoredFact[] = [stored(initialized, 0)]
    let state = initializeWorkflow(initialized.payload.control).state
    for (let index = 0; index < 100; index += 1) {
      const event = state.lifecycle === "paused"
        ? { type: "RESUME" as const, readers: {} }
        : { type: "PAUSE" as const, reason: `pause-${index}` }
      const proposal = transitionWorkflow(state, event)
      if (proposal.command.kind !== "commit" || !proposal.state.context.pending) throw new Error("Expected commit")
      const startSeq = history.length
      history.push(...proposal.command.proposal.facts.map((fact, factIndex) => stored(fact, startSeq + factIndex)))
      state = transitionWorkflow(proposal.state, {
        type: "COMMIT_SUCCEEDED",
        proposalId: proposal.command.proposal.proposalId,
        aggregateSeq: proposal.state.context.pending.proposedCommitted.aggregateSeq,
      }).state
    }
    const controlValidations = spyOn(committedControl, "parseCommittedWorkflowControl")
    controlValidations.mockClear()

    try {
      const replayed = replayWorkflowControl(history)

      expect(replayed.aggregateSeq).toBe(history.length)
      expect(controlValidations).toHaveBeenCalledTimes(1)
    } finally {
      controlValidations.mockRestore()
    }
  })

  it("adopts a migrated definition identity at an aggregate tail boundary", () => {
    const { initialized, initial, final, committed } = trace()
    const migration = buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, initial.definitionIdentity, adopted(initial.definitionIdentity))

    expect(replayWorkflowControl([initialized, migration])).toEqual({
      ...initial, definitionIdentity: adopted(initial.definitionIdentity), aggregateSeq: initial.aggregateSeq + 1,
    })
    expect(replayWorkflowControl([initialized, ...committed, migration])).toEqual({
      ...final, definitionIdentity: adopted(final.definitionIdentity), aggregateSeq: final.aggregateSeq + 1,
    })
  })

  it("repeats fold-verified skill-content adoption and rejects structural adoption", () => {
    const { initialized, initial } = trace()
    const first = { ...initial.definitionIdentity, skills: initial.definitionIdentity.skills.map((skill) => ({
      ...skill, sha256: "c".repeat(64),
    })) }
    const second = { ...first, skills: first.skills.map((skill) => ({ ...skill, sha256: "d".repeat(64) })) }
    const firstFact = buildDefinitionIdentityAdoptedFact(initial.definitionIdentity, first)
    const secondFact = buildDefinitionIdentityAdoptedFact(first, second)

    expect(replayWorkflowControl([initialized, firstFact, secondFact])).toMatchObject({
      definitionIdentity: second,
      aggregateSeq: initial.aggregateSeq + 2,
    })
    expect(() => replayWorkflowControl([
      initialized,
      buildDefinitionIdentityAdoptedFact(initial.definitionIdentity, { ...initial.definitionIdentity, vmVersion: "3" }),
    ])).toThrow("structural")
    expect(() => replayWorkflowControl([initialized, {
      ...firstFact,
      payload: { ...firstFact.payload, evidence: [] },
    }])).toThrow("evidence")
  })

  it.each(["adopted", "migrated"] as const)("folds diagnostic companions before a standalone identity %s boundary", (kind) => {
    const { initialized, initial, committed } = trace()
    const identity = { ...initial.definitionIdentity, skills: initial.definitionIdentity.skills.map((skill) => ({
      ...skill, sha256: "c".repeat(64),
    })) }
    const rejection = buildDefinitionDriftRejectedFact({
      workflowId: workflow.id,
      latestSeq: initial.aggregateSeq,
      changes: [{ component: "graph", definitionId: workflow.id, recorded: "a".repeat(64), current: "b".repeat(64) }],
    })
    const identityFact = kind === "adopted"
      ? buildDefinitionIdentityAdoptedFact(initial.definitionIdentity, identity)
      : buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, initial.definitionIdentity, identity)
    const afterIdentity = { ...initial, definitionIdentity: identity, aggregateSeq: initial.aggregateSeq + 2 }
    const next = transitionWorkflow(initializeWorkflow(afterIdentity).state, { type: "PAUSE", reason: "operator" })
    if (next.command.kind !== "commit" || !next.state.context.pending) throw new Error("Pause must propose a commit")
    const nextFacts = next.command.proposal.facts
    const afterCommit = next.state.context.pending.proposedCommitted
    const history = [initialized, rejection, identityFact]

    for (const positioned of [false, true]) {
      const encode = (facts: readonly WorkflowSessionFact[], startSeq = 0) => positioned
        ? facts.map((fact, index) => stored(fact, startSeq + index))
        : facts
      expect(replayWorkflowControl(encode(history))).toEqual(afterIdentity)
      expect(replayWorkflowControlFrom(initial, encode([rejection, identityFact], initial.aggregateSeq))).toEqual(afterIdentity)
      expect(replayWorkflowControl(encode([...history, ...nextFacts]))).toEqual(afterCommit)
      expect(() => replayWorkflowControl(encode([
        initialized, rejection, ...committed.slice(0, -1), identityFact,
      ]))).toThrow("terminal")
      expect(() => replayWorkflowControl(encode([
        initialized, rejection, ...committed.slice(0, -1), identityFact, ...nextFacts,
      ]))).toThrow("terminal")
    }
  })

  it("adopts an identity equal to the recorded one on the canonical empty evidence", () => {
    const { initialized, initial } = trace()
    const migration = buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, initial.definitionIdentity, initial.definitionIdentity)
    if (migration.type !== "workflow.definition_identity.migrated") throw new Error("Migration fact type is wrong")

    expect(migration.payload.evidence).toEqual([])
    expect(replayWorkflowControl([initialized, migration])).toEqual({
      ...initial, aggregateSeq: initial.aggregateSeq + 1,
    })
    expect(() => replayWorkflowControl([initialized, {
      ...migration,
      payload: { ...migration.payload, adopted: adopted(initial.definitionIdentity) },
    }])).toThrow("evidence")
  })

  it("adopts every registered chain migration in order and rejects an out-of-order one", () => {
    const { initialized, initial } = trace()
    const first = adopted(initial.definitionIdentity)
    const second = { ...first, vmVersion: "9" }
    const context = buildDefinitionIdentityMigratedFact(
      DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, initial.definitionIdentity, first,
    )
    const unifiedCatalog = buildDefinitionIdentityMigratedFact(
      DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID, first, second,
    )

    expect(replayWorkflowControl([initialized, context, unifiedCatalog])).toEqual({
      ...initial, definitionIdentity: second, aggregateSeq: initial.aggregateSeq + 2,
    })
    const unifiedCatalogOnly = buildDefinitionIdentityMigratedFact(
      DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID, initial.definitionIdentity, second,
    )
    expect(replayWorkflowControl([initialized, unifiedCatalogOnly])).toEqual({
      ...initial, definitionIdentity: second, aggregateSeq: initial.aggregateSeq + 1,
    })
    expect(() => replayWorkflowControl([initialized, unifiedCatalogOnly, context])).toThrow("out-of-order")
  })

  it("rejects a misplaced, repeated, or unproven definition identity migration", () => {
    const { initialized, initial, committed } = trace()
    const identity = initial.definitionIdentity
    const migration = buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, identity, adopted(identity))
    if (migration.type !== "workflow.definition_identity.migrated") throw new Error("Migration fact type is wrong")

    expect(() => foldWorkflowControl(initial, [migration])).toThrow("terminal")
    expect(() => foldWorkflowControl(initial, [migration, ...committed])).toThrow("control fact as a companion")
    expect(() => replayWorkflowControl([buildWorkflowControlInitializedFact(initial), migration]))
      .toThrow("proposal facts in the initialization batch")
    expect(() => replayWorkflowControl([initialized, migration, migration])).toThrow("out-of-order")
    expect(() => replayWorkflowControl([initialized, buildDefinitionIdentityMigratedFact(
      DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
      { ...identity, vmVersion: "9" },
      adopted(identity),
    )])).toThrow("different prior identity")
    expect(() => replayWorkflowControl([initialized, {
      ...migration,
      payload: { ...migration.payload, evidence: [{ component: "version", recorded: "2", current: "3" }] },
    }])).toThrow("evidence")
  })

  it("re-derives map expansion and settlement and rejects a stored group fact that differs", () => {
    const initialized = buildWorkflowControlInitializedFact(compileWorkflowControl(mapWorkflow, resolveWorkflowAgents(mapWorkflow), { skills: mapSkills }))
    if (initialized.type !== "workflow.control.initialized") throw new Error("Expected initialized root")
    const facts: WorkflowSessionFact[] = [initialized]
    let state = initializeWorkflow(initialized.payload.control).state
    const commit = (result: ReturnType<typeof transitionWorkflow>) => {
      if (result.command.kind !== "commit" || !result.state.context.pending) throw new Error("Event did not propose a commit")
      facts.push(...result.command.proposal.facts)
      const acknowledged = transitionWorkflow(result.state, {
        type: "COMMIT_SUCCEEDED",
        proposalId: result.state.context.pending.proposalId,
        aggregateSeq: result.state.context.pending.proposedCommitted.aggregateSeq,
      })
      state = acknowledged.state
      return acknowledged
    }
    const handoffs = [{ summary: "The plan.", items: items("a", "b") }, { summary: "implemented a" }, { summary: "reviewed a" }, { summary: "implemented b" }, { summary: "reviewed b" }]
    for (const handoff of handoffs) {
      const prepared = commit(transitionWorkflow(state, { type: "START" }))
      if (prepared.command.kind !== "prepare_attempt") throw new Error("Start did not prepare an attempt")
      const { attemptId } = prepared.command.attempt
      commit(transitionWorkflow(state, { type: "ATTEMPT_STARTED", attemptId, conversationId: `conversation-${attemptId}` }))
      commit(transitionWorkflow(state, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId: `conversation-${attemptId}`, handoff, reassessment: null } }))
    }
    const committed = state.context.committed
    expect(replayWorkflowControl(facts)).toEqual(committed)
    expect(replayWorkflowControl(facts)).toEqual(replayWorkflowControl(facts))
    const tamper = (type: string, change: (payload: { readonly [key: string]: unknown }) => object) => facts.map((fact) =>
      fact.type === type ? { ...fact, payload: change(fact.payload) } : fact)
    expect(facts.filter(({ type }) => type === "group.expanded" || type === "group.settled").map(({ type }) => type)).toEqual(["group.expanded", "group.settled"])
    expect(() => replayWorkflowControl(tamper("group.expanded", (payload) => ({ ...payload, admittedContext: [] })))).toThrow()
    expect(() => replayWorkflowControl(tamper("group.settled", (payload) => ({ ...payload, inputSha256: "0".repeat(64) })))).toThrow()
    expect(() => replayWorkflowControl(facts.filter(({ type }) => type !== "group.settled"))).toThrow()
  })
})

function stored(fact: WorkflowSessionFact, seq: number): StoredFact {
  return {
    id: `event-${seq}`,
    position: seq + 1,
    seq,
    aggregateId: "session:session",
    sessionId: "session",
    timestamp: 1,
    ...fact,
  }
}

function adopted(identity: DefinitionIdentity): DefinitionIdentity {
  return { ...identity, skills: [{ skillId: "implementation", sha256: "c".repeat(64) }] }
}
