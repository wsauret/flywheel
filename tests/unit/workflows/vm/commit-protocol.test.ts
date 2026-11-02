import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkflowCommitStorageError } from "../../../../src/workflows/vm/commit-host.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { blockedSkills, blockedWorkflow, closedSqliteWriter, SqliteVmDriver } from "./_sqlite-vm-driver.js"
import { asThenChain } from "../../../helpers/control-before-phases.js"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { testSkillRevision } from "../../../helpers/skill-fixtures.js"

const drivers: SqliteVmDriver[] = []

afterEach(() => {
  for (const vm of drivers.splice(0)) vm.close()
})

function driver(options: ConstructorParameters<typeof SqliteVmDriver>[0] = {}): SqliteVmDriver {
  const value = new SqliteVmDriver(options)
  drivers.push(value)
  return value
}


const record = (id: string) => ({ brief: `Do the ${id} work.`, name: id, writes: [] })

/** A workflow whose phase build has the named agents left and right, and
 *  whose phase ship runs after it. */
const phaseWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "sqlite-phases",
  name: "SQLite phases",
  phases: [{ phase: "build", agents: [{ agent: "left", ...record("left") }, { agent: "right", ...record("right") }] }, { phase: "ship", ...record("ship") }],
})

describe("SQLite workflow VM commit protocol", () => {
  it("stores phase containers in the current root and replays their opening and settlement from stored facts", async () => {
    const vm = driver({ workflow: phaseWorkflow, skills: testSkillRevision([]) })
    await vm.initialize()
    const root = vm.events().find(({ type }) => type === "workflow.control.initialized")
    expect(root?.version).toBe(12)
    expect(vm.committed.graph.nodes.map(({ kind }) => kind)).toEqual(["phase", "agent", "agent", "agent"])
    for (let step = 0; step < 2; step += 1) {
      await vm.startAttempt("after")
      await vm.completeAttempt("after")
      expect(replayWorkflowControl(vm.events())).toEqual(vm.committed)
    }
    expect(vm.committed.graph.nodes.map(({ state }) => state._tag)).toEqual(["completed", "completed", "completed", "ready"])
    expect(vm.freshState().context.committed).toEqual(vm.committed)
  })

  it("proposed state is not published before append", async () => {
    const vm = driver()
    await vm.initialize()
    const before = vm.committed
    const beforeQueue = vm.queue()
    const beforeContext = vm.context()
    const attempt = before.attempts[0]
    if (!attempt) throw new Error("Fixture requires an attempt")

    const proposal = vm.propose({ type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: "conversation-work" })

    expect(proposal.state.lifecycle).toBe("awaiting_commit")
    expect(proposal.state.context.pending?.proposedCommitted.attempts[0]?.state._tag).toBe("running")
    expect(vm.committed).toBe(before)
    expect(vm.state.lifecycle).toBe("ready")
    expect(vm.events()).toHaveLength(before.aggregateSeq)
    expect(vm.queue()).toEqual(beforeQueue)
    expect(vm.context()).toEqual(beforeContext)
    expect(vm.handoffs()).toEqual([])
  })

  it("generic storage failure leaves durable rows, folded control, and committed projection unchanged; no failed proposal fact is queryable", async () => {
    const vm = driver()
    await vm.initialize()
    const beforeEvents = vm.events()
    const beforeControl = vm.committed
    const beforeQueue = vm.queue()
    const beforeContext = vm.context()
    const attempt = beforeControl.attempts[0]
    if (!attempt) throw new Error("Fixture requires an attempt")
    const event = { type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: "conversation-work" } as const
    const proposal = vm.propose(event)

    await expect(vm.commitProposal(event, proposal, closedSqliteWriter(vm.root))).rejects.toBeInstanceOf(WorkflowCommitStorageError)

    expect(vm.events()).toEqual(beforeEvents)
    expect(replayWorkflowControl(vm.events())).toEqual(beforeControl)
    expect(vm.committed).toBe(beforeControl)
    expect(vm.queue()).toEqual(beforeQueue)
    expect(vm.context()).toEqual(beforeContext)
    expect(vm.handoffs()).toEqual([])
    expect(vm.state.lifecycle).toBe("ready")
    expect(vm.events().some(({ type }) => type.includes("proposal") || type.includes("failed"))).toBe(false)
  })

  it("launch storage failure leaves the real SQLite aggregate empty", async () => {
    const root = join(tmpdir(), `flywheel-sqlite-vm-launch-failure-${process.pid}-${randomUUID()}`)
    const vm = driver({ root, writer: closedSqliteWriter(root) })

    await expect(vm.initialize()).rejects.toThrow()

    expect(vm.events()).toEqual([])
  })

  it("successful stored-fact replay reproduces committed control", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after")
    await vm.completeAttempt("after")

    expect(replayWorkflowControl(vm.events())).toEqual(vm.committed)
    expect(vm.freshState().context.committed).toEqual(vm.committed)
    expect(vm.freshState().context.pending).toBeNull()
  })

  it("attempt completion commits outcome atomically, then attempt start commits identity before execution", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after")
    const before = vm.committed
    const committed = await vm.completeAttempt("after", { summary: "accepted" })

    const batch = vm.batches.at(-1)
    if (!batch) throw new Error("Completion batch is missing")
    const types = batch.map(({ type }) => type)
    expect(types).toContain("handoff.written")
    expect(types).toContain("handoff.validated")
    expect(types).toContain("context.accumulated")
    // Compile queued the review, so the completion inserts no attempt.
    expect(types).not.toContain("queue.mutated")
    expect(types).toContain("step.status.changed")
    expect(types).toContain("attempt.succeeded")
    expect(types).not.toContain("attempt.started")
    const first = batch[0]
    if (!first) throw new Error("Completion batch is empty")
    expect(batch.map(({ seq }) => seq)).toEqual(
      Array.from({ length: batch.length }, (_, index) => first.seq + index),
    )
    expect(vm.committed.aggregateSeq - before.aggregateSeq).toBe(batch.length)
    expect(vm.committed.attempts[0]?.state._tag).toBe("completed")
    expect(vm.committed.attempts[1]?.state._tag).toBe("pending")
    expect(vm.committed.guardrails.insertsUsed).toBe(0)
    expect(vm.committed.guardrails.attemptMutationsUsed[0]?.used).toBe(0)
    expect(vm.context()?.entries[0]?.handoff).toEqual({ summary: "accepted" })
    expect(vm.handoffs()[0]).toMatchObject({ validationStatus: "passed", content: { summary: "accepted" } })
    expect(vm.queue()?.attempts.map(({ status }) => status)).toEqual(["completed", "pending"])
    expect(committed.command).toMatchObject({
      kind: "prepare_attempt",
      attempt: { definitionId: "review", conversationId: null },
    })
    if (committed.command.kind !== "prepare_attempt") throw new Error("Completion must prepare review")

    const started = await vm.drive({
      type: "ATTEMPT_STARTED",
      attemptId: committed.command.attempt.attemptId,
      conversationId: "conversation-review",
    })
    expect(vm.batches.at(-1)?.map(({ type }) => type)).toEqual([
      "step.status.changed",
      "step.resume_state.recorded",
      "queue.state.changed",
      "queue.tree.node.changed",
      "queue.tree.node.changed",
      "attempt.started",
      "workflow.control.committed",
    ])
    expect(vm.committed.attempts[1]).toMatchObject({ state: { _tag: "running" }, conversationId: "conversation-review" })
    // The frontier is what the last settlement made ready; a start does not
    // recompute it.
    expect(vm.committed.frontier).toEqual(["sqlite-acceptance:node:2"])
    expect(vm.queue()?.attempts.map(({ status }) => status)).toEqual(["completed", "running"])
    expect(started.command).toMatchObject({
      kind: "run_attempts",
      attempts: [{ definitionId: "review", conversationId: "conversation-review" }],
    })
    if (started.command.kind !== "run_attempts") throw new Error("Started review must run")
    expect(started.command.attempts).toHaveLength(1)
  })

  it("failed handoff commits evidence plus a pending retry before retry identity", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after")
    const batchesBefore = vm.batches.length
    const attempt = vm.committed.attempts.find(({ state }) => state._tag === "running")
    if (!attempt) throw new Error("Fixture requires a running attempt")
    const event = {
      type: "ATTEMPT_FAILED",
      failure: {
        attemptId: attempt.id,
        kind: "invalid_handoff",
        reason: "summary is required",
        conversationId: attempt.conversationId,
        content: {},
        issues: [{ path: "summary", message: "summary is required" }],
      },
    } as const

    const failed = await vm.commitProposal(event, vm.propose(event))

    expect(vm.batches).toHaveLength(batchesBefore + 1)
    const batch = vm.batches.at(-1)
    if (!batch) throw new Error("Failure batch is missing")
    expect(batch.map(({ type }) => type)).toEqual([
      "handoff.written",
      "handoff.validated",
      "queue.mutated",
      "step.status.changed",
      "queue.state.changed",
      "queue.tree.node.changed",
      "queue.tree.node.changed",
      "attempt.retry_inserted",
      "workflow.control.committed",
    ])
    const first = batch[0]
    if (!first) throw new Error("Failure batch is empty")
    expect(batch.map(({ seq }) => seq)).toEqual(
      Array.from({ length: batch.length }, (_, index) => first.seq + index),
    )
    expect(vm.handoffs()[0]).toMatchObject({
      content: {},
      validationStatus: "failed",
      validationIssues: [{ path: "summary", message: "summary is required" }],
    })
    expect(vm.committed.attempts.map(({ state }) => state._tag)).toEqual(["failed", "pending", "pending"])
    expect(vm.queue()?.attempts.map(({ status }) => status)).toEqual(["failed", "pending", "pending"])
    expect(failed.command).toMatchObject({ kind: "prepare_attempt", attempt: { conversationId: null } })
    if (failed.command.kind !== "prepare_attempt") throw new Error("Failed handoff must prepare its retry")

    const started = await vm.drive({
      type: "ATTEMPT_STARTED",
      attemptId: failed.command.attempt.attemptId,
      conversationId: "conversation-retry",
    })
    expect(vm.batches.at(-1)?.map(({ type }) => type)).toEqual([
      "step.status.changed",
      "step.resume_state.recorded",
      "queue.state.changed",
      "queue.tree.node.changed",
      "queue.tree.node.changed",
      "attempt.started",
      "workflow.control.committed",
    ])
    expect(started.command).toMatchObject({
      kind: "run_attempts", attempts: [{ conversationId: "conversation-retry" }],
    })
    if (started.command.kind !== "run_attempts") throw new Error("Started retry must run")
    expect(started.command.attempts).toHaveLength(1)
  })

  it("a stored blocked commit replays to its blocker, its addressed report, and the authored reassessment", async () => {
    // A build before blocked retirement chained the reassessment after the
    // work, so the stored block routes to that follow-up.
    const vm = driver({ workflow: blockedWorkflow, skills: blockedSkills, control: asThenChain })
    await vm.initialize()
    await vm.startAttempt("after")
    const blocker = {
      reason: "The acceptance packet names src/missing.ts, which the repository does not contain",
      evidence: "list src/ reports no missing.ts",
    }
    const handoff = {
      outcome: { state: "blocked", ...blocker },
      summary: "Stopped before editing: the file the acceptance packet names is absent.",
    }

    const blocked = await vm.seedStoredBlock(handoff, "reassess")

    const batch = vm.batches.at(-1)
    if (!batch) throw new Error("Blocked batch is missing")
    const types = batch.map(({ type }) => type)
    expect(types.slice(0, 3)).toEqual(["handoff.written", "handoff.validated", "context.accumulated"])
    expect(types).toContain("attempt.blocked")
    expect(types).not.toContain("attempt.succeeded")
    expect(types.at(-1)).toBe("workflow.control.committed")
    const first = batch[0]
    if (!first) throw new Error("Blocked batch is empty")
    expect(batch.map(({ seq }) => seq)).toEqual(
      Array.from({ length: batch.length }, (_, index) => first.seq + index),
    )
    expect(vm.handoffs()[0]).toMatchObject({ validationStatus: "passed", content: handoff })
    const corrective = vm.committed.attempts.find(({ definitionId }) => definitionId === "reassess")
    if (!corrective) throw new Error("The block must insert its corrective attempt")
    expect(vm.context()?.entries[0]).toMatchObject({
      recipientAttemptId: corrective.id,
      writes: [{ id: "blocked_work", lifetime: "transient" }],
      handoff,
    })
    expect(batch.find(({ type }) => type === "attempt.blocked")?.payload).toMatchObject(blocker)
    expect(vm.committed.attempts.map(({ state }) => state._tag)).toEqual(["blocked", "pending"])
    expect(vm.committed.attempts[0]?.handoff).toEqual(handoff)
    expect(vm.queue()?.attempts.map(({ status }) => status)).toEqual(["blocked", "pending"])
    expect(blocked.command).toMatchObject({ kind: "prepare_attempt", attempt: { definitionId: "reassess" } })
    const replayed = vm.freshViews()
    expect(replayed.control).toEqual(vm.committed)
    expect(replayed.context).toEqual(vm.context())
  })

  it("rejects a stored blocked event whose handoff is not blocked work before any fact is written", async () => {
    const vm = driver({ workflow: blockedWorkflow, skills: blockedSkills, control: asThenChain })
    await vm.initialize()
    await vm.startAttempt("after")
    const beforeEvents = vm.events()

    expect(() => vm.propose(vm.blockEvent({
      outcome: { state: "completed" },
      summary: "Claimed the work finished while reporting a block.",
    }, "reassess"))).toThrow()
    expect(() => vm.propose(vm.blockEvent({ outcome: { state: "blocked", reason: "no evidence" } }, "reassess"))).toThrow()

    expect(vm.events()).toEqual(beforeEvents)
  })

  it("stores the full control only at initialization as the workflow grows", async () => {
    const vm = driver()
    await vm.initialize()
    await vm.startAttempt("after")
    const prepared = await vm.completeAttempt("after", { summary: "first" })
    if (prepared.command.kind !== "prepare_attempt") throw new Error("Completion must prepare review")
    const started = await vm.drive({
      type: "ATTEMPT_STARTED",
      attemptId: prepared.command.attempt.attemptId,
      conversationId: "conversation-review",
    })
    expect(started.command.kind).toBe("run_attempts")
    if (started.command.kind !== "run_attempts") throw new Error("Started review must run")
    expect(started.command.attempts).toHaveLength(1)
    await vm.completeAttempt("after", { summary: "second" })

    const events = vm.events()
    const controlPayloads = events.filter(({ payload }) =>
      !!payload && typeof payload === "object" && "control" in payload)
    expect(controlPayloads.map(({ type }) => type)).toEqual(["workflow.control.initialized"])

    const initialized = controlPayloads[0]
    if (!initialized) throw new Error("Initialization control is missing")
    const initializedSize = JSON.stringify(initialized.payload).length
    const commits = events.filter(({ type }) => type === "workflow.control.committed")
    expect(commits).toHaveLength(vm.batches.length - 1)
    expect(commits.length).toBeGreaterThan(2)
    expect(commits.every(({ payload }) => {
      if (!payload || typeof payload !== "object") return false
      return Object.keys(payload).toSorted().join(",") === "event,proposalId"
        && JSON.stringify(payload).length < initializedSize
    })).toBe(true)
  })

  it("launch provenance, workflow.control.initialized, and queue.created commit in one all-or-none batch", async () => {
    const vm = driver()
    await vm.initialize()

    expect(vm.batches).toHaveLength(1)
    const batch = vm.batches[0]
    if (!batch) throw new Error("Initialization batch is missing")
    expect(batch.some(({ type }) => type === "definition.loaded")).toBe(true)
    expect(batch.some(({ type }) => type === "definition.hash_recorded")).toBe(true)
    expect(batch.some(({ type }) => type === "workflow.compiled")).toBe(true)
    expect(batch.filter(({ type }) => type === "workflow.control.initialized")).toHaveLength(1)
    expect(batch.filter(({ type }) => type === "queue.created")).toHaveLength(1)
    expect(batch.map(({ seq }) => seq)).toEqual(Array.from({ length: batch.length }, (_, index) => index))
    expect(vm.committed.aggregateSeq).toBe(batch.length)
    expect(vm.queue()?.attempts[0]?.id).toBe(vm.committed.attempts[0]?.id)
    expect(vm.lineage().compiledWorkflow?.workflowDefinitionId).toBe("sqlite-acceptance")
  })
})
