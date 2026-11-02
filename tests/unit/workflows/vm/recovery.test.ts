import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { createSqliteEventInserter } from "../../../../src/infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../src/infra/sqlite-event-read-surface.js"
import { asAsyncEventReadSurface, type GuardedEventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { commitWorkflowRecovery } from "../../../../src/orchestration/workflow-host/recovery-commit.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { composeWorkflowProposal } from "../../../../src/workflows/vm/proposal-composition.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { recoverWorkflowControl, workflowRecoveryBasis } from "../../../../src/workflows/vm/recovery.js"
import { buildDefinitionIdentityMigratedFact, buildWorkflowControlInitializedFact, buildWorkflowControlRecoveredFact, parseWorkflowSessionFact, type WorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID } from "../../../../src/workflows/vm/definition-identity.js"
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import { testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { createMemoryStore } from "./host-test-support.js"
import { recoveredWorkflowRoot, storedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"

const databases: Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

const findings = { type: "list", description: "The findings.", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } }

/** One phase of one agent with an inline brief. */
const phase = (id: string, extra: { readonly [key: string]: unknown } = {}) => ({ phase: id, brief: `Do the ${id} work.`, name: id, writes: [], ...extra })
const lister = (id: string) => phase(id, { output: { summary: "The findings.", fields: { findings } } })

const skills = testSkillRevision([])
const definitionOf = (phases: readonly unknown[]) => Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ id: "recovery", name: "Recovery", phases })
/** The four phases of the stored history: A completed, B running, C and D
 *  pending. */
const HISTORY_PHASES = ["work", "review", "fix", "check"].map((id) => phase(id))

function initialized(phases: readonly unknown[]) {
  const definition = definitionOf(phases)
  const root = buildWorkflowControlInitializedFact(compileWorkflowControl(definition, resolveWorkflowAgents(definition), { skills }))
  if (root.type !== "workflow.control.initialized") throw new Error("Expected initialized root")
  return root
}

function history() {
  const db = new Database(":memory:")
  databases.push(db)
  const inserter = createSqliteEventInserter(db)
  const reader = createSqliteEventReadSurface(db)
  const append = (facts: readonly WorkflowSessionFact[]) => inserter.insertEventRows(facts.map((fact) => ({
    ...fact, id: crypto.randomUUID(), aggregateId: "workflow:session", sessionId: "session", timestamp: 1,
  })))
  const root = initialized(HISTORY_PHASES)
  append([root])
  const companions = [
    parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }),
    buildContextInputSeededFact("recovery", "Original task"),
  ]
  const commit = (result: ReturnType<typeof transitionWorkflow>) => {
    const composed = composeWorkflowProposal(result, companions)
    if (composed.command.kind !== "commit" || !composed.state.context.pending) throw new Error("Expected proposal")
    append(composed.command.proposal.facts)
    return transitionWorkflow(composed.state, {
      type: "COMMIT_SUCCEEDED", proposalId: composed.command.proposal.proposalId,
      aggregateSeq: composed.state.context.pending.proposedCommitted.aggregateSeq,
    })
  }
  const prepared = commit(transitionWorkflow(initializeWorkflow(root.payload.control).state, { type: "START" }))
  if (prepared.command.kind !== "prepare_attempt") throw new Error("Expected A")
  const a = prepared.command.attempt.attemptId
  const runningA = commit(transitionWorkflow(prepared.state, { type: "ATTEMPT_STARTED", attemptId: a, conversationId: "a" }))
  const finishedA = commit(transitionWorkflow(runningA.state, {
    type: "ATTEMPT_SUCCEEDED",
    outcome: { attemptId: a, conversationId: "a", handoff: { summary: "A is complete" }, reassessment: null },
  }))
  if (finishedA.command.kind !== "prepare_attempt") throw new Error("Expected B")
  const b = finishedA.command.attempt.attemptId
  const runningB = commit(transitionWorkflow(finishedA.state, { type: "ATTEMPT_STARTED", attemptId: b, conversationId: "b" }))
  return { db, reader, append, root, control: runningB.state.context.committed }
}

