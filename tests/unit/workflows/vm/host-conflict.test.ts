import { afterEach, describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter } from "../../../../src/infra/event-store-types.js"
import type { WorkflowRuntimeEvent } from "../../../../src/workflows/vm/host-types.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { SqliteVmDriver } from "./_sqlite-vm-driver.js"
import { testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { queuedAttempts } from "../../../../src/workflows/vm/structural-admission.js"
import type { WorkflowEvent } from "../../../../src/workflows/vm/events.js"
import { attemptOf, itemList, mapSkills, mapWorkflow } from "./_map-fixtures.js"

const drivers: SqliteVmDriver[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})


const record = (id: string) => ({ brief: `Do the ${id} work.`, name: id, writes: [] })

/** A workflow whose phase build has the named agents left and right, and
 *  whose phase ship runs after it. */
const phaseWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "sqlite-phases",
  name: "SQLite phases",
  phases: [{ phase: "build", agents: [{ agent: "left", ...record("left") }, { agent: "right", ...record("right") }] }, { phase: "ship", ...record("ship") }],
})

describe("workflow VM host SQLite conflicts", () => {
  it("lets only one of two inserts against the last queue slot commit", async () => {
    // Plan, 47 single-stage branches that the unexpanded map reserves, and the
    // tail queue 49 of the 50 attempts, so one slot remains.
    const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(mapWorkflow)
    const [plan0, implement, , tail0] = encoded.phases
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...encoded,
      phases: [
        { ...plan0, output: { summary: "The plan.", fields: { items: itemList(47) } }, retry: { max: 2 } },
        { ...implement, name: "per-item" },
        tail0,
      ],
    })
    const vm = new SqliteVmDriver({ workflow, skills: mapSkills })
    drivers.push(vm)
    await vm.initialize()
    await vm.startAttempt("after", "conversation-plan")
    expect(queuedAttempts(vm.committed)).toBe(vm.committed.guardrails.maxAttempts - 1)
    const plan = attemptOf("mapped:node:1")
    const tail = attemptOf("mapped:node:3")
    const retry: WorkflowEvent = {
      type: "ATTEMPT_FAILED",
      failure: { attemptId: plan, kind: "handoff", reason: "missing evidence", conversationId: "conversation-plan" },
    }
    const stale = vm.propose(retry)
    expect(stale.state.context.pending?.proposedCommitted.attempts.map(({ id }) => id)).toContain("mapped:node:1:attempt:2")
    // A reassessment takes the last slot first.
    await vm.commitCompeting({
      type: "REASSESSMENT_PROPOSED",
      proposal: {
        proposalId: "take-the-slot", ownerNodeId: "mapped:node:1", reason: "one more check",
        changes: [{ kind: "insert_after", targetAttemptId: tail, afterAttemptId: tail, attemptId: "inserted", forItem: null, reason: "check" }],
      },
    })
    // The stale proposal conflicts. The host proposes the same event again
    // against the winner's control, and that proposal refuses the retry, so
    // the plan step fails. The map and the tail need the plan, so the run
    // fails.
    const replayed = await vm.commitProposal(retry, stale)
    expect(replayed.state.context.pending?.facts.map(({ type }) => type)).toEqual(["attempt.failed", "workflow.failed", "workflow.control.committed"])
    await vm.commitProposal(retry, replayed)

    const events = vm.events()
    const control = replayWorkflowControl(events)
    expect(control.attempts.map(({ id }) => id)).toContain("inserted")
    expect(control.attempts.map(({ id }) => id)).not.toContain("mapped:node:1:attempt:2")
    expect(queuedAttempts(control)).toBe(control.guardrails.maxAttempts)
    expect(events.filter(({ type }) => type === "attempt.failed").map(({ payload }) => payload.reason)).toEqual([
      'missing evidence. Workflow control "retry" rejected insert_after: max attempts (50)',
    ])
    expect(control.status).toBe("failed")
  })

  it("keeps a phase open across a competing pause and resumes inside it", async () => {
    const vm = new SqliteVmDriver({ workflow: phaseWorkflow, skills: testSkillRevision([]) })
    drivers.push(vm)
    await vm.initialize()
    const base = asAsyncEventWriter(vm.store)
    let compete = true
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        if (compete) {
          compete = false
          await vm.commitCompeting({ type: "PAUSE", reason: "concurrent operator" })
        }
        return base.appendBatchGuarded(events)
      },
    }
    const ran: string[] = []
    const host = (startMode: "launch" | "operator_resume", hostWriter: AsyncGuardedEventWriter) => createWorkflowVmHost({
      servedConversations: async () => new Set(),
      requestAddenda: async () => [],
      startMode,
      sessionId: vm.sessionId,
      reader: asAsyncEventReadSurface(vm.store),
      writer: hostWriter,
      ...vm.workflowStores(),
      definitionRevision: vm.definitionRevision,
      workflow: vm.workflow,
      attemptRunner: { run: async (input, active) => {
        ran.push(input.attemptId)
        return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "done" }, reassessment: null }
      } },
      emit: () => {},
      now: () => 100,
    })

    expect(await host("launch", writer).run()).toMatchObject({ kind: "paused", reason: "concurrent operator" })
    expect(ran).toEqual([])
    // The winning pause committed the compiled control: the phase is ready
    // and its children wait for it to open.
    expect(vm.freshViews().control.graph.nodes.map(({ state }) => state._tag)).toEqual(["ready", "pending", "pending", "pending"])
    expect((await host("operator_resume", base).run()).kind).toBe("completed")
    expect(ran).toEqual(["sqlite-phases:node:1:node:1:attempt:1", "sqlite-phases:node:1:node:2:attempt:1", "sqlite-phases:node:2:attempt:1"])
    expect(vm.freshViews().control.graph.nodes.map(({ state }) => state._tag)).toEqual(["completed", "completed", "completed", "completed"])
  })

  it("completes a run whose aggregate holds a workflow-owned request between handoffs", async () => {
    // A workflow-owned auxiliary request, such as the learning review that
    // follows a handoff, records its request facts in the workflow aggregate.
    // The next handoff then commits against an advanced aggregate tail.
    const vm = new SqliteVmDriver({ workflow: phaseWorkflow, skills: testSkillRevision([]) })
    drivers.push(vm)
    await vm.initialize()
    const requestId = "auxiliary-request"
    const auxiliaryFacts = [
      { type: "prompt.assembled", version: 5, actor: "flywheel", payload: { requestId, turn: 1, promptKind: "workflow-agent" } },
      { type: "model.requested", version: 1, actor: "flywheel", payload: { requestId, turn: 1 } },
      { type: "model.response_received", version: 1, actor: "provider", payload: { requestId, turn: 1, outcome: "ok" } },
      { type: "skill.review.completed", version: 1, actor: "agent", payload: { reviewRunId: "review", sessionId: vm.sessionId } },
    ]
    const ran: string[] = []
    const host = createWorkflowVmHost({
      servedConversations: async () => new Set(),
      requestAddenda: async () => [],
      startMode: "launch",
      sessionId: vm.sessionId,
      reader: asAsyncEventReadSurface(vm.store),
      writer: asAsyncEventWriter(vm.store),
      ...vm.workflowStores(),
      definitionRevision: vm.definitionRevision,
      workflow: vm.workflow,
      attemptRunner: { run: async (input, active) => {
        if (ran.length === 1) vm.store.appendBatch(auxiliaryFacts.map((fact) => ({ ...fact, aggregateId: vm.aggregateId, sessionId: vm.sessionId, timestamp: 50 })))
        ran.push(input.attemptId)
        return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "done" }, reassessment: null }
      } },
      emit: () => {},
      now: () => 100,
    })

    const outcome = await host.run()
    expect(outcome.kind, JSON.stringify(outcome)).toBe("completed")
    expect(ran).toHaveLength(3)
    const events = vm.events()
    expect(events.filter(({ type }) => type === "attempt.succeeded")).toHaveLength(3)
    expect(events.some(({ type }) => type === "prompt.assembled")).toBe(true)
    expect(replayWorkflowControl(events)).toMatchObject({ status: "completed", aggregateSeq: events.at(-1)!.seq + 1 })
  })

  it("discards stale companions and catches projections up from the winning batch", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const base = asAsyncEventWriter(vm.store)
    let compete = true
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        if (compete) {
          compete = false
          await vm.commitCompeting({ type: "PAUSE", reason: "concurrent operator" })
        }
        return base.appendBatchGuarded(events)
      },
    }
    let workers = 0
    const emitted: WorkflowRuntimeEvent[] = []
    const host = createWorkflowVmHost({
      servedConversations: async () => new Set(),
      requestAddenda: async () => [],
      startMode: "launch",
      sessionId: vm.sessionId,
      reader: asAsyncEventReadSurface(vm.store),
      writer,
      ...vm.workflowStores(),
      definitionRevision: vm.definitionRevision,
      workflow: vm.workflow,
      attemptRunner: { run: async () => { workers += 1; throw new Error("stale work must not run") } },
      emit: (event) => { emitted.push(event) },
      now: () => 100,
    })

    const result = await host.run()

    expect(result).toMatchObject({ kind: "paused", reason: "concurrent operator" })
    const attemptIds = vm.queue()?.attempts.map(({ id }) => id)
    if (!attemptIds) throw new Error("Fixture requires a projected queue")
    expect(emitted).toEqual([
      { type: "workflow.run.initialized", data: { attemptIds } },
      { type: "workflow.run.paused", data: { reason: "concurrent operator", attemptsCompleted: 0 } },
    ])
    expect(workers).toBe(0)
    expect(vm.events().filter(({ type }) => type === "workflow.paused")).toHaveLength(1)
    expect(vm.events().filter(({ type }) => type === "workflow.control.committed")).toHaveLength(1)
    expect(vm.events().filter(({ type }) => type === "context.accumulated")).toHaveLength(0)
    expect(vm.events().filter(({ type }) => type === "handoff.written")).toHaveLength(0)
    expect(vm.queue()?.attempts.map(({ status }) => status)).toEqual(["pending", "pending"])
  })

  it("recomposes from winner queue and context without duplicating atomic companions", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    await vm.startAttempt("after", "winner-conversation")
    const base = asAsyncEventWriter(vm.store)
    const recomposedBatches: string[][] = []
    let compete = true
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        if (compete) {
          compete = false
          await vm.completeAttempt("after", { summary: "winner work" })
        }
        const result = await base.appendBatchGuarded(events)
        if (result.kind === "stored") recomposedBatches.push(result.events.map(({ type }) => type))
        return result
      },
    }
    const workers: string[] = []
    const host = createWorkflowVmHost({
      servedConversations: async () => new Set(),
      requestAddenda: async () => [],
      startMode: "operator_resume",
      sessionId: vm.sessionId,
      reader: asAsyncEventReadSurface(vm.store),
      writer,
      ...vm.workflowStores(),
      definitionRevision: vm.definitionRevision,
      workflow: vm.workflow,
      conversationId: () => "review-conversation",
      attemptRunner: {
        run: async (input, active) => {
          workers.push(input.definitionId)
          return {
            kind: "success",
            attemptId: input.attemptId,
            conversationId: active.conversationId,
            handoff: { summary: "review work" },
            reassessment: null,
          }
        },
      },
      emit: () => {},
      now: () => 100,
    })

    const result = await host.run()
    if (result.kind === "failed") throw new Error(JSON.stringify(result.failure))
    expect(result.kind).toBe("completed")
    expect(workers).toEqual(["review"])
    expect(vm.queue()?.attempts.map(({ definitionId, status }) => ({ definitionId, status }))).toEqual([
      { definitionId: "work", status: "completed" },
      { definitionId: "review", status: "completed" },
    ])
    expect(vm.context()?.entries.map(({ definitionId }) => definitionId)).toEqual(["work", "review"])
    expect(vm.events().filter(({ type }) => type === "handoff.written")).toHaveLength(2)
    expect(vm.events().filter(({ type }) => type === "handoff.validated")).toHaveLength(2)
    expect(vm.events().filter(({ type }) => type === "context.accumulated")).toHaveLength(2)
    expect(recomposedBatches.length).toBeGreaterThan(0)
    expect(recomposedBatches.every((batch) => batch.at(-1) === "workflow.control.committed")).toBe(true)
    expect(vm.events().at(-1)?.type).toBe("workflow.control.committed")
  })
})