describe("semantic workflow recovery basis", () => {
  it("awaits async-only recovery evidence and keeps one captured sequence guard across preparation", async () => {
    const { db, reader, append, control } = history()
    db.run("UPDATE event SET payload = 'not-json' WHERE type = 'queue.deleted'")
    const surface = asAsyncEventReadSurface(reader)
    let sequenceReads = 0
    let guarded: readonly GuardedEventStoreAppend[] = []
    let batches = 0
    const result = await commitWorkflowRecovery({
      sessionId: "session", timestamp: new Date(1).toISOString(),
      reader: {
        ...surface,
        aggregateSeq: async (aggregateId) => {
          sequenceReads += 1
          return surface.aggregateSeq(aggregateId)
        },
      },
      writer: {
        ...createMemoryStore([]),
        appendBatchGuarded: async (events) => {
          batches += 1
          guarded = events
          return { kind: "conflict", conflict: {
            aggregateId: "workflow:session", expectedSeq: control.aggregateSeq, actualSeq: reader.aggregateSeq("workflow:session") + 1,
          } }
        },
      },
      runtimeIdentity: async () => ({ version: "test", buildId: "test" }),
      prepare: async (basis) => {
        expect(basis).toEqual(control)
        append([parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} })])
        return { control, resolvedAgents: resolveWorkflowAgents(definitionOf(HISTORY_PHASES)) }
      },
    })
    expect(result).toEqual({ kind: "conflict" })
    expect(sequenceReads).toBe(1)
    expect(batches).toBe(1)
    expect(guarded.map(({ expectedSeq }) => expectedSeq)).toEqual([control.aggregateSeq, ...guarded.slice(1).map(() => undefined)])
    expect(guarded[0]).toMatchObject({ type: "workflow.control.recovered", payload: {
      control: { attempts: control.attempts },
    } })
  })

  it("retains executing control verbatim in current roots without weakening historical v1", () => {
    const { control: captured } = history()
    const control = { ...captured, aggregateSeq: captured.aggregateSeq + 1 }
    const template = recoveredWorkflowRoot(initialized([phase("work")]).payload.control, control.aggregateSeq)
    const root = buildWorkflowControlRecoveredFact({ ...template.payload, control })
    expect(root.version).toBe(12)
    expect(recoverWorkflowControl(storedWorkflowFacts([root], captured.aggregateSeq))).toMatchObject({
      executable: true,
      control,
    })
    expect(workflowRecoveryBasis(storedWorkflowFacts([root], captured.aggregateSeq))).toEqual(control)
    expect(control.attempts.map(({ state }) => state._tag)).toEqual(["completed", "running", "pending", "pending"])
    expect(() => parseWorkflowSessionFact({ ...root, version: 1, payload: { ...root.payload, control: { ...root.payload.control, issues: [], seals: [] } } })).toThrow()
  })

  it.each([
    [phase("work"), phase("review")],
    [{ repeat: { while: "review.findings", max: 3, stuck: true }, phases: [phase("work"), lister("review")] }],
    [{ repeat: { while: "review.findings", max: 3, stuck: true }, phases: [phase("work"), lister("review"), phase("fix")] }],
    [lister("work"), { repeat: { each: "work.findings" }, phases: [phase("review"), phase("fix")] }],
    [phase("work"), { phase: "build", agents: [{ agent: "review", ...phase("review") }, { agent: "fix", ...phase("fix") }] }],
  ])("round-trips compiled pending control in a current root without changing graph or frontier: %j", (...phases) => {
    const control = initialized(phases).payload.control
    const template = recoveredWorkflowRoot(control, 2)
    const root = buildWorkflowControlRecoveredFact({ ...template.payload, control })
    expect(root.version).toBe(12)
    expect(recoverWorkflowControl(storedWorkflowFacts([root]))).toMatchObject({ executable: true, control })
    expect(workflowRecoveryBasis(storedWorkflowFacts([root]))).toEqual(control)
  })

  it.each(["not-json", '{"damaged":true}'])("preserves settled A, running B and pending C/D through damaged companion payload %s", (payload) => {
    const { db, reader, control } = history()
    db.run("UPDATE event SET payload = ? WHERE type IN ('queue.deleted', 'context.input.seeded')", [payload])
    const facts = reader.readTolerant()
    expect(workflowRecoveryBasis(facts)).toEqual(control)
    expect(workflowRecoveryBasis(facts)?.attempts.map(({ state }) => state._tag)).toEqual(["completed", "running", "pending", "pending"])
    // A companion body never decides control, so the run stays executable.
    expect(recoverWorkflowControl(facts)).toMatchObject({ executable: true, control })
  })

  it("preserves sparse stored semantic coordinates and does not renumber a gap inside semantics", () => {
    const { db, reader, control } = history()
    db.run("DELETE FROM event WHERE type = 'queue.deleted'")
    db.run("UPDATE event SET payload = 'not-json' WHERE type = 'context.input.seeded'")
    const facts = reader.readTolerant()
    expect(workflowRecoveryBasis(facts)).toEqual(control)
    expect(facts.map((fact) => "row" in fact ? fact.row.seq : fact.seq)).not.toEqual(facts.map((_, index) => index))
    db.run("DELETE FROM event WHERE type = 'attempt.succeeded'")
    expect(workflowRecoveryBasis(reader.readTolerant())).toBeNull()
  })

  it.each(["workflow.control.committed", "attempt.succeeded"])("refuses corrupt %s instead of rewinding to running A", (type) => {
    const { db, reader } = history()
    db.run("UPDATE event SET payload = 'not-json' WHERE type = ?", [type])
    expect(workflowRecoveryBasis(reader.readTolerant())).toBeNull()
  })

  it.each(['{}', 'not-json'])("refuses an unknown workflow type with stored payload %s", (payload) => {
    const { db, reader, append } = history()
    append([parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} })])
    db.run("UPDATE event SET type = 'workflow.definition_identity.adoptedd', payload = ? WHERE seq = (SELECT MAX(seq) FROM event)", [payload])
    const facts = reader.readTolerant()
    expect(() => replayWorkflowControl(facts)).toThrow()
    expect(workflowRecoveryBasis(facts)).toBeNull()
    expect(recoverWorkflowControl(facts)).toMatchObject({ executable: false })
  })

  it("refuses an unprovable terminal and a trailing semantic suffix, and positions a fact of another family", () => {
    const { reader, append, control } = history()
    const facts = reader.read()
    const terminal = facts.findLast(({ type }) => type === "workflow.control.committed")
    if (!terminal) throw new Error("Expected terminal")
    expect(workflowRecoveryBasis(facts.map((fact) => fact === terminal
      ? { ...fact, payload: { ...fact.payload, proposalId: "unprovable" } } : fact))).toBeNull()
    // A workflow-owned request records facts the workflow layer does not decode.
    expect(workflowRecoveryBasis([...facts, { ...terminal, seq: control.aggregateSeq, type: "prompt.assembled" }]))
      .toEqual({ ...control, aggregateSeq: control.aggregateSeq + 1 })
    append([parseWorkflowSessionFact({ type: "attempt.succeeded", version: 1, actor: "flywheel", payload: { attemptId: "b", evidence: [] } })])
    expect(workflowRecoveryBasis(reader.readTolerant())).toBeNull()
  })

  it("retains identity migrations and rejects repeated migration order after companion damage", () => {
    const { db, reader, append, control } = history()
    const adopted = { ...control.definitionIdentity, vmVersion: "adopted" }
    append([buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, control.definitionIdentity, adopted)])
    db.run("UPDATE event SET payload = 'not-json' WHERE type = 'queue.deleted'")
    expect(workflowRecoveryBasis(reader.readTolerant())).toEqual({ ...control, definitionIdentity: adopted, aggregateSeq: control.aggregateSeq + 1 })
    append([buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, adopted, adopted)])
    expect(workflowRecoveryBasis(reader.readTolerant())).toBeNull()
  })

  it("fences unsupported and corrupt newest roots before decoding their bodies", () => {
    const { db, reader, append, root } = history()
    append([root])
    db.run("UPDATE event SET version = 99 WHERE seq = (SELECT MAX(seq) FROM event)")
    expect(workflowRecoveryBasis(reader.readTolerant())).toBeNull()
    expect(recoverWorkflowControl(reader.readTolerant())).toMatchObject({ reasons: [{ kind: "recognized_newer_version", version: 99 }] })
    db.run("UPDATE event SET version = 2, payload = 'not-json' WHERE seq = (SELECT MAX(seq) FROM event)")
    expect(workflowRecoveryBasis(reader.readTolerant())).toBeNull()
  })

  it("preserves valid raw fixtures but refuses unpositioned companion damage", () => {
    const { reader } = history()
    const raw = reader.read().map(({ type, version, actor, payload }) => ({ type, version, actor, payload }))
    expect(workflowRecoveryBasis(raw)).toEqual(replayWorkflowControl(raw))
    expect(workflowRecoveryBasis(raw.map((fact) => fact.type === "queue.deleted" ? { ...fact, payload: {}, version: 99 } : fact))).toBeNull()
  })
})
